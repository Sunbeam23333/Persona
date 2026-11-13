import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { createRuntime, light, page, RpcError, snippet } from '../../runtime-sdk/index.js'
import { AcpClient } from './acp.js'
import { handleInteraction } from './interactions.js'

/** Owns only ACP processes this bridge starts; it never hijacks an IDE's existing Cursor session. */
export function createCursorRuntime(options = {}, dependencies = {}) {
  const sessions = new Map()
  const pendingStarts = new Set()
  const ownedClients = new Set()
  let generation = 0
  let stopping = false
  let stopPromise
  let runtime
  const requireConnection = () => {
    if (stopping || !runtime.hubConnected) throw new RpcError('Persona is disconnected; no new Cursor work can start.', 'disconnected')
  }
  const now = () => new Date().toISOString()
  const clientFactory = dependencies.clientFactory ?? (config => new AcpClient(config))
  const validateDirectory = dependencies.validateDirectory ?? (async directory => {
    const value = await realpath(directory)
    if (!(await stat(value)).isDirectory()) throw new Error('not directory')
    return value
  })
  const row = session => ({ session_id: session.id, title: session.title, cwd: session.cwd,
    status: session.offline ? 'offline' : session.busy ? 'working' : session.hadTurn ? 'done' : 'idle', updated_at: session.updatedAt,
    rev: session.items.length, space_id: session.cwd, space_name: basename(session.cwd),
    last_text: snippet(session.items.findLast(item => item.role === 'assistant' && item.kind === 'text')?.text ?? ''),
    ...(session.model ? { model: session.model } : {}), permission_mode: session.mode === 'plan' ? 'plan' : 'default' })
  function add(session, item) {
    const seq = session.items.length + 1
    const value = { id: String(seq), seq, ts: now(), ...item }
    session.items.push(value); session.updatedAt = now()
    runtime.append(session.id, { items: [light(value)], fromSeq: seq - 1, toSeq: seq, history: session.history })
  }
  function flush(session) {
    if (session.segment?.text) add(session, { role: 'assistant', kind: session.segment.kind, text: session.segment.text })
    session.segment = undefined
    runtime.streamEnd(session.id)
  }
  const get = id => {
    const session = sessions.get(id)
    if (!session) throw new RpcError('This Cursor session was not started by this bridge.', 'not_found')
    return session
  }
  function update(session, method, params) {
    if (method !== 'session/update' || params.sessionId !== session.nativeId) return
    const value = params.update ?? {}
    if (['agent_message_chunk', 'agent_thought_chunk'].includes(value.sessionUpdate)) {
      if (value.content?.type !== 'text' || typeof value.content.text !== 'string') return
      const kind = value.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking'
      if (session.segment?.kind !== kind) { flush(session); session.segment = { kind, text: '' } }
      session.segment.text += value.content.text
      if (kind === 'text') runtime.stream(session.id, session.segment.text)
    } else if (value.sessionUpdate === 'tool_call') {
      flush(session)
      add(session, { role: 'assistant', kind: 'tool_use', tool_name: value.title ?? value.kind ?? 'Cursor tool',
        tool_use_id: value.toolCallId, tool_input: value.rawInput ?? {} })
    } else if (value.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(value.status)) {
      flush(session)
      add(session, { role: 'tool', kind: 'tool_result', tool_use_id: value.toolCallId, is_error: value.status === 'failed',
        text: value.content?.filter(item => item.type === 'content' && item.content?.type === 'text').map(item => item.content.text).join('\n') ?? '' })
    } else if (value.sessionUpdate === 'session_info_update' && typeof value.title === 'string') {
      session.title = value.title; runtime.sessionsChanged(0)
    }
  }
  function begin(session, text) {
    requireConnection()
    if (session.offline) throw new RpcError('Cursor disconnected. Start a new session; this bridge does not restore prior processes.', 'disconnected')
    if (session.busy) throw new RpcError('Cursor is working. Wait or interrupt before sending another message.', 'busy')
    session.busy = true
    session.hadTurn = true
    session.controller = new AbortController()
    add(session, { role: 'user', kind: 'text', text })
    runtime.sessionsChanged(0)
    session.turn = session.client.request('session/prompt', { sessionId: session.nativeId, prompt: [{ type: 'text', text }] }, options.turnTimeoutMs ?? 30 * 60_000)
      .then(result => {
        flush(session)
        if (result?.stopReason && result.stopReason !== 'end_turn') add(session, { role: 'system', kind: 'notice', text: `Cursor stopped: ${result.stopReason}` })
      }).catch(() => {
        flush(session)
        add(session, { role: 'system', kind: 'notice', text: 'Cursor did not finish this turn. Check its authentication or connection before retrying.' })
      }).finally(() => {
        clearTimeout(session.cancelTimer)
        session.controller.abort()
        session.busy = false; runtime.streamEnd(session.id); runtime.sessionsChanged(0)
      })
  }
  function interrupt(session) {
    session.controller?.abort()
    if (!session.busy || session.offline) return
    try { session.client.notify('session/cancel', { sessionId: session.nativeId }) } catch { void session.client.close(); return }
    clearTimeout(session.cancelTimer)
    session.cancelTimer = setTimeout(() => session.client.close(), 5_000)
    session.cancelTimer.unref?.()
  }
  const driver = {
    async listSessions() { return [...sessions.values()].map(row) },
    async items(params) {
      const session = get(params.session_id)
      return page(session.items, params, { history: session.history, toSeq: session.items.length })
    },
    async cursor(id) { const session = get(id); return { history: session.history, to_seq: session.items.length } },
    async item(params) {
      const item = get(params.session_id).items.find(item => item.id === params.item_id)
      if (!item) throw new RpcError('Cursor message not found.', 'not_found')
      return item
    },
    async start(params) {
      if (!isAbsolute(params.cwd ?? '')) throw new RpcError('Choose an absolute project directory.', 'invalid_params')
      if (params.model || params.effort || params.resume ||
        (params.permission_mode && !['default', 'plan'].includes(params.permission_mode))) {
        throw new RpcError('This bridge supports Cursor default or advertised plan mode, not model/effort overrides or session takeover.', 'not_supported')
      }
      requireConnection()
      const startedGeneration = generation
      const assertCurrent = () => {
        requireConnection()
        if (generation !== startedGeneration) throw new RpcError('Cursor startup was cancelled when Persona disconnected.', 'disconnected')
      }
      let cwd
      try { cwd = await validateDirectory(resolve(params.cwd)) }
      catch { throw new RpcError('The Cursor project directory is not available.', 'invalid_params') }
      assertCurrent()
      const session = { id: `cursor-${randomUUID()}`, cwd, title: basename(cwd), history: `cursor:${randomUUID()}`,
        items: [], updatedAt: now(), busy: false, offline: false, mode: 'default', controller: new AbortController() }
      try {
        pendingStarts.add(session)
        session.client = clientFactory({ command: options.command ?? 'agent', args: ['acp'], cwd,
          onNotification: (method, message) => update(session, method, message),
          onRequest: (method, message) => handleInteraction(method, message, { session, signal: session.controller.signal,
            ask: (interaction, args) => runtime.ask(interaction, args) }),
          onClose: () => { session.offline = true; session.controller.abort(); flush(session); runtime.sessionsChanged(0) },
        })
        ownedClients.add(session.client)
        const initialization = await session.client.request('initialize', { protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'persona-cursor', version: '0.1.0' } })
        assertCurrent()
        if (initialization?.protocolVersion !== 1) throw new RpcError('Unsupported Cursor ACP protocol version.', 'not_supported')
        if (initialization.authMethods?.some(method => method.id === 'cursor_login')) {
          await session.client.request('authenticate', { methodId: 'cursor_login' })
          assertCurrent()
        }
        const created = await session.client.request('session/new', { cwd, mcpServers: [] })
        assertCurrent()
        if (typeof created?.sessionId !== 'string' || !created.sessionId) throw new RpcError('Cursor did not return a session id.', 'upstream_response')
        session.nativeId = created.sessionId
        session.model = created.models?.currentModelId
        session.mode = created.modes?.currentModeId ?? 'default'
        if (params.permission_mode === 'plan') {
          if (!created.modes?.availableModes?.some(mode => mode.id === 'plan')) throw new RpcError('This Cursor version does not advertise plan mode.', 'readonly_unsupported')
          await session.client.request('session/set_mode', { sessionId: session.nativeId, modeId: 'plan' })
          assertCurrent()
          session.mode = 'plan'
        }
        sessions.set(session.id, session)
        runtime.sessionsChanged(0)
        if (params.prompt?.trim()) begin(session, params.prompt)
        return { session: row(session) }
      } catch (error) { await session.client?.close(); throw error }
      finally { pendingStarts.delete(session) }
    },
    async send(params) {
      if (params.images?.length) throw new RpcError('This Cursor bridge currently accepts text only.', 'not_supported')
      if (typeof params.text !== 'string' || !params.text.trim()) throw new RpcError('A message is required.', 'invalid_params')
      begin(get(params.session_id), params.text)
    },
    async interrupt(params) { interrupt(get(params.session_id)) },
  }
  runtime = createRuntime(driver, { runtime: options.runtime ?? 'cursor', name: 'Cursor', version: '0.1.0',
    launcher: options.runtime ?? 'cursor', socketPath: options.socketPath, answerFirst: 'phone', readonly: true,
    log: options.log, onHub: connected => {
      if (!connected) {
        generation++
        for (const session of pendingStarts) { session.controller.abort(); void session.client?.close() }
        for (const session of sessions.values()) interrupt(session)
      }
    },
  })
  const sdkStop = runtime.stop.bind(runtime)
  function stop() {
    if (stopPromise) return stopPromise
    stopping = true
    generation++
    for (const session of [...sessions.values(), ...pendingStarts]) { clearTimeout(session.cancelTimer); session.controller.abort() }
    sdkStop()
    stopPromise = Promise.all([...ownedClients].map(client => client.close()))
    return stopPromise
  }
  runtime.stop = stop
  return { runtime, driver, sessions, stop }
}
