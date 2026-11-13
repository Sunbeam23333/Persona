// Opt-in real Hub + DSH acceptance. No API responses or model replies are mocked.
// Required: PERSONA_LIVE_ORIGIN, PERSONA_LIVE_HUB_CONFIG, PERSONA_LIVE_ROOT,
// PERSONA_LIVE_MACHINE, PERSONA_LIVE_RUNTIME. Optional: PERSONA_LIVE_LAUNCHER,
// PERSONA_LIVE_BROWSER_CHANNEL (default chrome), PERSONA_LIVE_SCREENSHOTS=1.
// The existing private Hub config supplies authentication; never pass a token on
// the command line. Default --check does not pair, create files, or call a model.
// --execute spends model tokens and leaves its isolated fixture/device for review.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, readFile, readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_COMMAND = 'node --test --test-reporter=tap add.test.mjs contract.test.mjs';
const LIMIT_MS = 10 * 60_000;
const MAX_TOOL_CALLS = 40; // Observed safety limit, not a server-side token/step budget.
const DSH_SESSION_ID = /^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (text) => createHash('sha256').update(text).digest('hex');
const idPath = (id) => encodeURIComponent(id);
const sessionPath = (machine, id) => `/api/v1/sessions/${idPath(machine)}/${idPath(id)}`;

export function inside(root, target) {
  const part = relative(root, target);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

export function optionsFrom(env, args = []) {
  assert(args.length <= 1 && (!args[0] || ['--check', '--execute'].includes(args[0])), 'Use --check or --execute');
  const origin = new URL(env.PERSONA_LIVE_ORIGIN || '');
  assert(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname), 'An explicit loopback HTTP origin is required');
  assert(origin.port && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password, 'Use an origin with an explicit port only');
  const config = env.PERSONA_LIVE_HUB_CONFIG;
  const root = env.PERSONA_LIVE_ROOT;
  assert(isAbsolute(config || '') && isAbsolute(root || ''), 'Config and fixture root must be explicit absolute paths');
  assert(resolve(root) !== sep && resolve(root) !== homedir(), 'A dedicated fixture root is required');
  const machine = env.PERSONA_LIVE_MACHINE;
  const runtime = env.PERSONA_LIVE_RUNTIME;
  const launcher = env.PERSONA_LIVE_LAUNCHER || runtime;
  for (const id of [machine, runtime, launcher]) assert(typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id), 'Explicit machine/runtime/launcher identifiers are required');
  return { origin: origin.origin, config: resolve(config), root: resolve(root), machine, runtime, launcher,
    execute: args[0] === '--execute', screenshots: env.PERSONA_LIVE_SCREENSHOTS === '1',
    channel: env.PERSONA_LIVE_BROWSER_CHANNEL || 'chrome' };
}

export async function privatePath(path, directory) {
  const st = await lstat(path);
  assert(!st.isSymbolicLink() && (directory ? st.isDirectory() : st.isFile()), 'Expected a real private file/directory');
  assert(typeof process.getuid === 'function' && st.uid === process.getuid() && !(st.mode & 0o077), 'Private paths must be owned by this user and inaccessible to group/others');
  assert.equal(await realpath(path), path, 'Symlinked path components are not allowed');
  if (!directory) assert(st.size <= 1024 * 1024, 'Private config is unexpectedly large');
  return st;
}

export function validateConfig(options, config) {
  const origin = new URL(options.origin);
  assert.equal(config.listen, origin.host, 'Hub listen address must match the expected loopback origin');
  assert.equal(String(config.public_url || '').replace(/\/$/, ''), options.origin, 'Hub public URL must match the expected loopback origin');
  assert(typeof config.token === 'string' && config.token.length >= 16, 'Private Hub credential is missing');
  const state = dirname(options.config);
  assert(!inside(state, options.root) && !inside(options.root, state), 'Fixture root and Persona state must be separate trees');
}

export function validateReadiness(options, machines, launchers, readiness) {
  const machine = machines.machines?.find((m) => m.id === options.machine);
  assert(machine?.online === true && machine.kind === 'local', 'Expected local machine is not connected');
  const launcher = launchers.launchers?.find((l) => l.name === options.launcher);
  assert(launcher?.source === options.runtime && launcher.agent === 'dsh' && launcher.assistant === true, 'Expected assistant-capable DSH socket runtime is not connected');
  assert(readiness.machine?.id === options.machine && readiness.launcher === options.launcher && readiness.ready === true, 'Main Assistant readiness does not match the expected machine/launcher');
}

