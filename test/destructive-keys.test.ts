/**
 * INV-6, at the boundary rather than in the browser.
 *
 * `C-c`, `C-d` and `Escape` are on `ALLOWED_KEYS` because they are keys a user
 * legitimately sends — interrupting a stuck agent is half the point of the
 * Attach view. What made them different was a `window.confirm` in
 * `Terminal.tsx` and nothing else, so the server forwarded them to a live agent
 * for anyone who could open a WebSocket, discarding whatever that agent had in
 * flight. INV-2 says in as many words that the client's allowlist is a
 * convenience and not the boundary; INV-6 was the one place that was not true.
 *
 * The flag is not proof that a human answered — nothing on this wire can be.
 * It makes sending one deliberate rather than incidental, and it puts the rule
 * where every other rule about reaching a live agent already lives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { WebSocket } from 'ws'
import { createAppServer } from '../src/server/routes.ts'
import { MockPanes, MockSource, MockTail } from '../src/server/mock.ts'
import type { PaneApi } from '../src/server/sources.ts'
import { ALLOWED_KEYS, DESTRUCTIVE_KEYS, type ServerMessage } from '../src/shared/types.ts'

const SESSION = 'mock-busy'
const started: Server[] = []
const dirs: string[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Panes that record what actually reached tmux. */
function recordingPanes(): PaneApi & { delivered: string[] } {
  const real = new MockPanes()
  const delivered: string[] = []
  return {
    delivered,
    meta: () => real.meta(),
    capture: (paneId, rows) => real.capture(paneId, rows),
    paste: (paneId, text, submit) => real.paste(paneId, text, submit),
    key: async (_paneId: string, keyName: string) => {
      delivered.push(keyName)
    },
  }
}

async function open(panes: PaneApi): Promise<WebSocket> {
  const webRoot = await mkdtemp(join(tmpdir(), 'ac-keys-'))
  dirs.push(webRoot)
  const server = createAppServer({
    source: new MockSource(),
    panes,
    makeTail: (id: string) => new MockTail(id),
    mock: true,
    webRoot,
    env: { tailscale: null, tmux: true, port: 0, platform: 'darwin' },
  })
  started.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  sockets.push(socket)
  await new Promise((resolve) => socket.on('open', resolve))
  return socket
}

const send = (socket: WebSocket, msg: unknown): void => socket.send(JSON.stringify(msg))

/** Give the server a moment to act, then report what it did. */
function collect(socket: WebSocket, milliseconds = 300): Promise<ServerMessage[]> {
  const seen: ServerMessage[] = []
  socket.on('message', (raw) => seen.push(JSON.parse(String(raw)) as ServerMessage))
  return new Promise((resolve) => setTimeout(() => resolve(seen), milliseconds))
}

describe('a destructive key with no confirmation', () => {
  it.each([...DESTRUCTIVE_KEYS])('refuses %s and does not forward it', async (key) => {
    const panes = recordingPanes()
    const socket = await open(panes)
    send(socket, { type: 'focus', sessionId: SESSION })
    const messages = collect(socket)
    send(socket, { type: 'key', sessionId: SESSION, key })

    const seen = await messages
    expect(panes.delivered).toEqual([])
    expect(seen.some((m) => m.type === 'error' && /confirmation/.test(m.message))).toBe(true)
  })

  it('refuses it however the client is written', async () => {
    // The point of moving this server-side: a client that simply omits the
    // flag -- a script, an old tab, a page on another origin that got past the
    // gate -- gets the same answer as the one that asks properly.
    const panes = recordingPanes()
    const socket = await open(panes)
    send(socket, { type: 'focus', sessionId: SESSION })
    const messages = collect(socket)
    send(socket, { type: 'key', sessionId: SESSION, key: 'C-c', confirmed: false })
    send(socket, { type: 'key', sessionId: SESSION, key: 'C-c', confirmed: 'yes' })
    send(socket, { type: 'key', sessionId: SESSION, key: 'C-c', confirmed: 1 })

    await messages
    expect(panes.delivered).toEqual([])
  })
})

describe('a destructive key that was confirmed', () => {
  it.each([...DESTRUCTIVE_KEYS])('forwards %s', async (key) => {
    const panes = recordingPanes()
    const socket = await open(panes)
    send(socket, { type: 'focus', sessionId: SESSION })
    const messages = collect(socket)
    send(socket, { type: 'key', sessionId: SESSION, key, confirmed: true })

    await messages
    // Interrupting a stuck agent is half the point of the Attach view; the
    // guard exists to make it deliberate, not to make it impossible.
    expect(panes.delivered).toEqual([key])
  })
})

describe('every other allowed key', () => {
  it('still needs no confirmation', async () => {
    const ordinary = ALLOWED_KEYS.filter((k) => !DESTRUCTIVE_KEYS.has(k))
    const panes = recordingPanes()
    const socket = await open(panes)
    send(socket, { type: 'focus', sessionId: SESSION })
    const messages = collect(socket, 500)
    for (const key of ordinary) send(socket, { type: 'key', sessionId: SESSION, key })

    await messages
    expect(panes.delivered).toEqual([...ordinary])
  })
})
