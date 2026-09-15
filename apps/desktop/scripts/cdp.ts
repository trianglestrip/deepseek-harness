/**
 * Drive the running desktop window over the WebView2 DevTools protocol.
 *
 * The shell's own pages and the Host-served application page are only reachable
 * through a window, and a window is the slowest place to read a JavaScript
 * error. This connects to the debugging port `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
 * opens, so a stuck panel can be inspected and its console read from a terminal.
 *
 * Usage:
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm run app -- --fresh
 *   pnpm --filter @deepseek-ai/dsh-desktop run cdp -- --console 10
 *   pnpm --filter @deepseek-ai/dsh-desktop run cdp -- --eval "document.title"
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
/** Minimal shape of the WebSocket client this tool needs. */
interface WebSocketLike {
  on(event: string, listener: (raw: Buffer) => void): void
  once(event: string, listener: (...args: unknown[]) => void): void
  send(data: string): void
  close(): void
}

const WebSocket = require('ws') as new (url: string) => WebSocketLike

const PORT = process.env['DSH_DESKTOP_CDP_PORT'] ?? '9222'

/** Read one `--name value` pair from argv. */
function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value ?? fallback
}

interface Target {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly webSocketDebuggerUrl: string
}

const targets = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()) as Target[]
if (targets.length === 0) throw new Error('desktop cdp: no page target; is the application running with the debugging port?')
for (const target of targets) process.stdout.write(`desktop cdp: ${target.id} ${target.title} ${target.url}\n`)
const target = targets.find(candidate => candidate.url.startsWith('http')) ?? targets[0]
if (target === undefined) throw new Error('desktop cdp: no target')

const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map<number, (value: unknown) => void>()

/** Send one protocol command and await its result. */
function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId
  nextId += 1
  const settled = new Promise(resolve => { pending.set(id, resolve) })
  socket.send(JSON.stringify({ id, method, params }))
  return settled
}

socket.on('message', (raw: Buffer) => {
  const message = JSON.parse(raw.toString()) as {
    id?: number
    result?: unknown
    method?: string
    params?: Record<string, unknown>
  }
  if (message.id !== undefined) {
    pending.get(message.id)?.(message.result)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const params = message.params as { type?: string; args?: { value?: unknown; description?: string }[] }
    const text = (params.args ?? []).map(arg => (arg.value === undefined ? arg.description : JSON.stringify(arg.value))).join(' ')
    process.stdout.write(`console.${String(params.type)}: ${text}\n`)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const params = message.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } }
    process.stdout.write(`exception: ${params.exceptionDetails?.exception?.description ?? String(params.exceptionDetails?.text)}\n`)
  }
})

await new Promise(resolve => socket.once('open', resolve))
await send('Runtime.enable')
await send('Log.enable')

const expression = option('eval', '')
if (expression !== '') {
  const result = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as {
    result?: { value?: unknown; description?: string }
    exceptionDetails?: { exception?: { description?: string } }
  }
  process.stdout.write(`${JSON.stringify(result.result?.value ?? result.result?.description ?? result.exceptionDetails, undefined, 2)}\n`)
}

const seconds = Number(option('console', '0'))
if (seconds > 0) {
  process.stdout.write(`desktop cdp: listening for ${String(seconds)}s\n`)
  await new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

socket.close()
process.exit(0)
