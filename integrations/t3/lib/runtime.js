import { createHash } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'
import { createRuntime, page, RpcError, snippet } from '../../runtime-sdk/index.js'
import { createCLIRunner } from './cli.js'

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,115}$/
const notice = count => `Recent messages only (up to ${count}). Full history, tool activity, streaming, and approvals remain in T3 Code.`
export const statusOf = status => {
  if (['running', 'working', 'queued', 'starting', 'preparing'].includes(status)) return 'working'
  if (['waiting', 'waiting_for_input', 'waiting_for_approval', 'blocked'].includes(status)) return 'blocked'
  if (['completed', 'done', 'failed', 'cancelled', 'interrupted', 'rolled_back'].includes(status)) return 'done'
  if (status === 'idle') return 'idle'
  throw new RpcError('Unknown T3 thread status. Update the bridge before controlling this thread.', 'upstream_response')
}

/** A deliberately limited view over T3's supported local CLI, not a second T3 session owner. */
export function createT3Runtime(options = {}, dependencies = {}) {
  if (!Array.isArray(options.projects) || !options.projects.length || options.projects.some(p => !isAbsolute(p))) {
    throw new Error('Provide at least one absolute project path already registered in T3 Code.')
  }
  const projects = [...new Set(options.projects.map(p => resolve(p)))]
  const count = options.messages ?? 40
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('messages must be between 1 and 100')
  const runner = createCLIRunner(options.command ?? 't3', dependencies.cliOptions)
  let stopped = false
  const run = (args, input) => {
    if (stopped) return Promise.reject(new RpcError('T3 connector has stopped.', 'cancelled'))
    return (dependencies.run ?? runner.run)(args, input)
  }
  let rows = new Map()
  let controlsFresh = true
  const writes = new Map()
  let rt
  const nativeId = id => {
    if (typeof id !== 'string' || !id.startsWith('t3-') || !idPattern.test(id.slice(3))) {
      throw new RpcError('Invalid T3 session id.', 'invalid_params')
    }
    return id.slice(3)
  }
  const row = (thread, cwd, target = rows) => {
    if (!thread || !idPattern.test(thread.threadId ?? '')) throw new RpcError('Invalid T3 thread response.', 'upstream_response')
    if (thread.worktreePath != null && thread.worktreePath !== '' &&
      (typeof thread.worktreePath !== 'string' || !isAbsolute(thread.worktreePath))) throw new RpcError('Invalid T3 worktree path.', 'upstream_response')
    const mappedStatus = statusOf(thread.status)
    const value = {
      session_id: `t3-${thread.threadId}`, title: thread.title || 'T3 thread', cwd: thread.worktreePath || cwd,
      status: thread.pendingRequestCount > 0 ? 'blocked' : mappedStatus,
      updated_at: thread.updatedAt ?? new Date(0).toISOString(),
      rev: `${thread.updatedAt ?? ''}:${thread.itemCount ?? 0}:${thread.status ?? ''}`,
      space_id: cwd, space_name: basename(cwd), model: thread.model ?? '',
      last_text: notice(count),
    }
    target.set(value.session_id, value)
    return value
  }
  const known = id => {
    const value = rows.get(id)
    if (!value) throw new RpcError('Refresh T3 sessions before opening this thread.', 'not_found')
    return value
  }
  async function snapshot(params) {
    const previous = known(params.session_id)
    const data = await run(['thread', 'show', nativeId(params.session_id), '--messages', String(count), '--json'])
    if (data?.thread?.threadId !== nativeId(params.session_id) || !Array.isArray(data.messages)) {
      throw new RpcError('Invalid T3 message response.', 'upstream_response')
    }
    row(data.thread, previous.space_id)
    const messages = data.messages.slice(-count)
    if (messages.some(m => !['user', 'assistant'].includes(m?.role) || typeof m.text !== 'string')) {
      throw new RpcError('Invalid T3 message response.', 'upstream_response')
    }
    const history = `t3:${createHash('sha256').update(JSON.stringify(messages)).digest('hex')}`
    const items = [{ id: '1', seq: 1, role: 'system', kind: 'notice', text: notice(count) },
      ...messages.map((m, i) => ({ id: String(i + 2), seq: i + 2, role: m.role, kind: 'text', text: m.text }))]
    return { items, history, toSeq: items.length }
  }
  const driver = {
    async listSessions() {
      controlsFresh = false
      const all = []
      const current = new Map()
      for (const project of projects) {
        const threads = await run(['thread', 'list', '--project', project, '--json'])
        if (!Array.isArray(threads)) throw new RpcError('Invalid T3 list response.', 'upstream_response')
        all.push(...threads.map(thread => row(thread, project, current)))
      }
      rows = current
      controlsFresh = true
      return [...new Map(all.map(value => [value.session_id, value])).values()]
    },
    async items(params) {
      const state = await snapshot(params)
      return page(state.items, params, state)
    },
    async cursor(id) {
      const state = await snapshot({ session_id: id })
      return { history: state.history, to_seq: state.toSeq }
    },
  }
  if (options.allowExecution === true) {
    driver.start = async params => {
      if (!projects.includes(resolve(params.cwd ?? ''))) throw new RpcError('Choose an explicitly configured T3 project.', 'invalid_params')
      if ((params.permission_mode && params.permission_mode !== 'default') || params.effort || params.model || params.resume) {
        throw new RpcError('T3 CLI uses the project model and permission defaults. Change them in T3 Code first.', 'not_supported')
      }
      if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new RpcError('A task prompt is required.', 'invalid_params')
      const data = await run(['thread', 'start', resolve(params.cwd), '-', '--json'], params.prompt)
      if (!idPattern.test(data?.threadId ?? '')) throw new RpcError('T3 start result was unclear. Check T3 before retrying.', 'delivery_uncertain')
      const value = row({ ...data, title: snippet(params.prompt), status: 'running', updatedAt: new Date().toISOString() }, resolve(params.cwd))
      rt.sessionsChanged(0)
      return { session: value }
    }
    driver.send = params => {
      if (params.images?.length) throw new RpcError('T3 CLI bridge supports text only.', 'not_supported')
      if (typeof params.text !== 'string' || !params.text.trim()) throw new RpcError('A message is required.', 'invalid_params')
      if (!params.client_msg_id) throw new RpcError('A stable message id is required for T3 sends.', 'invalid_params')
      const key = `${params.session_id}:${params.client_msg_id}`
      if (writes.has(key)) return writes.get(key)
      if (!controlsFresh) throw new RpcError('Refresh T3 sessions successfully before sending. The previous snapshot is not authoritative.', 'upstream_response')
      known(params.session_id)
      if (writes.size >= 500) throw new RpcError('T3 send receipt capacity reached. Inspect outstanding work before restarting this bridge.', 'capacity')
      // Retain failures too: a lost reply does not prove that T3 rejected the message.
      const operation = run(['thread', 'send', nativeId(params.session_id), '-', '--json'], params.text).then(data => {
        if (data?.threadId !== nativeId(params.session_id)) throw new RpcError('T3 send result was unclear. Check T3 before retrying.', 'delivery_uncertain')
        rt.sessionsChanged(0)
      })
      writes.set(key, operation)
      return operation
    }
  }
  rt = createRuntime(driver, {
    runtime: options.runtime ?? 't3', name: 'T3 Code (recent messages)', version: '0.1.0',
    ...(options.allowExecution ? { launcher: options.runtime ?? 't3' } : {}),
    socketPath: options.socketPath, refreshMs: options.refreshMs ?? 10_000, log: options.log,
  })
  const sdkStop = rt.stop.bind(rt)
  const stop = async () => { stopped = true; sdkStop(); await runner.stop() }
  rt.stop = stop
  return { runtime: rt, driver, stop }
}
