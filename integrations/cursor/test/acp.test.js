import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { AcpClient } from '../lib/acp.js'

function processDouble() {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => child.emit('close')
  return child
}

test('NDJSON handshake, notifications, reverse requests, and no-shell process arguments', async () => {
  const child = processDouble()
  const sent = []; const notifications = []
  let spawnOptions
  child.stdin.on('data', chunk => sent.push(JSON.parse(chunk.toString())))
  const client = new AcpClient({ cwd: '/example', spawnProcess: (command, args, options) => {
    assert.equal(command, 'agent'); assert.deepEqual(args, ['acp']); spawnOptions = options; return child
  }, onNotification: (...args) => notifications.push(args), onRequest: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const init = client.request('initialize', { protocolVersion: 1 })
  assert.equal(sent[0].jsonrpc, '2.0')
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { protocolVersion: 1 } }) + '\n')
  assert.deepEqual(await init, { protocolVersion: 1 })
  child.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{}}\n')
  assert.equal(notifications[0][0], 'session/update')
  child.stdout.write('{"jsonrpc":"2.0","id":"reverse","method":"session/request_permission","params":{}}\n')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.at(-1).result.outcome.outcome, 'cancelled')
  assert.equal(spawnOptions.shell, false)
  client.close()
})

test('disconnect rejects pending work and malformed protocol terminates', async () => {
  const child = processDouble()
  const client = new AcpClient({ spawnProcess: () => child })
  const pending = client.request('session/prompt', {})
  child.stdout.write('not JSON\n')
  await assert.rejects(pending, /disconnected/)
  assert.equal(client.closed, true)
  await assert.rejects(client.request('session/new', {}), /disconnected/)
})

test('owned ACP shutdown escalates to KILL and waits for a TERM-resistant child', async () => {
  const child = processDouble()
  const signals = []
  child.kill = signal => {
    signals.push(signal)
    if (signal === 'SIGKILL') setImmediate(() => child.emit('close'))
  }
  const client = new AcpClient({ spawnProcess: () => child, shutdownGraceMs: 10 })
  const pending = client.request('session/prompt', {})
  const rejected = assert.rejects(pending, /disconnected/)
  await client.close()
  await rejected
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(client.exited, true)
  await client.close()
  assert.equal(signals.length, 2)
})
