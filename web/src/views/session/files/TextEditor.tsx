// An opt-in plain-text editor in Agents' file panel. Drafts survive navigation, not a login change or browser reload.
import { useEffect, useRef, useState } from "react";
import { t } from "../../../i18n";
import { ApiError, credentialOwner, errorText, isAbort, subscribeCredentialOwner } from "../../../lib/api";
import { editLineEndings, keepTextDraft, saveText, textDraft, validEdit, type FileEditTarget, type TextDraft } from "../../../lib/file-edit";
import { onManagerChoice, shownManager } from "../../../lib/manager-choice";
import { Button, Dialog, toast } from "../../../ui/atoms";
import { ErrorDetailsText, ErrorNotice } from "../../../ui/ErrorNotice";

const text = (key: string) => t(`session-files-texteditor.${key}`);

export function TextEditor({ target, original, revision, onDone, onSaved }: {
  target: FileEditTarget; original: string; revision: string; onDone: () => void; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<TextDraft>(() => textDraft(target) ?? { original, text: original, revision });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ conflict: boolean; detail: string } | null>(null);
  const [discard, setDiscard] = useState(false);
  const [saved, setSaved] = useState(false);
  const [retired, setRetired] = useState(false);
  const active = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const dirty = draft.text !== draft.original;
  const valid = validEdit(draft.text);
  const current = () => active.current && target.owner === credentialOwner() && target.manager === shownManager();

  useEffect(() => {
    active.current = true;
    const retire = () => { active.current = false; pending.current?.abort(); };
    const retireView = () => { retire(); setRetired(true); setDraft({ text: "", original: "", revision: "" }); setFailure(null); };
    const offOwner = subscribeCredentialOwner(retireView);
    const offManager = onManagerChoice(() => { if (target.manager !== shownManager()) retireView(); });
    return () => {
      const kept = textDraft(target);
      if (active.current && kept && target.owner === credentialOwner()) toast(text("draft_kept"));
      retire(); offOwner(); offManager();
    };
    // The file viewer remounts the editor for each file, credential and assistant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function edit(value: string) {
    if (!current() || pending.current) return;
    const next = { ...draft, text: editLineEndings(value, draft.original) };
    keepTextDraft(target, next);
    setDraft(next); setSaved(false);
  }

  async function save() {
    if (!current() || pending.current || !dirty || !valid) return;
    const ac = new AbortController();
    pending.current = ac; setSaving(true); setFailure(null); setSaved(false);
    try {
      const nextRevision = await saveText(target, draft, ac.signal, current);
      if (!current()) return;
      const next = { text: draft.text, original: draft.text, revision: nextRevision };
      keepTextDraft(target, null); setDraft(next); setSaved(true); onSaved();
    } catch (error) {
      if (current() && !isAbort(error)) setFailure({ conflict: error instanceof ApiError && error.code === "file_changed", detail: errorText(error) });
    } finally {
      if (pending.current === ac) pending.current = null;
      if (current()) setSaving(false);
    }
  }

  function discardDraft() {
    if (!current() || pending.current) return;
    keepTextDraft(target, null); setDiscard(false); onDone();
  }

  if (retired) return <div role="status" className="p-3 text-sm text-ink-2">{text("retired")}</div>;

  return <div className="flex min-h-0 flex-1 flex-col" data-testid="text-editor">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line p-3">
      <Button tone="primary" busy={saving} disabled={!dirty || !valid} onClick={() => void save()}>{text("save")}</Button>
      <Button disabled={saving} onClick={onDone}>{text("done")}</Button>
      {dirty && <Button tone="quiet" disabled={saving} onClick={() => setDiscard(true)}>{text("discard")}</Button>}
      <span role="status" className="min-w-0 text-xs text-ink-2">{saving ? text("saving") : saved ? text("saved") : dirty ? text("unsaved") : text("plain_text")}</span>
    </div>
    {failure && <ErrorNotice role="alert" className="m-3" message={text(failure.conflict ? "conflict" : "save_failed")}
      description={text("failure_help")} details={<ErrorDetailsText text={failure.detail} />} />}
    {!valid && <p role="alert" className="px-3 py-2 text-sm text-red">{text("invalid")}</p>}
    <textarea aria-label={text("content")} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
      value={draft.text} readOnly={saving} onChange={(event) => edit(event.target.value)}
      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void save(); } }}
      className="min-h-60 min-w-0 flex-1 resize-none bg-inset p-3 font-mono text-sm leading-relaxed text-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" />
    <p className="shrink-0 border-t border-line px-3 py-2 text-xs text-ink-3">{text("draft_hint")}</p>
    <Dialog open={discard} onClose={() => setDiscard(false)} title={text("discard_title")}
      footer={<><Button onClick={() => setDiscard(false)}>{text("cancel")}</Button><Button tone="danger" onClick={discardDraft}>{text("discard")}</Button></>}>
      <p className="text-sm text-ink-2">{text("discard_detail")}</p>
    </Dialog>
  </div>;
}
