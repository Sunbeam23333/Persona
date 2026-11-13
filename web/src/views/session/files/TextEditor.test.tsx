// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initI18n, t } from "../../../i18n";
import { credentialOwner, setToken } from "../../../lib/api";
import { textDraft, type FileEditTarget } from "../../../lib/file-edit";
import { shownManager } from "../../../lib/manager-choice";
import { TextEditor } from "./TextEditor";

vi.hoisted(() => { window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia; });
vi.mock("../../../ui/atoms", async (orig) => ({ ...(await orig<typeof import("../../../ui/atoms")>()), toast: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const label = (key: string) => t(`session-files-texteditor.${key}`);
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
let root: Root, host: HTMLDivElement, target: FileEditTarget, login = 0;
const saved = vi.fn();
const done = vi.fn();
const fetcher = vi.fn();
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const button = (key: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label(key))!;
const render = async (revision = "r1") => { await act(async () => root.render(<TextEditor target={target} original="original\n" revision={revision} onDone={done} onSaved={saved} />)); await flush(); };
const type = async (value: string) => {
  const field = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (key: string) => { await act(async () => button(key).click()); await flush(); };

beforeEach(async () => {
  await initI18n("en"); setToken(`editor-fixture-${++login}`);
  target = { owner: credentialOwner(), manager: shownManager(), mid: "machine", path: "/work/a.ts", cwd: "/work" };
  saved.mockReset(); done.mockReset(); fetcher.mockReset(); fetcher.mockResolvedValue(response({ revision: "r2" })); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setToken(""); vi.unstubAllGlobals(); });

it("saves changed text with the read revision, then uses the returned revision", async () => {
  await render(); expect(button("save").disabled).toBe(true);
  await type("changed\n"); await click("save");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ text: "changed\n", revision: "r1" });
  expect(saved).toHaveBeenCalledOnce(); expect(textDraft(target)).toBeUndefined();
  await type("changed twice\n"); await click("save");
  expect(JSON.parse(fetcher.mock.calls[1][1].body).revision).toBe("r2");
});

it.each([403, 409, 500])("retains a draft on a refused or failed save (%i)", async (status) => {
  fetcher.mockResolvedValue(response({ code: status === 409 ? "file_changed" : "internal", error: "synthetic refusal" }, status));
  await render(); await type("keep me"); await click("save");
  expect(host.querySelector("textarea")?.value).toBe("keep me");
  expect(textDraft(target)?.text).toBe("keep me"); expect(saved).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(label(status === 409 ? "conflict" : "save_failed"));
  expect(fetcher).toHaveBeenCalledOnce();
});

it("keeps a draft through navigation without rebasing it onto a newer file revision", async () => {
  await render(); await type("kept draft"); await act(async () => root.render(null));
  expect(dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
  await render("r9"); expect(host.querySelector("textarea")?.value).toBe("kept draft");
  await click("save"); expect(JSON.parse(fetcher.mock.calls[0][1].body).revision).toBe("r1");
});

it("clears source text and draft on an account change, ignoring a late save", async () => {
  let resolve!: (value: Response) => void;
  fetcher.mockImplementation(() => new Promise<Response>((r) => { resolve = r; }));
  await render(); await type("old account draft"); await click("save");
  await act(async () => setToken("new-account-fixture"));
  await act(async () => resolve(response({ revision: "r2" }))); await flush();
  expect(host.querySelector("textarea")).toBeNull(); expect(textDraft(target)).toBeUndefined();
  expect(saved).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("old account draft");
});

it("does not dispatch twice while a save is in flight", async () => {
  let resolve!: (value: Response) => void;
  fetcher.mockImplementation(() => new Promise<Response>((r) => { resolve = r; }));
  await render(); await type("changed"); await click("save"); await click("save");
  expect(fetcher).toHaveBeenCalledOnce(); expect(host.querySelector("textarea")?.readOnly).toBe(true);
  await act(async () => resolve(response({ revision: "r2" }))); await flush();
});
