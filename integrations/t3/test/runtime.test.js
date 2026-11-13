import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createT3Runtime, statusOf } from '../lib/runtime.js'
import { createCLIRunner, runCLI } from '../lib/cli.js'
import { parseArgs } from '../index.mjs'
import { startFakeNode } from '../../runtime-sdk/testing/fake-node.js'

const thread = { threadId: 'thread-1', title: 'Example', status: 'running', model: 'example', updatedAt: '2026-01-01T00:00:00Z', itemCount: 2 }
const fixture = () => ({ thread, messages: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'answer' }] })

test('read-only capabilities and explicit recent snapshot history', async t => {
  const node = await startFakeNode(t)
  let content = fixture()
  const { runtime, driver } = createT3Runtime({ projects: ['/example'], socketPath: node.path }, {
    run: async args => args[1] === 'list' ? [thread] : content,
  })
  t.after(() => runtime.stop())
  await runtime.start(); await node.ready
  assert.equal(node.hello.caps.send, false)
  assert.equal(node.hello.caps.start, false)
  assert.equal(node.hello.caps.interrupt, false)
  await driver.listSessions()
  const first = await driver.items({ session_id: 't3-thread-1' })
  assert.match(first.items[0].text, /Recent messages only/)
  content = { ...content, messages: [{ role: 'assistant', text: 'changed window' }] }
  assert.notEqual((await driver.items({ session_id: 't3-thread-1' })).history, first.history)
})

test('execution is opt-in, uses stdin, refuses unsupported modes and does not retry failure', async () => {
  const calls = []
  const { driver } = createT3Runtime({ projects: ['/example'], allowExecution: true }, {
    run: async (args, input) => {
      calls.push({ args, input })
      if (args[1] === 'list') return [thread]
      if (args[1] === 'send') throw new Error('uncertain delivery')
      return { threadId: 'thread-2', runId: 'run-1' }
    },
  })
  await driver.listSessions()
  await assert.rejects(driver.start({ cwd: '/example', prompt: 'test', permission_mode: 'plan' }), /project model/)
  await assert.rejects(driver.start({ cwd: '/elsewhere', prompt: 'test' }), /configured T3/)
  await driver.start({ cwd: '/example', prompt: '$(must remain text)\nnext' })
  assert.deepEqual(calls.at(-1), { args: ['thread', 'start', '/example', '-', '--json'], input: '$(must remain text)\nnext' })
  const message = { session_id: 't3-thread-1', text: 'send', client_msg_id: 'message-1' }
  await assert.rejects(driver.send(message), /uncertain/)
  await assert.rejects(driver.send(message), /uncertain/)
  assert.equal(calls.filter(c => c.args[1] === 'send').length, 1)
  assert.equal(driver.interrupt, undefined)
  assert.equal(driver.modes, undefined)
})

test('CLI runs without shell, bounds time, hides diagnostics', async () => {
  let argsSeen
  const fake = () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => child.emit('close', null)
    return child
  }
  const child = fake()
  const result = runCLI('t3', ['thread', 'list', '--project', '/a;not-shell'], {
    spawnProcess: (command, args, options) => {
      argsSeen = { command, args, options }
      setImmediate(() => { child.stdout.write('[]'); child.emit('close', 0) })
      return child
    },
  })
  assert.deepEqual(await result, [])
  assert.equal(argsSeen.options.shell, false)
  assert.equal(argsSeen.args.at(-1), '/a;not-shell')
  await assert.rejects(runCLI('t3', [], { timeoutMs: 10, spawnProcess: fake }), /timed out/)
})

test('validates configuration and upstream output', async () => {
  assert.throws(() => createT3Runtime({ projects: ['relative'] }), /absolute/)
  assert.throws(() => parseArgs(['--project']), /Usage/)
  assert.equal(parseArgs(['--project', '/example']).allowExecution, undefined)
  const { driver } = createT3Runtime({ projects: ['/example'] }, { run: async () => ({}) })
  await assert.rejects(driver.listSessions(), /Invalid T3 list/)
})

test('refresh removes stale control targets and unknown states fail closed', async () => {
  let listed = [thread]
  const { driver } = createT3Runtime({ projects: ['/example'], allowExecution: true }, { run: async () => listed })
  await driver.listSessions()
  listed = []
  await driver.listSessions()
  assert.throws(() => driver.send({ session_id: 't3-thread-1', text: 'hi', client_msg_id: '1' }), /Refresh/)
  assert.equal(statusOf('preparing'), 'working')
  assert.equal(statusOf('waiting'), 'blocked')
  assert.throws(() => statusOf('future-busy-state'), /Unknown/)
})

test('bounded send receipts reject new work instead of evicting deduplication', async () => {
  let sends = 0
  const { driver } = createT3Runtime({ projects: ['/example'], allowExecution: true }, {
    run: async args => args[1] === 'list' ? [thread] : (sends++, { threadId: 'thread-1' }),
  })
  await driver.listSessions()
  for (let i = 0; i < 500; i++) await driver.send({ session_id: 't3-thread-1', text: 'hi', client_msg_id: String(i) })
  assert.throws(() => driver.send({ session_id: 't3-thread-1', text: 'hi', client_msg_id: 'new' }), /capacity/)
  await driver.send({ session_id: 't3-thread-1', text: 'hi', client_msg_id: '0' })
  assert.equal(sends, 500)
})

test('worktree cwd is accurate and a failed refresh disables new writes but retains receipts', async () => {
  let listed = [{ ...thread, worktreePath: '/worktrees/task-1' }]
  let sends = 0
  const { driver } = createT3Runtime({ projects: ['/example'], allowExecution: true }, {
    run: async args => args[1] === 'list' ? listed : (sends++, { threadId: 'thread-1' }),
  })
  const rows = await driver.listSessions()
  assert.equal(rows[0].cwd, '/worktrees/task-1')
  assert.equal(rows[0].space_id, '/example')
  const message = { session_id: 't3-thread-1', text: 'hi', client_msg_id: 'sent' }
  await driver.send(message)
  listed = [{ ...thread, status: 'new_busy_status' }]
  await assert.rejects(driver.listSessions(), /Unknown/)
  assert.throws(() => driver.send({ ...message, client_msg_id: 'new' }), /Refresh/)
  await driver.send(message)
  assert.equal(sends, 1)
  listed = [{ ...thread, worktreePath: '../relative' }]
  await assert.rejects(driver.listSessions(), /worktree/)
  listed = [{ ...thread, status: 'new_busy_status', pendingRequestCount: 1 }]
  await assert.rejects(driver.listSessions(), /Unknown/)
  assert.throws(() => driver.send({ ...message, client_msg_id: 'still-blocked' }), /Refresh/)
})

test('CLI exit 2 means needs_user and owned CLI shutdown escalates without touching the server', async () => {
  const makeChild = () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    return child
  }
  await assert.rejects(runCLI('t3', [], { spawnProcess: () => {
    const child = makeChild()
    setImmediate(() => child.emit('close', 2))
    return child
  } }), error => error.code === 'needs_user')
  const signals = []
  const runner = createCLIRunner('t3', { shutdownGraceMs: 10, spawnProcess: () => {
    const child = makeChild()
    child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null)) }
    return child
  } })
  const pending = runner.run(['thread', 'list'])
  const rejected = assert.rejects(pending, /cancelled/)
  await runner.stop()
  await rejected
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  await assert.rejects(runner.run(['thread', 'start']), /stopped/)
})
