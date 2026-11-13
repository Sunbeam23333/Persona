import test from 'node:test'
import assert from 'node:assert/strict'
import { createCursorRuntime } from '../lib/runtime.js'
import { startFakeNode, until } from '../../runtime-sdk/testing/fake-node.js'

function fakeFactory({ plan = true } = {}) {
  const clients = []
  return { clients, factory(config) {
    const client = { config, calls: [], closed: false,
      async request(method, params) {
        this.calls.push({ method, params })
        if (method === 'initialize') return { protocolVersion: 1, authMethods: [{ id: 'cursor_login' }] }
        if (method === 'authenticate') return {}
        if (method === 'session/new') return { sessionId: `native-${clients.length}`, modes: { currentModeId: 'agent', availableModes: plan ? [{ id: 'agent' }, { id: 'plan' }] : [{ id: 'agent' }] } }
        if (method === 'session/set_mode') return {}
        if (method === 'session/prompt') return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
        throw new Error(`Unexpected ${method}`)
      },
      notify(method, params) { this.calls.push({ method, params }) },
      close() { if (this.closed) return; this.closed = true; this.reject?.(new Error('closed')); config.onClose() },
    }
    clients.push(client)
    return client
  } }
}

test('official ACP lifecycle, plan-before-prompt, streaming, interruption, and capabilities', async t => {
  const node = await startFakeNode(t)
  const fake = fakeFactory()
  const bridge = createCursorRuntime({ socketPath: node.path }, { clientFactory: fake.factory, validateDirectory: async cwd => cwd })
  t.after(() => bridge.stop())
  await bridge.runtime.start(); await node.ready
  assert.equal(node.hello.caps.start, true)
  assert.equal(node.hello.caps.interrupt, true)
  assert.equal(node.hello.caps.assistant, false)
  const started = await bridge.driver.start({ cwd: '/example', prompt: 'hello', permission_mode: 'plan' })
  const session = bridge.sessions.get(started.session.session_id)
  const client = fake.clients[0]
  assert.deepEqual(client.calls.map(call => call.method), ['initialize', 'authenticate', 'session/new', 'session/set_mode', 'session/prompt'])
  client.config.onNotification('session/update', { sessionId: session.nativeId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } })
  client.config.onNotification('session/update', { sessionId: session.nativeId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } } })
  await assert.rejects(bridge.driver.send({ session_id: session.id, text: 'another' }), /working/)
  client.resolve({ stopReason: 'end_turn' })
  await session.turn
  assert.equal(session.items.at(-1).text, 'hello world')
  assert.equal((await bridge.driver.listSessions())[0].status, 'done')
  await bridge.driver.send({ session_id: session.id, text: 'second' })
  await bridge.driver.interrupt({ session_id: session.id })
  assert.equal(client.calls.at(-1).method, 'session/cancel')
  assert.equal(session.controller.signal.aborted, true)
  client.resolve({ stopReason: 'cancelled' }); await session.turn
})

test('no unsupported model/effort, no invented readonly capability, no takeover', async t => {
  const node = await startFakeNode(t)
  const fake = fakeFactory({ plan: false })
  const bridge = createCursorRuntime({ socketPath: node.path }, { clientFactory: fake.factory, validateDirectory: async cwd => cwd })
  try {
    await bridge.runtime.start(); await node.ready
    await assert.rejects(bridge.driver.start({ cwd: '/example', model: 'invented' }), /overrides/)
    assert.equal(fake.clients.length, 0)
    await assert.rejects(bridge.driver.start({ cwd: '/example', permission_mode: 'plan', prompt: 'must not send' }), /advertise plan/)
    assert.equal(fake.clients[0].calls.some(call => call.method === 'session/prompt'), false)
    assert.equal(fake.clients[0].closed, true)
    await assert.rejects(bridge.driver.send({ session_id: 'other-ide-session', text: 'hi' }), /not started/)
  } finally { await bridge.stop() }
})

test('disconnect and shutdown during startup cannot launch later prompts', async t => {
  for (const stage of ['directory', 'initialize', 'authenticate', 'session/new', 'session/set_mode']) {
    for (const shutdown of [false, true]) {
      await t.test(`${stage} ${shutdown ? 'stop' : 'disconnect'}`, async t => {
        const node = await startFakeNode(t)
        const fake = fakeFactory()
        let release, entered
        const waiting = new Promise(resolve => { entered = resolve })
        const barrier = new Promise(resolve => { release = resolve })
        const factory = config => {
          const client = fake.factory(config)
          const request = client.request.bind(client)
          client.request = async (method, params) => {
            if (method === stage) { entered(); await barrier }
            return request(method, params)
          }
          return client
        }
        const bridge = createCursorRuntime({ socketPath: node.path }, { clientFactory: factory,
          validateDirectory: async cwd => { if (stage === 'directory') { entered(); await barrier }; return cwd } })
        t.after(() => bridge.stop())
        await bridge.runtime.start(); await node.ready
        await until('runtime handshake completed', () => node.last('runtime.sessions'))
        const started = bridge.driver.start({ cwd: '/example', prompt: 'must not run', permission_mode: 'plan' })
        const rejected = assert.rejects(started, /disconnect|cancel/i)
        await waiting
        if (shutdown) await bridge.stop()
        else { node.setHub(false); await until('disconnected', () => !bridge.runtime.hubConnected) }
        release()
        await rejected
        assert.equal(bridge.sessions.size, 0)
        assert.equal(fake.clients.some(client => client.calls.some(call => call.method === 'session/prompt')), false)
        assert.equal(fake.clients.every(client => client.closed), true)
      })
    }
  }
})

test('hub disconnect aborts pending approval and cancels the running turn', async t => {
  const node = await startFakeNode(t)
  const fake = fakeFactory()
  const bridge = createCursorRuntime({ socketPath: node.path }, { clientFactory: fake.factory, validateDirectory: async cwd => cwd })
  t.after(() => bridge.stop())
  await bridge.runtime.start(); await node.ready
  const started = await bridge.driver.start({ cwd: '/example', prompt: 'work' })
  const session = bridge.sessions.get(started.session.session_id)
  node.setHub(false)
  await until('cancel on hub disconnect', () => fake.clients[0].calls.some(call => call.method === 'session/cancel'))
  assert.equal(session.controller.signal.aborted, true)
  const response = await fake.clients[0].config.onRequest('session/request_permission', { sessionId: session.nativeId, options: [{ kind: 'allow_once', optionId: 'yes' }] })
  assert.equal(response.outcome.outcome, 'cancelled')
})
