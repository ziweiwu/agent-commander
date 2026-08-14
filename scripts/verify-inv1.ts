/**
 * INV-1 regression check against the live tmux server.
 *
 * Snapshots every tmux client and pane geometry, drives a real attach session
 * against a live agent for a few seconds, then asserts nothing moved. This is
 * the check that would fail if anyone ever replaced frame capture with a pty
 * and `tmux attach`.
 *
 *   npx tsx scripts/verify-inv1.ts [--port 4317]
 */
import { clientSnapshot } from '../src/server/pane.ts'

const portArg = process.argv.indexOf('--port')
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 4317
const BASE = `http://127.0.0.1:${PORT}`

interface AgentRow {
  sessionId: string
  name: string
  paneId?: string
  status: string
}

// Annotated on the const so TypeScript uses it to narrow control flow below.
const fail: (message: string) => never = (message) => {
  process.stderr.write(`FAIL  ${message}\n`)
  process.exit(1)
}

const agents: AgentRow[] = await fetch(`${BASE}/api/agents`)
  .then((r) => r.json() as Promise<{ agents: AgentRow[] }>)
  .then((d) => d.agents)
  .catch(() => fail(`could not reach ${BASE} — start the server first`))

const target = agents.find((a) => a.paneId)
if (!target) fail('no attachable agent to test against')

process.stdout.write(`attaching to ${target.name} (pane ${target.paneId})\n`)

const before = await clientSnapshot()

await new Promise<void>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  let frames = 0
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'focus', sessionId: target.sessionId }))
    setTimeout(
      () => ws.send(JSON.stringify({ type: 'attach', sessionId: target.sessionId, on: true })),
      300,
    )
  })
  ws.addEventListener('message', (e) => {
    if (JSON.parse(String(e.data)).type === 'frame') frames += 1
  })
  setTimeout(() => {
    ws.close()
    process.stdout.write(`received ${frames} frame(s)\n`)
    if (frames === 0) fail('no frames received — the attach path did not run')
    resolve()
  }, 4000)
})

const after = await clientSnapshot()

if (before !== after) {
  process.stderr.write('--- before ---\n' + before + '\n--- after ---\n' + after + '\n')
  fail('INV-1 violated: tmux clients or pane geometry changed during attach')
}

process.stdout.write('PASS  INV-1: no tmux client created, no pane resized\n')
