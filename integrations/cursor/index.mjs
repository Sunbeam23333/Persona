import { pathToFileURL } from 'node:url'
import { createCursorRuntime } from './lib/runtime.js'
export { createCursorRuntime }

export function parseArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const key = { '--socket': 'socketPath', '--command': 'command', '--runtime': 'runtime' }[args[i]]
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node integrations/cursor/index.mjs [--socket PATH] [--command /path/to/agent] [--runtime ID]')
    options[key] = args[++i]
  }
  return options
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const bridge = createCursorRuntime({ ...parseArgs(process.argv.slice(2)), log: message => console.error(message) })
    await bridge.runtime.start()
    const keepAlive = setInterval(() => {}, 60_000)
    let stopping = false
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      if (stopping) return
      stopping = true
      clearInterval(keepAlive)
      await bridge.stop()
      process.exitCode = 0
    })
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
