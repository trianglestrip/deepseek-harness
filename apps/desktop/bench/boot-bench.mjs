/** Benchmark: spawn one dsh web launch, report time-to-ready and time-to-listen. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const [label, command, ...args] = process.argv.slice(2)
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

const child = spawn(command, args, {
  cwd: 'D:/gitProject/testCAD/portable/deepseek-harness',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: process.env,
})
let lines = 0
let stderrLines = 0
const out = createInterface({ input: child.stdout })
const err = createInterface({ input: child.stderr })
out.on('line', (line) => {
  lines += 1
  if (line.includes('dsh web:')) console.log(`[${stamp()}] READY: ${line.slice(0, 120)}`)
  else if (lines <= 6 || line.includes('error') || line.includes('Error')) console.log(`[${stamp()}] OUT: ${line.slice(0, 140)}`)
})
err.on('line', (line) => {
  stderrLines += 1
  if (stderrLines <= 4 || line.includes('failed') || line.includes('failed to load')) console.log(`[${stamp()}] ERR: ${line.slice(0, 140)}`)
})
child.once('exit', (code) => console.log(`[${stamp()}] EXIT code=${String(code)} stdout=${String(lines)} stderr=${String(stderrLines)}`))

// Record when the server actually listens: poll the announce port once READY is seen.
out.on('line', (line) => {
  const match = /dsh web: http:\/\/127\.0\.0\.1:(\d+)\//u.exec(line)
  if (match === null) return
  const port = match[1]
  const poll = setInterval(() => {
    fetch(`http://127.0.0.1:${port}/`).then((res) => {
      clearInterval(poll)
      console.log(`[${stamp()}] LISTEN-PROBE: HTTP ${String(res.status)} (auth response = server reachable)`)
      console.log(`[${stamp()}] TOTAL-TO-REACHABLE`)
      child.kill()
      setTimeout(() => { child.kill('SIGKILL'); process.exit(0) }, 2000)
    }).catch(() => { /* not accepting yet */ })
  }, 200)
})
