// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialOwner, setToken } from "./api";
import { editableText, editLineEndings, keepTextDraft, MAX_EDIT_BYTES, saveText, textDraft, validEdit, type FileEditTarget } from "./file-edit";
import type { FileContent } from "./files";
import { shownManager } from "./manager-choice";

const file = (over: Partial<FileContent> = {}): FileContent => ({ path: "/work/a.ts", name: "a.ts", size: 3, text: "abc", mime: "text/plain", is_dir: false, truncated: false, revision: "r1", ...over });
const target = (): FileEditTarget => ({ owner: credentialOwner(), manager: shownManager(), mid: "machine", path: "/work/a.ts", cwd: "/work" });
let login = 0;
beforeEach(() => { setToken(`fixture-${++login}`); vi.restoreAllMocks(); });

describe("safe text edits", () => {
  it("accepts complete text and empty files with a revision", () => {
    expect(editableText(file())).toBe(true);
    expect(editableText(file({ size: 0, text: "" }))).toBe(true);
  });
  it.each([
    { truncated: true }, { next: 2 }, { offset: 2 }, { revision: "" }, { data: "AA==" }, { stream: true },
    { is_dir: true }, { text: "a\0b" }, { size: MAX_EDIT_BYTES + 1 }, { size: 4 }, { text: undefined },
  ])("refuses an incomplete or unsafe document: %j", (over) => expect(editableText(file(over))).toBe(false));
  it("checks UTF-8 bytes, NUL and invalid surrogate code points", () => {
    expect(validEdit("好".repeat(Math.floor(MAX_EDIT_BYTES / 3)))).toBe(true);
    expect(validEdit("好".repeat(Math.ceil(MAX_EDIT_BYTES / 3)))).toBe(false);
    expect(validEdit("a\0b")).toBe(false);
    expect(validEdit("\uD800")).toBe(false);
    expect(validEdit("😄")).toBe(true);
  });
  it("preserves CRLF, leaving an LF or mixed document alone", () => {
    expect(editLineEndings("new\nline\n", "old\r\nline\r\n")).toBe("new\r\nline\r\n");
    expect(editLineEndings("new\n", "old\n")).toBe("new\n");
  });
  it("keeps drafts scoped to machine, path and assistant and warns on reload", () => {
    const a = target();
    keepTextDraft(a, { text: "draft", original: "abc", revision: "r1" });
    expect(textDraft(a)?.text).toBe("draft");
    expect(textDraft({ ...a, mid: "other" })).toBeUndefined();
    expect(textDraft({ ...a, manager: "other" })).toBeUndefined();
    expect(dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
    keepTextDraft(a, null);
    expect(dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
  });
  it("clears drafts on credential retirement and refuses a stale write", async () => {
    const a = target();
    const draft = { text: "draft", original: "abc", revision: "r1" };
    keepTextDraft(a, draft);
    setToken("different-fixture");
    expect(textDraft(a)).toBeUndefined();
    expect(dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
    await expect(saveText(a, draft, new AbortController().signal, () => true)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("sends the exact revision and accepts only a confirmed saved revision", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ revision: "r2" })));
    const a = target();
    await expect(saveText(a, { original: "abc", text: "xyz", revision: "r1" }, new AbortController().signal, () => true)).resolves.toBe("r2");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toContain("/machines/machine/files/text");
    expect(JSON.parse(String(init?.body))).toEqual({ path: a.path, cwd: a.cwd, text: "xyz", revision: "r1" });
    fetcher.mockResolvedValue(new Response("{}"));
    await expect(saveText(a, { original: "abc", text: "xyz", revision: "r1" }, new AbortController().signal, () => true)).rejects.toThrow("did not confirm");
  });
});
