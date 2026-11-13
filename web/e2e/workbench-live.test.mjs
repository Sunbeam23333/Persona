import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, optionsFrom, validateConfig, validateReadiness, startEvidence, validateStart, startedInventory, privatePath, inside, quiet, delegation, testEvidence, returnedReport, linkedChildren, cleanupRun, scopedRequest, TEST_COMMAND } from './workbench-live.mjs';

const env = { PERSONA_LIVE_ORIGIN: 'http://127.0.0.1:18660', PERSONA_LIVE_HUB_CONFIG: '/private/example/state/hub.json',
  PERSONA_LIVE_ROOT: '/private/example/fixtures', PERSONA_LIVE_MACHINE: 'test-machine', PERSONA_LIVE_RUNTIME: 'dsh' };
const options = optionsFrom(env);
const config = { listen: '127.0.0.1:18660', public_url: env.PERSONA_LIVE_ORIGIN, token: 'test-only-credential-value' };

test('default is a read-only check; execution requires its exact switch', () => {
  assert.equal(options.execute, false);
  assert.equal(optionsFrom(env, ['--check']).execute, false);
  assert.equal(optionsFrom(env, ['--execute']).execute, true);
  for (const args of [['execute'], ['--execute', '--check'], ['--help']]) assert.throws(() => optionsFrom(env, args));
});
test('origin refuses remote, DNS loopback, userinfo, paths and credential fragments', () => {
  for (const origin of ['https://example.com:18660', 'http://localhost:18660', 'http://127.0.0.1', 'http://user@127.0.0.1:18660', 'http://127.0.0.1:18660/x', 'http://127.0.0.1:18660/#token=secret']) {
    assert.throws(() => optionsFrom({ ...env, PERSONA_LIVE_ORIGIN: origin }));
  }
});
test('requires explicit paths and exact identifiers', () => {
  for (const patch of [{ PERSONA_LIVE_ROOT: '/' }, { PERSONA_LIVE_ROOT: 'relative' }, { PERSONA_LIVE_HUB_CONFIG: '' }, { PERSONA_LIVE_MACHINE: '' }, { PERSONA_LIVE_RUNTIME: '../dsh' }]) assert.throws(() => optionsFrom({ ...env, ...patch }));
});
test('state and fixture trees cannot overlap; string prefixes are not ancestry', () => {
  validateConfig(options, config);
  assert.equal(inside('/x/state', '/x/state-other'), false);
  assert.equal(inside('/x/state', '/x/state/a'), true);
  for (const root of ['/private/example/state', '/private/example/state/files', '/private/example']) assert.throws(() => validateConfig({ ...options, root }, config));
  assert.throws(() => validateConfig(options, { ...config, listen: ':18660' }));
  assert.throws(() => validateConfig(options, { ...config, public_url: 'http://example.com' }));
});
test('readiness requires an exact assistant-capable DSH socket runtime', () => {
  const machines = { machines: [{ id: options.machine, online: true, kind: 'local' }] };
  const launchers = { launchers: [{ name: 'dsh', agent: 'dsh', source: 'dsh', assistant: true }] };
  const ready = { machine: { id: options.machine }, launcher: 'dsh', ready: true };
  validateReadiness(options, machines, launchers, ready);
  for (const patch of [{ source: 'path' }, { assistant: false }, { agent: 'claude' }, { name: 'other' }]) assert.throws(() => validateReadiness(options, machines, { launchers: [{ ...launchers.launchers[0], ...patch }] }, ready));
  assert.throws(() => validateReadiness(options, machines, launchers, { ...ready, launcher: 'other' }));
});
test('permission and probe endpoints are not implicitly allowed', () => {
  const owned = new Set(['new-session']);
  assert(scopedRequest('GET', '/api/v1/machines', options, owned, false));
  assert(!scopedRequest('GET', '/api/v1/assistant/readiness?probe=1', options, owned, false));
  assert(!scopedRequest('GET', 'http://example.com/', options, owned, false));
  assert(!scopedRequest('POST', '/api/v1/interactions/card/resolve', options, owned, true));
  assert(!scopedRequest('POST', '/api/v1/assistant/conversations', options, owned, false));
  assert(scopedRequest('POST', '/api/v1/assistant/conversations', options, owned, true));
  assert(scopedRequest('POST', `/api/v1/sessions/${options.machine}/new-session/seen`, options, owned, false));
  assert(!scopedRequest('POST', `/api/v1/sessions/${options.machine}/old-session/seen`, options, owned, false));
});
test('delegation must be one exact scoped tool call with a real result', () => {
  const call = { kind: 'tool_use', tool_name: 'mcp__persona__agent_start', tool_use_id: 'call', tool_input: { machine: options.machine, launcher: 'dsh', cwd: '/fixture' } };
  const result = { kind: 'tool_result', tool_use_id: 'call' };
  assert.equal(delegation([call], options, '/fixture'), false);
  assert(delegation([call, result], options, '/fixture'));
  assert.throws(() => delegation([call, call], options, '/fixture'));
  assert.throws(() => delegation([call, result], options, '/elsewhere'));
  assert.throws(() => delegation([{ ...call, tool_input: { ...call.tool_input, secret_env: {} } }], options, '/fixture'));
});
test('test evidence cannot be satisfied by the model final answer or another command', () => {
  const call = { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'test', tool_input: { command: TEST_COMMAND } };
  const result = { kind: 'tool_result', tool_use_id: 'test', text: 'ok 1 - contract-marker\n# pass 1\n# fail 0\n' };
  assert(testEvidence([call, result], 'contract-marker'));
  assert(!testEvidence([{ role: 'assistant', kind: 'text', text: result.text }], 'contract-marker'));
  assert(!testEvidence([call, { ...result, is_error: true }], 'contract-marker'));
  assert(!testEvidence([{ ...call, tool_input: { command: 'echo passed' } }, result], 'contract-marker'));
  assert(!testEvidence([call, { ...result, text: result.text.replace('fail 0', 'fail 1') }], 'contract-marker'));
  assert(!testEvidence([call, result, { ...call, tool_use_id: 'retry' }, { ...result, tool_use_id: 'retry', is_error: true }], 'contract-marker'));
});
test('acceptance explicitly selects TAP and runs that exact test command once', async () => {
  assert.equal(TEST_COMMAND, 'node --test --test-reporter=tap add.test.mjs contract.test.mjs');
  const root = await mkdtemp(join(tmpdir(), 'persona-live-tap-unit-'));
  try {
    await writeFile(join(root, 'add.test.mjs'), "import test from 'node:test'; test('implementation', () => {});\n", { mode: 0o600 });
    await writeFile(join(root, 'contract.test.mjs'), "import test from 'node:test'; test('contract-marker', () => {});\n", { mode: 0o600 });
    // Run an independent CLI, not a child using this suite's internal IPC reporter.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const command = spawnSync(process.execPath, TEST_COMMAND.split(' ').slice(1), { cwd: root, env: childEnv, encoding: 'utf8', timeout: 10_000 });
    assert.equal(command.status, 0);
    const call = { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'actual-test', tool_input: { command: TEST_COMMAND } };
    const result = { kind: 'tool_result', tool_use_id: 'actual-test', text: command.stdout };
    assert(testEvidence([call, result], 'contract-marker'));
    assert(!testEvidence([{ ...call, tool_input: { command: 'node --test add.test.mjs contract.test.mjs' } }, result], 'contract-marker'));
  } finally { await rm(root, { recursive: true }); }
});
test('returned report requires a real completed task notice before the Assistant reply', () => {
  const notice = { role: 'user', kind: 'text', seq: 10, text: 'Child completed: result-unique', injected: { kind: 'task_notice', state: 'done' } };
  const answer = { role: 'assistant', kind: 'text', seq: 11, text: 'Actual child result: result-unique' };
  assert(returnedReport([notice, answer], 'result-unique'));
  assert(!returnedReport([answer], 'result-unique'));
  assert(!returnedReport([{ ...notice, injected: { kind: 'task_notice', state: 'failed' } }, answer], 'result-unique'));
  assert(!returnedReport([notice, { ...answer, seq: 9 }], 'result-unique'));
  assert(!returnedReport([notice, { ...answer, text: 'Working on it' }], 'result-unique'));
});
const childID = 'session-12345678-1234-1234-1234-123456789abc';
const cleanupTask = 'Unique fixture task nonce-123';
const cleanupPrompt = 'Delegate the exact unique fixture task nonce-123';
const cleanupCall = { kind: 'tool_use', tool_name: 'mcp__persona__agent_start', tool_use_id: 'start-child', tool_input: { machine: options.machine, launcher: options.launcher, cwd: '/fixture', prompt: cleanupTask } };
const cleanupReceipt = { kind: 'tool_result', tool_use_id: 'start-child', text: `Started on test-machine in /fixture: session ${childID}, a task of this conversation.` };
const cleanupParent = { session_id: 'parent', machine_id: options.machine, agent: 'dsh', launcher: 'dsh', cwd: '/assistant' };
const cleanupChild = { ...cleanupParent, session_id: childID, cwd: '/fixture' };
test('start receipt omits Agent by contract but requires machine, launcher and Assistant identity', () => {
  const receipt = { session_id: childID, machine_id: options.machine, launcher: options.launcher, assistant: true };
  const start = { status: 200, data: { session: receipt } };
  assert.equal(validateStart(start, options, new Set()), receipt);
  assert.equal(startEvidence(start, options, new Set()).agentPresent, false);
  for (const patch of [{ session_id: 'arbitrary-id' }, { machine_id: 'other' }, { launcher: 'other' }, { assistant: false }]) {
    assert.throws(() => validateStart({ ...start, data: { session: { ...receipt, ...patch } } }, options, new Set()));
  }
  assert.throws(() => validateStart(start, options, new Set([childID])));
  assert.throws(() => validateStart({ ...start, data: { session: receipt, launcher_note: 'fallback' } }, options, new Set()));
});
test('started receipt must be confirmed by exact runtime inventory before browsing or polling the task', () => {
  const receipt = { session_id: childID };
  const session = { ...cleanupChild, assistant: true };
  assert.equal(startedInventory(receipt, [], options, new Set()), undefined);
  assert.equal(startedInventory(receipt, [session], options, new Set()), session);
  for (const patch of [{ agent: undefined }, { agent: 'claude' }, { machine_id: 'other' }, { launcher: 'other' }, { assistant: false }]) {
    assert.throws(() => startedInventory(receipt, [{ ...session, ...patch }], options, new Set()));
  }
  assert.throws(() => startedInventory(receipt, [session], options, new Set([childID])));
});
test('linked child IDs come only from exact scoped delegation receipts', () => {
  assert.deepEqual([...linkedChildren([cleanupCall, cleanupReceipt], options, '/fixture', cleanupTask)], [childID]);
  for (const patch of [{ prompt: 'another task' }, { machine: 'other' }, { launcher: 'other' }, { cwd: '/elsewhere' }]) {
    assert.equal(linkedChildren([{ ...cleanupCall, tool_input: { ...cleanupCall.tool_input, ...patch } }, cleanupReceipt], options, '/fixture', cleanupTask).size, 0);
  }
  assert.equal(linkedChildren([cleanupCall, { ...cleanupReceipt, is_error: true }], options, '/fixture', cleanupTask).size, 0);
  assert.equal(linkedChildren([{ ...cleanupReceipt, kind: 'text', role: 'assistant' }], options, '/fixture', cleanupTask).size, 0);
});
function cleanupFixture(overrides = {}) {
  const stopped = [];
  const reporters = [];
  return { stopped, reporters, args: { options, baseline: new Set(), assistant: cleanupParent, workspace: '/fixture', prompt: cleanupPrompt, task: cleanupTask,
    list: async () => [cleanupParent, cleanupChild], read: async (s) => s.session_id === 'parent' ? [cleanupCall, cleanupReceipt] : [],
    interrupt: async (s) => { stopped.push(s.session_id); }, stopReporter: async (s) => { reporters.push(s.session_id); }, wait: async () => {}, ...overrides } };
}
test('cleanup reconciles children even when the parent was already known before failure', async () => {
  const fixture = cleanupFixture();
  const result = await cleanupRun(fixture.args);
  assert.deepEqual(fixture.stopped, ['parent', childID]);
  assert.deepEqual(fixture.reporters, ['parent']);
  assert.equal(result.childrenInterrupted, 1);
  assert.equal(result.uncertain, false);
});
test('cleanup directly verifies a receipt-linked child missing from inventory', async () => {
  const queried = [];
  const fixture = cleanupFixture({ list: async () => [cleanupParent], readInfo: async (id) => {
    queried.push(id);
    // session.info has no machine_id/launcher/status for a runtime session.
    return { session_id: childID, agent: 'dsh', cwd: '/fixture' };
  } });
  const result = await cleanupRun(fixture.args);
  assert.deepEqual(queried, [childID]);
  assert.deepEqual(fixture.stopped, ['parent', childID]);
  assert.equal(result.childrenInterrupted, 1);
  assert.equal(result.uncertain, false);
});
test('hidden child cleanup refuses mismatched info and noncanonical workspace paths', async () => {
  for (const patch of [{ session_id: 'another' }, { agent: 'claude' }, { agent: undefined },
    { cwd: '/elsewhere' }, { cwd: '/fixture/../fixture' }, { cwd: undefined },
    { launcher: 'other' }, { machine_id: 'other' }]) {
    let queries = 0;
    const fixture = cleanupFixture({ list: async () => [cleanupParent], readInfo: async () => {
      queries++;
      return { ...cleanupChild, ...patch };
    } });
    const result = await cleanupRun(fixture.args);
    assert.deepEqual(fixture.stopped, ['parent']);
    assert.equal(result.uncertain, true);
    assert(queries >= 1 && queries <= 3);
  }
});
test('hidden child lookup requires one successful scoped receipt and never targets baseline IDs', async () => {
  const otherID = 'session-12345678-1234-1234-1234-123456789abd';
  for (const overrides of [
    { baseline: new Set([childID]) },
    { read: async () => [cleanupCall] },
    { read: async () => [cleanupCall, { ...cleanupReceipt, is_error: true }] },
    { read: async () => [{ ...cleanupReceipt, kind: 'text', role: 'assistant' }] },
    { read: async () => [cleanupCall, cleanupReceipt, { ...cleanupReceipt, text: cleanupReceipt.text.replace(childID, otherID) }] },
  ]) {
    let queries = 0;
    const fixture = cleanupFixture({ list: async () => [cleanupParent], readInfo: async () => { queries++; return cleanupChild; }, ...overrides });
    await cleanupRun(fixture.args);
    assert.equal(queries, 0);
    assert.deepEqual(fixture.stopped, ['parent']);
  }
});
test('hidden child info failures are bounded and never authorize an interrupt', async () => {
  for (const readInfo of [async () => { throw new Error('Unavailable'); }, async () => undefined]) {
    let queries = 0;
    const fixture = cleanupFixture({ list: async () => [cleanupParent], readInfo: async (...args) => { queries++; return readInfo(...args); } });
    const result = await cleanupRun(fixture.args);
    assert.deepEqual(fixture.stopped, ['parent']);
    assert.equal(result.uncertain, true);
    assert(queries >= 1 && queries <= 3);
  }
});
test('listed children never require the direct-info cleanup fallback', async () => {
  let queries = 0;
  const fixture = cleanupFixture({ readInfo: async () => { queries++; return cleanupChild; } });
  await cleanupRun(fixture.args);
  assert.equal(queries, 0);
  assert.deepEqual(fixture.stopped, ['parent', childID]);
});
test('inventory failure cannot prevent stopping an already proven parent', async () => {
  for (const list of [async () => { throw new Error('Unavailable'); }, async () => Array.from({ length: 4 }, (_, i) => ({ ...cleanupParent, session_id: `unrelated-${i}` }))]) {
    const fixture = cleanupFixture({ list });
    const result = await cleanupRun(fixture.args);
    assert.deepEqual(fixture.stopped, ['parent']);
    assert.deepEqual(fixture.reporters, ['parent']);
    assert.equal(result.uncertain, true);
  }
});
test('cleanup refreshes after stopping parent and finds a detached child whose receipt is pending', async () => {
  const fixture = cleanupFixture({ read: async (s) => s.session_id === 'parent' ? [cleanupCall] : [{ role: 'user', kind: 'text', text: cleanupTask }] });
  fixture.args.list = async () => fixture.stopped.includes('parent') ? [cleanupParent, cleanupChild] : [cleanupParent];
  const result = await cleanupRun(fixture.args);
  assert.deepEqual(fixture.stopped, ['parent', childID]);
  assert.equal(result.childrenInterrupted, 1);
});
test('cleanup can recover an uncertain start using only the exact new parent prompt', async () => {
  const fixture = cleanupFixture({ assistant: undefined, read: async (s) => s.session_id === 'parent'
    ? [{ role: 'user', kind: 'text', text: cleanupPrompt }, cleanupCall, cleanupReceipt] : [] });
  const result = await cleanupRun(fixture.args);
  assert.deepEqual(fixture.stopped, ['parent', childID]);
  assert.equal(result.uncertain, false);
});
test('same workspace alone never authorizes cleanup of another session', async () => {
  for (const transcript of [[], [{ ...cleanupCall, tool_input: { ...cleanupCall.tool_input, prompt: 'unrelated' } }]]) {
    const fixture = cleanupFixture({ read: async (s) => s.session_id === 'parent' ? transcript : [{ role: 'user', kind: 'text', text: cleanupTask }] });
    await cleanupRun(fixture.args);
    assert.deepEqual(fixture.stopped, ['parent']);
  }
});
test('cleanup never interrupts baseline sessions or a different machine', async () => {
  for (const overrides of [{ baseline: new Set([childID]) }, { list: async () => [cleanupParent, { ...cleanupChild, machine_id: 'other' }] }]) {
    const fixture = cleanupFixture(overrides);
    await cleanupRun(fixture.args);
    assert.deepEqual(fixture.stopped, ['parent']);
  }
});
test('uncertain parent recovery reports uncertainty without broad interrupts', async () => {
  const fixture = cleanupFixture({ assistant: undefined, read: async () => [{ role: 'user', kind: 'text', text: 'unrelated' }] });
  const result = await cleanupRun(fixture.args);
  assert.equal(result.uncertain, true);
  assert.deepEqual(fixture.stopped, []);
});
test('turn completion does not conceal background work or failed startup', () => {
  assert(quiet({ status: 'done' }));
  for (const patch of [{ status: 'working' }, { status: 'offline' }, { starting: true }, { start_error: 'failed' }, { running_subagents: 1 }, { background_count: 1 }, { background: [{}] }, { subagents: [{ running: true }] }]) assert(!quiet({ status: 'idle', ...patch }));
});
test('private paths reject symlinks and broad permissions', async () => {
  // /tmp may itself be a symlink on macOS: resolve it before testing component checks.
  const { realpath } = await import('node:fs/promises');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'persona-live-unit-'));
  try {
    await chmod(root, 0o700);
    await privatePath(root, true);
    const file = join(root, 'config.json');
    await writeFile(file, '{}', { mode: 0o600 });
    await privatePath(file, false);
    await chmod(file, 0o644);
    await assert.rejects(privatePath(file, false));
    await mkdir(join(root, 'target'), { mode: 0o700 });
    await symlink(join(root, 'target'), join(root, 'alias'));
    await assert.rejects(privatePath(join(root, 'alias'), true));
  } finally { await rm(root, { recursive: true }); }
});