export function startEvidence(start, options, baseline) {
  const session = start?.data?.session;
  return { status: Number.isInteger(start?.status) ? start.status : null, hasSession: !!session,
    hasLauncherNote: !!start?.data?.launcher_note, machineMatches: session?.machine_id === options.machine,
    launcherMatches: session?.launcher === options.launcher, assistantFlag: session?.assistant === true,
    agentPresent: typeof session?.agent === 'string' && session.agent !== '', agentMatches: session?.agent === 'dsh',
    validSessionID: typeof session?.session_id === 'string' && DSH_SESSION_ID.test(session.session_id),
    freshSession: !!session?.session_id && !baseline.has(session.session_id) };
}

export function validateStart(start, options, baseline) {
  const proof = startEvidence(start, options, baseline);
  // start.go returns an acknowledgement, not the node's fully decorated session:
  // Agent is intentionally absent there. Confirm that separately from inventory.
  assert(proof.status === 200 && proof.hasSession && !proof.hasLauncherNote && proof.machineMatches &&
    proof.launcherMatches && proof.assistantFlag && proof.validSessionID && proof.freshSession,
  'Start receipt did not confirm the requested session; do not retry blindly');
  return start.data.session;
}

export function startedInventory(receipt, sessions, options, baseline) {
  const session = sessions.find((s) => s.session_id === receipt.session_id);
  if (!session) return undefined;
  assert(session.machine_id === options.machine && session.agent === 'dsh' && session.assistant === true &&
    session.launcher === options.launcher && !baseline.has(session.session_id), 'Started runtime inventory does not match the receipt');
  return session;
}

export function quiet(session) {
  return ['idle', 'done'].includes(session?.status) && session.starting !== true && !session.start_error &&
    !session.background_working && !(session.running_subagents > 0) && !(session.background_count > 0) &&
    !(session.subagents || []).some((s) => s.running) && !(session.background || []).some((s) => s.running !== false);
}

function scopedDelegation(item, options, cwd, task) {
  const input = item.tool_input;
  return item.kind === 'tool_use' && /(?:^|__)agent_start$/.test(item.tool_name || '') &&
    input?.machine === options.machine && input.cwd === cwd && input.launcher === options.launcher &&
    (task === undefined || input.prompt === task) && !input.worktree && !input.secret_env && !input.attachments?.length;
}

export function delegation(items, options, cwd, task) {
  const calls = items.filter((i) => i.kind === 'tool_use' && /(?:^|__)agent_start$/.test(i.tool_name || ''));
  assert(calls.length <= 1, 'Assistant attempted more than one delegation');
  if (!calls.length) return false;
  assert(scopedDelegation(calls[0], options, cwd, task), 'Delegation left the approved machine/runtime/workspace/task');
  return items.some((i) => i.kind === 'tool_result' && i.tool_use_id === calls[0].tool_use_id && i.is_error !== true);
}

export function testEvidence(items, marker) {
  const calls = items.filter((i) => i.kind === 'tool_use' && ['Bash', 'bash'].includes(i.tool_name) && i.tool_input?.command?.trim() === TEST_COMMAND);
  if (calls.length !== 1) return false;
  const call = calls[0];
  return items.some((i) => i.kind === 'tool_result' && i.tool_use_id === call.tool_use_id && i.is_error !== true &&
    typeof i.text === 'string' && i.text.includes(marker) && /(?:^|\n)# fail 0(?:\r?\n|$)/.test(i.text) && /(?:^|\n)# pass [1-9]\d*(?:\r?\n|$)/.test(i.text));
}

export function returnedReport(items, marker) {
  const notice = items.find((i) => i.injected?.kind === 'task_notice' && i.injected.state === 'done' && i.text?.includes(marker));
  return !!notice && items.some((i) => i.role === 'assistant' && i.kind === 'text' && i.seq > notice.seq && i.text?.includes(marker));
}

export function linkedChildren(items, options, cwd, task) {
  const calls = items.filter((i) => scopedDelegation(i, options, cwd, task));
  return new Set(items.filter((i) => i.kind === 'tool_result' && i.is_error !== true && calls.some((c) => c.tool_use_id === i.tool_use_id))
    // This is the server's agent_start receipt (tools.go), not model prose.
    .map((i) => i.text?.match(/\bsession (session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})[,.](?:\s|$)/i)?.[1]).filter(Boolean));
}

