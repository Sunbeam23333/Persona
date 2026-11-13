// Synthetic DTOs mirror integrations/superagent/ui.go; this verifies the existing real extension renderer,
// not the Go handler or an installed DSH service. No request is allowed to reach a real hub or supervisor.
// Usage: node web/e2e/supervisor-renderer.mjs <loopback-vite-origin> <artifact-directory>
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const [address, artifacts, ...extra] = process.argv.slice(2);
assert.ok(address && artifacts && !extra.length, "Supply a Vite origin and artifact directory");
const base = new URL(address);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Use an owned loopback Vite server");
const output = resolve(artifacts);
await mkdir(output, { recursive: true });
const button = (title, id, confirm) => ({ type: "button", title, action: { id, ...(confirm ? { confirm } : {}) } });
const row = (title, subtitle, id) => ({ type: "row", title, subtitle, ...(id ? { action: { id } } : {}) });
const confirmation = {
  pause: "Pause the supervisor's executor? This does not guarantee cancellation of work already in progress.",
  stop: "Stop this ticket? This is not an undo of changes already made.",
  retry: "Retry this ticket? It may run tools and change the project using the supervisor's existing permissions.",
};
const unavailable = "Cannot read the supervisor. Check the selected computer, local port, and service status. No upstream error details are displayed.";
function view(state, allow, failed) {
  const out = { title: "Task supervisor", state: JSON.stringify(state), refresh_after: failed ? 0 : 30, sections: [] };
  const toolbar = [button("Refresh", "refresh")];
  if (state.id) toolbar.push(button("Back to tickets", "back"));
  if (failed) return { ...out, sections: [{ items: toolbar }, { items: [{ type: "text", text: unavailable }] }] };
  if (state.id) {
    if (allow) toolbar.push(button("Retry ticket", "retry", confirmation.retry), button("Stop ticket", "stop", confirmation.stop));
    return { ...out, sections: [{ items: toolbar }, { items: [
      row("Ticket", "Review the checkout changes before preparing the release"), row("Ticket ID", "ticket-example-1"),
      row("Stage", "Needs a person · Review needed"), row("Assignments", "3"), row("Inputs", "4"),
      row("Undelivered inputs", "0"), row("Created (UTC)", "2026-01-01T10:00:00Z"), row("Updated (UTC)", "2026-01-01T11:00:00Z"),
    ], footer: "Metadata only. Transcripts, prompts, environment variables, account details and raw errors remain on the supervisor computer." }] };
  }
  if (allow) toolbar.push(button("Pause executor", "pause", confirmation.pause));
  return { ...out,
    filter: { name: "filter", title: "Filter", value: state.filter, choices: ["open", "person", "working", "idle", "ended"].map((value, i) => ({ value, title: ["Open", "Needs a person", "Working", "Idle", "Ended"][i] })), action: { id: "filter" } },
    sections: [
      { items: toolbar, footer: allow ? "Controls enabled. Each operation asks for confirmation." : "Read-only. Controls are disabled in settings." },
      { title: "Executor", items: [row("Status", "Active"), row("Running workers", "2"), row("Queued", "1"), row("Worker limit", "4")] },
      { title: "Tickets (3)", items: [row("Review the checkout changes before preparing the release", "Needs a person · Review needed", "open:ticket-example-1"), row("Investigate synthetic checkout test failures", "Working", "open:ticket-example-2"), row("Prepare release notes", "Idle · Queued", "open:ticket-example-3")],
        footer: "New requests and replies enter through the supervisor's configured Feishu/GitHub sources, not this panel. One page shows at most 20 tickets." },
    ],
  };
}
const result = { status: "running", scope: "real extension renderer; synthetic DTOs matching ui.go; no Go/DSH deployment", runs: [] };
const browser = await chromium.launch({ channel: "chrome" });
const deadline = setTimeout(() => { result.status = "timeout"; void browser.close(); }, 240_000);
let step = "start";
try {
  for (const [width, height] of [[1280, 820], [390, 844]]) for (const theme of ["light", "dark"]) {
    const name = `${width}x${height}-${theme}`;
    step = `${name} readonly`;
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce", serviceWorkers: "block" });
    await context.addInitScript(({ theme, width }) => {
      localStorage.setItem("persona.token", "synthetic-supervisor-token"); localStorage.setItem("persona.language", "en");
      localStorage.setItem("persona.theme", theme); localStorage.setItem("persona.text-size", width < 500 ? "large" : "standard");
    }, { theme, width });
    let allow = false, failed = false;
    const controls = [], unexpected = [], errors = [];
    await context.route("**/*", route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
    await context.route("**/api/v1/**", route => {
      const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
      const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/extensions/-/ui") return json({ ui: [{ extension: "dsh-supervisor", extension_name: "Task supervisor", id: "supervisor", placement: "nav_page", title: "Task supervisor", icon: "list" }] });
      if (path === "/extensions/dsh-supervisor/-/ui/supervisor") {
        const body = route.request().postDataJSON();
        const state = body.state ? JSON.parse(body.state) : { filter: "open" };
        const action = body.action ?? "";
        if (action.startsWith("open:")) state.id = action.slice(5);
        else if (action === "back") delete state.id;
        else if (action === "filter") state.filter = body.values.filter;
        else if (["retry", "stop", "pause", "resume"].includes(action)) { assert.equal(allow, true); controls.push({ action, state }); }
        else if (action && action !== "refresh") unexpected.push(action);
        return json({ view: view(state, allow, failed) });
      }
      if (route.request().method() !== "GET") unexpected.push(path);
      return json({ error: "not_found" }, 404);
    });
    await context.routeWebSocket("**/api/v1/ws**", ws => ws.onMessage(message => {
      if (String(message).includes("client_hello")) ws.send(JSON.stringify({ type: "hello", server_version: "example", features: ["extensions", "extension_ui_slots"] }));
      if (String(message).includes("app_ping")) ws.send(JSON.stringify({ type: "pong" }));
    }));
    const page = await context.newPage(); page.on("pageerror", error => errors.push(String(error)));
    const screenshot = async suffix => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await page.screenshot({ path: `${output}/${name}-${suffix}.png` }); };
    await page.goto(new URL("/e2e/supervisor-fixture.html", base).href);
    await page.getByText("Read-only. Controls are disabled in settings.", { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await page.getByRole("button", { name: "Pause executor", exact: true }).count(), 0);
    await screenshot("readonly");
    allow = true; await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText("Controls enabled. Each operation asks for confirmation.", { exact: true }).waitFor();
    await screenshot("dashboard");
    step = `${name} confirmation`;
    await page.getByRole("button", { name: "Pause executor", exact: true }).click();
    const dialog = page.getByRole("dialog"); await dialog.waitFor(); assert.equal(controls.length, 0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" }); assert.equal(controls.length, 0);
    await page.getByText("Review the checkout changes before preparing the release", { exact: true }).click();
    await page.getByRole("button", { name: "Retry ticket", exact: true }).waitFor();
    await screenshot("ticket");
    await page.getByRole("button", { name: "Stop ticket", exact: true }).click();
    await dialog.waitFor(); assert.equal(controls.length, 0);
    await screenshot("confirmation");
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/extensions/dsh-supervisor/-/ui/supervisor") && response.request().postDataJSON().action === "stop"),
      dialog.getByRole("button", { name: "OK", exact: true }).click(),
    ]);
    assert.equal(controls.length, 1); assert.equal(controls[0].state.id, "ticket-example-1");
    step = `${name} unavailable`;
    failed = true; await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText(unavailable, { exact: true }).waitFor(); await screenshot("unavailable");
    assert.equal(await page.getByRole("button", { name: "Stop ticket", exact: true }).count(), 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    const run = { name, errors, controls: controls.length, horizontalOverflow: overflow, checks: ["readonly-controls-hidden", "cancel-does-not-dispatch", "confirmation-before-control", "ticket-target-preserved", "unavailable-controls-hidden"] };
    result.runs.push(run); console.log(JSON.stringify(run)); await context.close();
  }
  result.status = "pass";
} catch (error) { result.status = result.status === "timeout" ? "timeout" : "fail"; result.error = `${step}: ${String(error)}`; }
finally { clearTimeout(deadline); await writeFile(`${output}/results.json`, JSON.stringify(result, null, 2)); await browser.close().catch(() => {}); console.log(`${result.status.toUpperCase()} supervisor renderer acceptance${result.error ? `: ${result.error.split("\n")[0]}` : ""}`); process.exit(result.status === "pass" ? 0 : 1); }