test('default check makes only readiness GETs, creates no artifacts, and emits no credential', async () => {
  const { realpath } = await import('node:fs/promises');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'persona-live-check-unit-'));
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    await mkdir(join(root, 'state'), { mode: 0o700 });
    await mkdir(join(root, 'fixtures'), { mode: 0o700 });
    await writeFile(join(root, 'state/hub.json'), JSON.stringify(config), { mode: 0o600 });
    globalThis.fetch = async (url, request) => {
      requests.push({ url, method: request.method });
      assert.equal(request.headers.Authorization, `Bearer ${config.token}`);
      const path = new URL(url).pathname;
      const body = path.endsWith('/machines') ? { machines: [{ id: options.machine, kind: 'local', online: true }] }
        : path.endsWith('/launchers') ? { launchers: [{ name: 'dsh', source: 'dsh', agent: 'dsh', assistant: true }] }
          : { machine: { id: options.machine }, launcher: 'dsh', ready: true };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const result = await run({ ...options, root: join(root, 'fixtures'), config: join(root, 'state/hub.json') });
    assert.equal(result.passed, true);
    assert.equal(requests.length, 3);
    assert(requests.every((r) => r.method === 'GET' && !r.url.includes('probe=')));
    assert.deepEqual(await readdir(join(root, 'fixtures')), []);
    assert(!JSON.stringify(result).includes(config.token));
    assert.equal(result.coverage.genuineModel, false);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true });
  }
});