export async function cleanupRun({ options, baseline, assistant, workspace, prompt, task, list, read, readInfo, interrupt, stopReporter, wait = delay, now = Date.now }) {
  const report = { parentInterrupted: false, reporterStopped: false, childrenInterrupted: 0, uncertain: false, rounds: 0 };
  const until = now() + 25_000;
  const stopped = new Set();
  const fresh = (s) => s.machine_id === options.machine && s.agent === 'dsh' && !baseline.has(s.session_id) && (!s.launcher || s.launcher === options.launcher);
  let parent = assistant && fresh(assistant) ? assistant : undefined;
  let parentItems = [];
  async function stopParent() {
    if (!parent || now() >= until) return;
    if (!report.parentInterrupted) {
      try { await interrupt(parent); report.parentInterrupted = true; } catch { report.uncertain = true; }
    }
    if (!report.reporterStopped) {
      try { await stopReporter(parent); report.reporterStopped = true; } catch { report.uncertain = true; }
    }
  }
  try {
    // An already proven parent's stop must not depend on inventory availability.
    await stopParent();
    for (let round = 0; round < 3 && now() < until; round++) {
      report.rounds++;
      let sessions = (await list()).filter(fresh);
      assert(sessions.length <= 3, 'Too many fresh sessions to safely reconcile');
      if (!parent) {
        for (const candidate of sessions) {
          if (now() >= until) break;
          const transcript = await read(candidate);
          if (transcript.some((i) => i.role === 'user' && i.kind === 'text' && i.text === prompt)) { parent = candidate; parentItems = transcript; break; }
        }
      }
      // A recovered parent's exact prompt is now proven. Stop it before
      // refreshing children it may have just created.
      await stopParent();
      if (parent && now() < until) {
        parentItems = await read(parent);
        const scoped = parentItems.some((i) => scopedDelegation(i, options, workspace, task));
        const linked = linkedChildren(parentItems, options, workspace, task);
        sessions = (await list()).filter(fresh);
        assert(sessions.length <= 3, 'Too many fresh sessions to safely reconcile');
        for (const candidate of sessions) {
          if (now() >= until) { report.uncertain = true; break; }
          if (!scoped || candidate.session_id === parent.session_id || candidate.cwd !== workspace || stopped.has(candidate.session_id)) continue;
          // During a detached start the receipt may not have returned yet. The
          // exact nonce-bearing task in the new child's real transcript is the
          // alternative proof; a cwd/title match alone is never sufficient.
          const proven = linked.has(candidate.session_id) || (await read(candidate)).some((i) => i.role === 'user' && i.kind === 'text' && i.text?.includes(task));
          if (!proven) { report.uncertain = true; continue; }
          try { await interrupt(candidate); stopped.add(candidate.session_id); report.childrenInterrupted++; }
          catch { report.uncertain = true; }
        }
        // A session-scope filter can hide a child from inventory while its
        // exact start receipt and runtime still exist. Only that receipt's ID
        // may be queried directly, and info is identity evidence, not success.
        if (linked.size > 1) report.uncertain = true;
        if (scoped && linked.size === 1) for (const id of linked) {
          if (id === parent.session_id || baseline.has(id) || stopped.has(id) || sessions.some((s) => s.session_id === id)) continue;
          if (!readInfo || now() >= until) { report.uncertain = true; continue; }
          try {
            const info = await readInfo(id);
            assert(info?.session_id === id && info.agent === 'dsh' && info.cwd === workspace &&
              isAbsolute(workspace) && resolve(workspace) === workspace &&
              (!info.machine_id || info.machine_id === options.machine) && (!info.launcher || info.launcher === options.launcher),
            'Hidden child identity was not confirmed');
            await interrupt({ ...info, machine_id: options.machine });
            stopped.add(id);
            report.childrenInterrupted++;
          } catch { report.uncertain = true; }
        }
      }
      if (round < 2 && now() < until) await wait(500);
    }
    if (!parent || now() >= until) report.uncertain = true;
  } catch { report.uncertain = true; }
  return report;
}

