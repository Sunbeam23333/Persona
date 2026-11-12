import { spawn } from 'node:child_process'
import { RpcError } from '../../runtime-sdk/index.js'

/** ACP uses JSON-RPC notifications, unlike Persona's event-envelope RPC. No shell or external dependency. */
export class AcpClient {
  constructor({ command = 'agent', args = ['acp'], cwd, spawnProcess = spawn, onRequest, onNotification, onClose, shutdownGraceMs = 1_000 } = {}) {
    this.pending = new Map()
    this.next = 0
    this.closed = false
    this.buffer = ''
    this.onRequest = onRequest
    this.onNotification = onNotification
    this.onClose = onClose
    this.shutdownGraceMs = shutdownGraceMs
    this.exited = false
    this.exit = new Promise(resolve => { this.resolveExit = resolve })
    this.child = spawnProcess(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.read(chunk))
    this.child.stdout.on('error', () => this.close())
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.close())
    this.child.on('error', () => { if (!this.child.pid) this.markExited(); void this.close() })
    this.child.on('close', () => { this.markExited(); void this.close() })
  }

  markExited() { this.exited = true; this.resolveExit() }

  async waitForExit(ms) {
    let timer
    await Promise.race([this.exit, new Promise(resolve => { timer = setTimeout(resolve, ms) })])
    clearTimeout(timer)
  }

  write(value) {
    if (this.closed) throw new RpcError('Cursor ACP disconnected.', 'disconnected')
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  }

  read(chunk) {
    this.buffer += chunk
    let newline
    while (!this.closed && (newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) { this.close(); return }
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { this.close(); return }
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') { this.close(); return }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) void this.handle(message)
        else {
          try { this.onNotification?.(message.method, message.params ?? {}) } catch { this.close() }
        }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new RpcError('Cursor rejected an ACP request. Check the official CLI authentication and capabilities.', 'acp_error'))
        else pending.resolve(message.result)
      }
    }
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) this.close()
  }

  async handle(message) {
    try {
      if (!this.onRequest) throw new Error('Unsupported request')
      const result = await this.onRequest(message.method, message.params ?? {})
      if (!this.closed) this.write({ id: message.id, result })
    } catch {
      if (!this.closed) this.write({ id: message.id, error: { code: -32601, message: 'Request unsupported or cancelled by Persona.' } })
    }
  }

  request(method, params, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new RpcError('Cursor ACP disconnected.', 'disconnected'))
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError('Cursor ACP request timed out; it was not retried.', 'timeout'))
        this.close()
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  notify(method, params) { this.write({ method, params }) }

  close() {
    if (this.closed) return this.shutdownPromise
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new RpcError('Cursor ACP disconnected.', 'disconnected'))
    }
    this.pending.clear()
    this.onClose?.()
    this.shutdownPromise = (async () => {
      if (this.exited) return
      try { this.child.kill('SIGTERM') } catch {}
      await this.waitForExit(this.shutdownGraceMs)
      if (!this.exited) {
        try { this.child.kill('SIGKILL') } catch {}
        await this.waitForExit(this.shutdownGraceMs)
      }
    })()
    return this.shutdownPromise
  }
}
