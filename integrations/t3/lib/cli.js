import { spawn } from 'node:child_process'
import { RpcError } from '../../runtime-sdk/index.js'

/** Run only the short-lived CLI child; stopping it does not stop the T3 server or its tasks. */
export function runCLI(command, args, { input = '', timeoutMs = 30_000, spawnProcess = spawn, signal, shutdownGraceMs = 1_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new RpcError('T3 CLI request was cancelled before launch.', 'cancelled')); return }
    let child, timer, settled = false, exited = false, output = '', bytes = 0
    let resolveExit
    const exit = new Promise(resolve => { resolveExit = resolve })
    const waitForExit = async () => {
      let timer
      await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, shutdownGraceMs) })])
      clearTimeout(timer)
    }
    const terminate = async () => {
      if (!child || exited) return
      try { child.kill('SIGTERM') } catch {}
      await waitForExit()
      if (!exited) {
        try { child.kill('SIGKILL') } catch {}
        await waitForExit()
      }
    }
    const abort = () => void finish(new RpcError('T3 CLI was cancelled. The server task may already have started; inspect T3 before resending.', 'cancelled'))
    const finish = async (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) { await terminate(); reject(error) } else resolve(value)
    }
    try {
      child = spawnProcess(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      finish(new RpcError('Unable to start the installed T3 CLI.', 'cli_unavailable'))
      return
    }
    child.on('error', () => {
      if (!child.pid) { exited = true; resolveExit() }
      void finish(new RpcError('Unable to start the installed T3 CLI.', 'cli_unavailable'))
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('error', () => void finish(new RpcError('T3 CLI output disconnected.', 'upstream_response')))
    child.stdout.on('data', chunk => {
      if (settled) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > 8 * 1024 * 1024) {
        finish(new RpcError('T3 response exceeded the size limit.', 'upstream_response'))
        return
      }
      output += chunk
    })
    // Do not echo stderr: upstream diagnostics can contain credentials or full prompts.
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('close', code => {
      exited = true; resolveExit()
      if (code === 2) { void finish(new RpcError('T3 needs user input or approval. Open T3 Code; the request was not retried.', 'needs_user')); return }
      if (code !== 0) {
        finish(new RpcError('T3 CLI failed. Check T3 Code; an execution request may already have been delivered. It was not retried.', 'upstream_failed'))
        return
      }
      try { finish(undefined, JSON.parse(output)) }
      catch { finish(new RpcError('T3 returned invalid JSON. Update the CLI and server together.', 'upstream_response')) }
    })
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      finish(new RpcError('T3 CLI timed out. Check T3 Code before resending; nothing was retried.', 'upstream_timeout'))
    }, timeoutMs)
    if (signal?.aborted) abort()
    else child.stdin.end(input)
  })
}

/** Registry for transient CLI processes, never for T3's independently owned server. */
export function createCLIRunner(command, options = {}) {
  const pending = new Map()
  let stopped = false
  return {
    run(args, input) {
      if (stopped) return Promise.reject(new RpcError('T3 connector has stopped.', 'cancelled'))
      const controller = new AbortController()
      const operation = runCLI(command, args, { ...options, input, signal: controller.signal })
      pending.set(controller, operation)
      operation.then(() => pending.delete(controller), () => pending.delete(controller))
      return operation
    },
    async stop() {
      stopped = true
      const operations = [...pending.values()]
      for (const controller of pending.keys()) controller.abort()
      await Promise.allSettled(operations)
    },
  }
}
