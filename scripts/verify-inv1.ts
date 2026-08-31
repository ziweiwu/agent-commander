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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Every tmux client and every pane geometry, as one comparable string.
 *
 * Inlined rather than imported: the server is a Rust binary now, so there is no
 * TypeScript module to borrow this from — and this check has always been about
 * what tmux reports from outside the server, not about the server's own code.
 */
async function clientSnapshot(): Promise<string> {
  const tmux = async (args: string[]): Promise<string> =>
    run('tmux', args)
      .then(({ stdout }) => stdout)
      .catch(() => '')
  const clients = await tmux([
    'list-clients',
    '-F',
    '#{client_name} #{client_width}x#{client_height} #{client_session} #{client_flags}',
  ])
  const panes = await tmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_width}x#{pane_height}'])
  return `${clients}\n---\n${panes}`
}

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

/*
 * The amended half of INV-1 — and the property is NOT `ignore-size`.
 *
 * I asserted `ignore-size` here first, on the strength of one test that had a
 * hidden variable. A controlled matrix on a fresh server says otherwise: with
 * `window-size latest`, a *regular* client attaching at 80x24 to a 200x50
 * window shrinks it to 80x21 with `-f ignore-size`, with `-r`, with
 * `-f read-only,ignore-size`, and with no flags at all. All four. The flag
 * describes how a client affects *other clients*, not whether the window
 * follows it, so asserting it was asserting a guarantee tmux does not make.
 *
 * What actually holds is narrower and stronger: a CONTROL-MODE client has no
 * size to impose. tmux reports `client_height` as empty for it, and it only
 * ever acquires one by asking, via `refresh-client -C`. This app never sends
 * that (asserted in test/safety.test.ts), so its client cannot participate in
 * sizing at all — by construction rather than by a flag.
 *
 * So: every client of ours must be control-mode with no height. Clients that
 * are not ours are none of this app's business — the user's own terminals are
 * attached to these sessions and are supposed to size them. Ours are the ones
 * with no tty, which is what a control client on a pipe is.
 */
const clients = await run('tmux', [
  'list-clients',
  '-F',
  '#{client_name}\t#{client_tty}\t#{client_height}\t#{client_flags}',
])
  .then((r) => r.stdout.trim())
  .catch(() => '')

const ours = clients
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => line.split('\t'))
  .filter(([, tty]) => tty === '' || tty === undefined)

const offenders = ours.filter(
  ([, , height, flags]) =>
    !(flags ?? '').split(',').includes('control-mode') || (height ?? '').trim() !== '',
)

if (offenders.length > 0) {
  process.stderr.write(`clients:\n${clients}\n`)
  fail(
    'INV-1 violated: a client of ours is not control-mode, or has acquired a height — ' +
      'either way it can now resize the window',
  )
}

process.stdout.write(
  'PASS  INV-1: no pane resized, and every client of ours is control-mode with no size\n',
)
