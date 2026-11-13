import { pathToFileURL } from 'node:url'
import { createT3Runtime } from './lib/runtime.js'
export { createT3Runtime }

export function parseArgs(args) {
  const options = { projects: [] }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--allow-execution') { options.allowExecution = true; continue }
    if (!['--project', '--socket', '--command', '--runtime', '--messages'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node integrations/t3/index.mjs --project /absolute/project [--project /another] [--allow-execution] [--socket PATH] [--command t3] [--runtime ID] [--messages 40]')
    }
    const value = args[++i]
    if (flag === '--project') options.projects.push(value)
    else options[{ '--socket': 'socketPath', '--command': 'command', '--runtime': 'runtime', '--messages': 'messages' }[flag]] = flag === '--messages' ? Number(value) : value
  }
  return options
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { runtime } = createT3Runtime({ ...parseArgs(process.argv.slice(2)), log: message => console.error(message) })
    await runtime.start()
    // SDK reconnect timers are unref'ed because most drivers live inside another host process.
    const keepAlive = setInterval(() => {}, 60_000)
    let stopping = false
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      if (stopping) return
      stopping = true
      clearInterval(keepAlive)
      await runtime.stop()
      process.exitCode = 0
    })
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