export function scopedRequest(method, raw, options, owned, start) {
  const url = new URL(raw, options.origin);
  if (url.origin !== options.origin || url.username || url.password) return false;
  // Readiness probing is a GET that spends tokens: never permit it implicitly.
  if (url.pathname === '/api/v1/assistant/readiness' && ['1', 'true'].includes(url.searchParams.get('probe'))) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (method !== 'POST') return false;
  if (url.pathname === '/api/v1/auth/tokens') return true;
  if (url.pathname === '/api/v1/assistant/conversations') return start;
  return [...owned].some((id) => url.pathname === `${sessionPath(options.machine, id)}/seen`);
}

function fixtureContent(marker) {
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.mjs';\n` +
    `test(${JSON.stringify(marker)}, () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-4, 4), 0);\n  assert.equal(add(0.5, 0.25), 0.75);\n  assert.throws(() => add('2', 3), TypeError);\n  assert.throws(() => add(Infinity, 3), TypeError);\n});\n`;
}

export async function run(options) {
  const result = { mode: options.execute ? 'execute' : 'check', passed: false, checks: {}, statuses: [],
    blockedRequests: 0, pageErrors: 0, consoleErrors: 0, screenshots: [],
    limits: { wallClockMs: LIMIT_MS, observedToolCalls: MAX_TOOL_CALLS, serverSideModelBudget: false },
    coverage: { genuineModel: false, assistantDelegation: false, commandApproval: false, transcriptReload: false, composerSubmission: false } };
  let phase = 'preflight';
  let failureCode = 'preflight_failed';
  let context, artifact, workspace, config, assistant, child, prompt, task;
  let baseline = new Set();
  let startAttempted = false;
  let startAllowed = false;
  const owned = new Set();
  const observed = new Map();
  const deadline = Date.now() + LIMIT_MS;
  const remaining = () => { assert(Date.now() < deadline, 'Time limit exceeded'); return Math.max(1, deadline - Date.now()); };
  const record = (method, path, status) => {
    const route = new URL(path, options.origin).pathname.replace(/\/sessions\/[^/]+\/[^/]+/, '/sessions/[machine]/[session]')
      .replace(/\/conversations\/[^/]+/, '/conversations/[session]').replace(/\/devices\/[^/]+/, '/devices/[device]');
    if (!result.statuses.some((r) => r.phase === phase && r.method === method && r.path === route && r.status === status)) result.statuses.push({ phase, method, path: route, status });
  };
  async function api(path, body, cleanup = false) {
    const method = body === undefined ? 'GET' : 'POST';
    assert(path.startsWith('/api/v1/'), 'Fixed Hub API paths only');
    const response = await fetch(options.origin + path, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', 'X-Persona-Op-Id': randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(cleanup ? 2000 : Math.min(30_000, remaining())) });
    record(method, path, response.status);
    assert(response.ok, 'Hub API request failed');
    return response.json();
  }
  async function items(session) {
    const response = await api(`${sessionPath(options.machine, session.session_id)}/items?limit=200&lazy_images=1`);
    assert(Array.isArray(response.items) && !response.has_more, 'Acceptance transcript exceeded the bounded page');
    for (const item of response.items) observed.set(`${session.session_id}/${item.id}`, item);
    return response.items;
  }
  try {
    await privatePath(options.config, false);
    await privatePath(options.root, true);
    config = JSON.parse(await readFile(options.config, 'utf8'));
    validateConfig(options, config);
    const [machines, launchers, readiness] = await Promise.all([
      api('/api/v1/machines'), api(`/api/v1/machines/${idPath(options.machine)}/launchers`), api('/api/v1/assistant/readiness'),
    ]);
    validateReadiness(options, machines, launchers, readiness);
    result.checks.expectedLocalRuntime = true;
    if (!options.execute) { result.passed = true; return result; }

    phase = 'fixture';
    failureCode = 'fixture_failed';
    artifact = await mkdtemp(join(options.root, 'workbench-live-'));
    workspace = join(artifact, 'workspace');
    await mkdir(workspace, { mode: 0o700 });
    const marker = `contract-${randomUUID()}`;
    const resultMarker = `result-${randomUUID()}`;
    const contract = fixtureContent(marker);
    await writeFile(join(workspace, 'contract.test.mjs'), contract, { flag: 'wx', mode: 0o600 });
    const instructions = 'Only this disposable directory is in scope. Do not access credentials, other projects, services, or the network. No installs. Preserve contract.test.mjs and AGENTS.md. Create only add.mjs and add.test.mjs, then run the requested node --test command. Do not delegate further.\n';
    await writeFile(join(workspace, 'AGENTS.md'), instructions, { flag: 'wx', mode: 0o600 });
    baseline = new Set((await api(`/api/v1/sessions?machine_id=${idPath(options.machine)}`)).sessions.map((s) => s.session_id));
    task = `Acceptance ${marker}. In ${JSON.stringify(workspace)}, implement export function add(a,b) in add.mjs: finite numbers only; otherwise throw TypeError. Add meaningful node:test tests in add.test.mjs. Preserve contract.test.mjs and AGENTS.md. Create no other files. Run exactly ${JSON.stringify(TEST_COMMAND)} once from that directory and report its actual result. Include ${resultMarker} in your final report only if that test command succeeds. No installs, network, background work, further delegation, git operations, or external messages.`;
    prompt = `Acceptance ${marker}. Delegate exactly ONE task using mcp__persona__agent_start (agent_start), with machine=${JSON.stringify(options.machine)}, launcher=${JSON.stringify(options.launcher)}, cwd=${JSON.stringify(workspace)}, prompt=${JSON.stringify(task)}. Pass that task prompt unchanged. Do not implement it yourself. Do not use DSH subagent/worktree or secret_env. Wait for that agent's completion notice, then report its actual result here, including ${resultMarker} only after the successful result arrives. Only the disposable directory is authorized; do not read credentials, other projects, or send external messages.`;

    phase = 'browser';
    failureCode = 'browser_pairing_failed';
    const { chromium } = createRequire(import.meta.url)('playwright-core');
    const profile = join(artifact, 'browser-profile');
    context = await chromium.launchPersistentContext(profile, { channel: options.channel, headless: true, timeout: Math.min(30_000, remaining()),
      viewport: { width: 1360, height: 900 }, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block',
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript(({ origin }) => { if (location.origin === origin) { localStorage.setItem('persona.language', 'en'); localStorage.setItem('persona.theme', 'light'); } }, { origin: options.origin });
    await context.route('**/*', async (route) => {
      const req = route.request();
      let permitted = scopedRequest(req.method(), req.url(), options, owned, startAllowed);
      if (new URL(req.url()).pathname === '/api/v1/assistant/conversations' && req.method() === 'POST') {
        const body = req.postDataJSON();
        permitted &&= body?.launcher === options.launcher && body.machine_id === options.machine && body.report_tasks === true && body.prompt === prompt && body.main !== true;
      }
      if (!permitted) { result.blockedRequests++; await route.abort('blockedbyclient'); } else await route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => {
      const url = new URL(socket.url());
      if (url.origin !== options.origin.replace(/^http/, 'ws') || url.pathname !== '/api/v1/ws') { result.blockedRequests++; void socket.close(); return; }
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { result.blockedRequests++; return; }
        if (['client_hello', 'ping'].includes(message.type) || (['subscribe', 'unsubscribe', 'seen'].includes(message.type) && message.machine_id === options.machine && owned.has(message.session_id))) server.send(raw);
        else result.blockedRequests++;
      });
      server.onMessage((raw) => { try { if (JSON.parse(raw.toString()).type === 'hello') result.checks.realWebSocket = true; } catch { /* Forward real server payload unchanged. */ } socket.send(raw); });
    });
    const page = context.pages()[0] || await context.newPage();
    page.on('pageerror', () => result.pageErrors++);
    page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors++; });
    context.on('response', (r) => { if (new URL(r.url()).pathname.startsWith('/api/v1/')) record(r.request().method(), r.url(), r.status()); });
    const pair = await api('/api/v1/auth/pair-codes', { web: `${options.origin}/` });
    assert(typeof pair.token === 'string' && pair.token.startsWith('jp_'), 'Pairing code missing');
    await page.goto(`${options.origin}/persona/new#token=${encodeURIComponent(pair.token)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => localStorage.getItem('persona.token')?.startsWith('jd_'));
    assert(!new URL(page.url()).hash, 'Pairing fragment was not removed');
    await page.locator('main').waitFor();

    phase = 'start';
    failureCode = 'start_request_failed';
    // Use the frontend's real HTTP contract in the paired browser. Deliberately
    // not a composer-selector test; no store injection, route fulfillment or mocks.
    startAllowed = true;
    startAttempted = true;
    const start = await page.evaluate(async ({ prompt, launcher, machine, op, timeout }) => {
      const response = await fetch('/api/v1/assistant/conversations', { method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('persona.token')}`, 'Content-Type': 'application/json', 'X-Persona-Op-Id': op },
        body: JSON.stringify({ prompt, launcher, machine_id: machine, report_tasks: true }), signal: AbortSignal.timeout(timeout) });
      return { status: response.status, data: await response.json() };
    }, { prompt, launcher: options.launcher, machine: options.machine, op: randomUUID(), timeout: Math.min(60_000, remaining()) });
    startAllowed = false;
    result.startup = startEvidence(start, options, baseline);
    failureCode = 'start_receipt_mismatch';
    const receipt = validateStart(start, options, baseline);
    phase = 'start_inventory';
    failureCode = 'start_inventory_unconfirmed';
    for (let attempt = 0; attempt < 10; attempt++) {
      const inventory = await api(`/api/v1/sessions?machine_id=${idPath(options.machine)}`);
      assistant = startedInventory(receipt, inventory.sessions, options, baseline);
      if (assistant) break;
      await delay(Math.min(500, remaining()));
    }
    assert(assistant, 'The exact started session is not in runtime inventory');
    result.startup.inventoryConfirmed = true;
    owned.add(assistant.session_id);
    phase = 'start_navigation';
    failureCode = 'start_navigation_failed';
    const assistantURL = `${options.origin}/persona/${idPath(assistant.session_id)}?machine=${idPath(options.machine)}`;
    await page.goto(assistantURL, { waitUntil: 'domcontentloaded' });
    await page.locator('main').getByText(prompt, { exact: false }).first().waitFor();

    phase = 'execution';
    failureCode = 'execution_failed';
    let assistantItems = [], childItems = [];
    while (true) {
      remaining();
      const sessions = (await api(`/api/v1/sessions?machine_id=${idPath(options.machine)}`)).sessions;
      assistant = sessions.find((s) => s.session_id === assistant.session_id) || assistant;
      assistantItems = await items(assistant);
      const delegated = delegation(assistantItems, options, workspace, task);
      const candidates = sessions.filter((s) => !baseline.has(s.session_id) && s.session_id !== assistant.session_id && s.cwd === workspace);
      assert(candidates.length <= 1, 'More than one child was created');
      if (candidates.length) {
        child = candidates[0];
        assert(child.agent === 'dsh' && child.machine_id === options.machine && (!child.launcher || child.launcher === options.launcher), 'Unexpected child runtime');
        owned.add(child.session_id);
        childItems = await items(child);
      }
      const interactions = (await api('/api/v1/interactions')).interactions || [];
      assert(!interactions.some((i) => i.machine_id === options.machine && owned.has(i.session_id)), 'A real interaction needs manual review; no automatic approval is allowed');
      assert([...observed.values()].filter((i) => i.kind === 'tool_use').length <= MAX_TOOL_CALLS, 'Observed tool-call limit exceeded');
      if (delegated && child && linkedChildren(assistantItems, options, workspace, task).has(child.session_id) &&
        testEvidence(childItems, marker) && quiet(child) && quiet(assistant) && returnedReport(assistantItems, resultMarker)) break;
      await delay(Math.min(1000, remaining()));
    }
    result.coverage.genuineModel = result.coverage.assistantDelegation = true;
    result.checks.exactTestToolSucceeded = true;
    result.checks.childResultReturnedToAssistant = true;
    result.toolCalls = [...observed.values()].filter((i) => i.kind === 'tool_use').length;
    phase = 'artifacts';
    failureCode = 'artifact_verification_failed';
    assert.deepEqual((await readdir(workspace)).sort(), ['AGENTS.md', 'add.mjs', 'add.test.mjs', 'contract.test.mjs'], 'Unexpected workspace files');
    result.files = [];
    for (const name of ['AGENTS.md', 'add.mjs', 'add.test.mjs', 'contract.test.mjs']) {
      const path = join(workspace, name);
      remaining();
      const st = await lstat(path);
      assert(st.isFile() && !st.isSymbolicLink() && st.size <= 64 * 1024 && await realpath(path) === path, 'Unexpected task artifact');
      const text = await readFile(path, 'utf8');
      if (name === 'contract.test.mjs') assert.equal(text, contract, 'Contract was modified');
      if (name === 'AGENTS.md') assert.equal(text, instructions, 'Workspace instructions were modified');
      const file = await api(`/api/v1/machines/${idPath(options.machine)}/file?${new URLSearchParams({ cwd: workspace, path: name })}`);
      assert(file.text === text && file.truncated === false && typeof file.revision === 'string', 'Hub file view differs from disk');
      result.files.push({ name, bytes: st.size, sha256: hash(text) });
    }
    phase = 'reload';
    failureCode = 'transcript_reload_failed';
    for (const [label, session, prior] of [['assistant', assistant, assistantItems], ['agent', child, childItems]]) {
      remaining();
      page.setDefaultTimeout(Math.min(15_000, remaining()));
      page.setDefaultNavigationTimeout(Math.min(30_000, remaining()));
      const url = label === 'assistant' ? assistantURL : `${options.origin}/s/${idPath(options.machine)}/${idPath(session.session_id)}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('main').getByText(marker, { exact: false }).first().waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('main').getByText(marker, { exact: false }).first().waitFor();
      const after = await items(session);
      assert(prior.every((item) => after.some((a) => a.id === item.id && a.kind === item.kind)), 'Transcript items changed after reload');
      if (options.screenshots) {
        for (const [size, viewport] of [['desktop', { width: 1360, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
          await page.setViewportSize(viewport);
          const name = `${label}-${size}.png`;
          await page.screenshot({ path: join(artifact, name), fullPage: true, animations: 'disabled', timeout: Math.min(15_000, remaining()) });
          result.screenshots.push(name);
        }
      }
    }
    result.coverage.transcriptReload = true;
    assert(result.checks.realWebSocket && result.pageErrors === 0 && result.blockedRequests === 0, 'Browser acceptance had errors or out-of-scope requests');
    result.passed = true;
  } catch {
    // Never serialize upstream error text, prompts, response bodies or credentials.
    result.failure = { phase, code: failureCode, advice: 'Inspect the private local UI and sanitized API statuses. Do not blindly retry an uncertain start.' };
  } finally {
    startAllowed = false;
    if (!result.passed && config && startAttempted) {
      phase = 'cleanup';
      result.cleanup = await cleanupRun({ options, baseline, workspace, prompt, task,
        assistant: owned.has(assistant?.session_id) ? assistant : undefined,
        list: async () => (await api(`/api/v1/sessions?machine_id=${idPath(options.machine)}`, undefined, true)).sessions,
        read: async (session) => (await api(`${sessionPath(options.machine, session.session_id)}/items?limit=200&lazy_images=1`, undefined, true)).items,
        readInfo: async (id) => {
          const info = await api(`${sessionPath(options.machine, id)}/info`, undefined, true);
          assert(info?.cwd === workspace && await realpath(workspace) === workspace, 'Hidden child workspace was not confirmed');
          return info;
        },
        interrupt: (session) => api(`${sessionPath(options.machine, session.session_id)}/interrupt`, {}, true),
        stopReporter: (session) => api(`/api/v1/assistant/conversations/${idPath(session.session_id)}/stop`, {}, true),
      });
    }
    if (context) await context.close().catch(() => { result.browserCloseFailed = true; result.passed = false; });
    if (artifact) {
      result.privateArtifactNotice = 'Contains an independently paired browser profile and model-generated files. Do not publish this directory. Workspace instructions are not an OS sandbox.';
      await writeFile(join(artifact, 'results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      result.report = join(artifact, 'results.json');
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(optionsFrom(process.env, process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } catch {
    console.error('Workbench acceptance configuration or private artifact validation failed. No credentials are printed.');
    process.exitCode = 1;
  }
}
