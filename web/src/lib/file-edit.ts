// Text editing uses the computer's revision-checked write, never an unconditional upload replacement.
import { api, credentialOwner, enc, getToken, onCredentialChange } from "./api";
import type { FileContent } from "./files";
import { MANAGER_HEADER, shownManager } from "./manager-choice";

export const FILE_TEXT_EDIT_FEATURE = "file_text_edit";
export const MAX_EDIT_BYTES = 1 << 20;

export function editableText(file: FileContent | null): file is FileContent & { text: string; revision: string } {
  return Boolean(file && !file.is_dir && !file.stream && file.data === undefined && !file.truncated && !file.next && !file.offset
    && file.revision && typeof file.text === "string" && !file.text.includes("\0") && file.size <= MAX_EDIT_BYTES
    && new TextEncoder().encode(file.text).length === file.size);
}

export function validEdit(text: string): boolean {
  return !text.includes("\0") && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
    && new TextEncoder().encode(text).length <= MAX_EDIT_BYTES;
}

/** Textareas normalize line endings; preserve an existing CRLF-only document on input. */
export function editLineEndings(text: string, original: string): string {
  return original.includes("\r\n") && !/(?<!\r)\n/.test(original) ? text.replace(/\r?\n/g, "\r\n") : text;
}

export interface FileEditTarget {
  owner: string;
  manager: string;
  mid: string;
  path: string;
  cwd: string;
}

export interface TextDraft { original: string; text: string; revision: string }
const drafts = new Map<string, TextDraft>();
const keyOf = (target: FileEditTarget) => JSON.stringify([target.owner, target.manager, target.mid, target.cwd, target.path]);
function warnUnsaved(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = true; }

function updateUnload() {
  if (typeof window === "undefined") return;
  if (drafts.size) window.addEventListener("beforeunload", warnUnsaved);
  else window.removeEventListener("beforeunload", warnUnsaved);
}

// Drafts never go to browser storage. A new login retires all old-owner source content.
onCredentialChange(() => { drafts.clear(); updateUnload(); });

export function textDraft(target: FileEditTarget): TextDraft | undefined {
  return target.owner === credentialOwner() ? drafts.get(keyOf(target)) : undefined;
}

export function keepTextDraft(target: FileEditTarget, draft: TextDraft | null): void {
  if (target.owner !== credentialOwner()) return;
  if (draft && draft.text !== draft.original) drafts.set(keyOf(target), { ...draft });
  else drafts.delete(keyOf(target));
  updateUnload();
}

export async function saveText(target: FileEditTarget, draft: TextDraft, signal: AbortSignal, current: () => boolean): Promise<string> {
  if (target.owner !== credentialOwner() || target.manager !== shownManager() || !getToken() || signal.aborted || !current()) {
    throw new DOMException("aborted", "AbortError");
  }
  if (!draft.revision || !validEdit(draft.text)) throw new Error("A complete UTF-8 file of at most 1 MiB and its revision are required.");
  const result = await api<{ revision: string }>(`/machines/${enc(target.mid)}/files/text`, {
    method: "POST", json: { path: target.path, cwd: target.cwd, text: draft.text, revision: draft.revision },
    signal, token: getToken(), tokenOwner: target.owner, headers: { [MANAGER_HEADER]: target.manager }, isAuthContextCurrent: current,
  });
  if (signal.aborted || target.owner !== credentialOwner() || target.manager !== shownManager() || !current()) {
    throw new DOMException("aborted", "AbortError");
  }
  if (typeof result?.revision !== "string" || !result.revision) throw new Error("The computer did not confirm the saved revision. Reload the file before trying again.");
  return result.revision;
}
