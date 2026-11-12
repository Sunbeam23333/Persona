// Real browser acceptance of FileView + TextEditor, with synthetic files and no connected hub.
// Usage: node web/e2e/file-text-editor.mjs <loopback-vite-origin> <artifact-dir>
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const [address, artifacts, ...extra] = process.argv.slice(2);
assert.ok(address && artifacts && !extra.length, "Supply a Vite origin and artifact directory");
const base = new URL(address);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Use a loopback web server");
const output = resolve(artifacts);
await mkdir(output, { recursive: true });
const original = '// A synthetic file; no real workspace is accessed.\nexport const greeting = "Hello, Persona";\n';
const result = { status: "running", scope: "component browser acceptance; synthetic hub", runs: [] };
const browser = await chromium.launch({ channel: "chrome" });
const deadline = setTimeout(() => { result.status = "timeout"; void browser.close(); }, 300_000);
let step = "start";
try {
  for (const [width, height, large] of [[1280, 820, false], [390, 844, true]]) for (const theme of ["light", "dark"]) {
    const name = `${width}x${height}-${theme}${large ? "-large-text" : ""}`;
    step = `${name} load`;
    const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", colorScheme: theme, reducedMotion: "reduce", serviceWorkers: "block" });
    await context.addInitScript(({ theme, large }) => {
      localStorage.setItem("persona.token", "synthetic-editor-token");
      localStorage.setItem("persona.language", "en");
      localStorage.setItem("persona.theme", theme);
      localStorage.setItem("persona.text-size", large ? "large" : "standard");
    }, { theme, large });
    let disk = original, revision = "example-revision-1";
    const writes = [], unexpected = [], errors = [];
    // Deny all off-origin traffic, including loopback ports other than this owned Vite server.
    await context.route("**/*", (route) => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
    await context.route("**/api/v1/**", (route) => {
      const request = route.request(), path = new URL(request.url()).pathname.replace("/api/v1", "");
      const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/machines/example-computer/file" && request.method() === "GET") return json(200, {
        path: "/workspace/example.ts", name: "example.ts", text: disk, size: Buffer.byteLength(disk), mime: "text/plain", revision,
      });
      if (path === "/machines/example-computer/files/text" && request.method() === "POST") {
        const body = request.postDataJSON(); writes.push(body);
        if (body.revision !== revision) return json(409, { error: "file_changed", code: "file_changed" });
        assert.equal(body.path, "/workspace/example.ts"); assert.equal(body.cwd, "/workspace");
        disk = body.text; revision = `example-revision-${writes.length + 1}`;
        return json(200, { revision });
      }
      if (request.method() !== "GET") unexpected.push({ method: request.method(), path });
      return json(404, { error: "not_found" });
    });
    await context.routeWebSocket("**/api/v1/ws**", (ws) => {
      ws.onMessage((m) => {
        if (String(m).includes("client_hello")) ws.send(JSON.stringify({ type: "hello", server_version: "example", features: ["file_text_edit"] }));
        if (String(m).includes("app_ping")) ws.send(JSON.stringify({ type: "pong" }));
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const screenshot = async (suffix) => { await settle(); await page.screenshot({ path: `${output}/${name}-${suffix}.png` }); };
    await page.goto(new URL("/e2e/file-text-editor.html", base).href);
    const edit = page.getByRole("button", { name: "Edit text", exact: true });
    await edit.waitFor({ timeout: 30_000 });
    await edit.click();
    const input = page.getByRole("textbox", { name: "File contents", exact: true });
    assert.equal(await input.inputValue(), original);
    const saved = `${original}export const saved = true;\n`;
    await input.fill(saved);
    await screenshot("editing");
    step = `${name} save`;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("File saved", { exact: true }).first().waitFor();
    assert.equal(disk, saved); assert.equal(writes.length, 1); assert.equal(writes[0].revision, "example-revision-1");
    await screenshot("saved");

    step = `${name} conflict`;
    disk = `${saved}export const changedElsewhere = true;\n`; revision = "external-revision";
    const draft = `${saved}export const myDraft = true;\n`;
    await input.fill(draft);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("The file changed on the computer", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), draft); assert.equal(writes[1].revision, "example-revision-2");
    assert.ok(disk.includes("changedElsewhere"));
    await screenshot("conflict");

    step = `${name} leave and resume`;
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await edit.waitFor(); await edit.click();
    assert.equal(await input.inputValue(), draft);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("The file changed on the computer", { exact: true }).waitFor();
    assert.equal(writes[2].revision, "example-revision-2", "navigation must not rebase a stale draft");
    step = `${name} cancel and discard`;
    // Existing global toasts sit above mobile sheets. Dismiss the navigation reminder before opening the sheet.
    const notices = page.locator('[aria-live="polite"]').getByRole("button", { name: "Close", exact: true });
    while (await notices.count()) await notices.first().click();
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor(); await screenshot("discard-confirmation");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" }); assert.equal(await input.inputValue(), draft);
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard draft", exact: true }).click();
    await edit.waitFor(); await edit.click(); assert.equal(await input.inputValue(), disk);
    assert.equal(writes.length, 3, "discard must never write the disk");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, "page must fit the narrow viewport");
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    const run = { name, writes: writes.length, errors, horizontalOverflow: overflow, checks: ["save", "revision-conflict-keeps-draft", "navigation-retains-original-revision", "cancel", "discard-without-write"] };
    result.runs.push(run); console.log(JSON.stringify(run)); await context.close();
  }
  result.status = "pass";
} catch (error) { result.status = result.status === "timeout" ? "timeout" : "fail"; result.error = `${step}: ${String(error)}`; }
finally {
  clearTimeout(deadline); await writeFile(`${output}/results.json`, JSON.stringify(result, null, 2));
  await browser.close().catch(() => {});
  console.log(`${result.status.toUpperCase()} synthetic file editor acceptance${result.error ? `: ${result.error.split("\n")[0]}` : ""}`);
  process.exit(result.status === "pass" ? 0 : 1);
}
