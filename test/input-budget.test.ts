/**
 * INV-12: input to a live agent is bounded.
 *
 * INV-2 governs whether input is intentional. Nothing governed how much of it
 * there could be. Measured before this existed: 5,000 `key` messages sent in
 * 1.5 seconds were every one accepted, with no error and no backpressure — and
 * against a real fleet each is a `send-keys` queued behind the last on that
 * pane's write queue. A held-down arrow key, a loop in a client, or anything
 * that got past INV-3's gate could bury a working agent in keystrokes.
 *
 * The budget is sized for a person, not a program: sustained 30/s is far above
 * human typing, and the burst absorbs key-repeat without complaining.
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
import type { ServerMessage } from '../src/shared/types.ts'

const SESSION = 'mock-busy'
const started: Server[] = []
const dirs: string[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function recordingPanes(): PaneApi & { writes: number } {
  const real = new MockPanes()
  const box = {
    writes: 0,
    meta: () => real.meta(),
    capture: (p: string, r: number) => real.capture(p, r),
    paste: async (p: string, t: string, s: boolean) => {
      box.writes += 1
      await real.paste(p, t, s)
    },
    key: async () => {
      box.writes += 1
    },
  }
  return box as PaneApi & { writes: number }
}

async function connect(panes: PaneApi): Promise<WebSocket> {
  const webRoot = await mkdtemp(join(tmpdir(), 'ac-budget-'))
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

const send = (socket: WebSocket, message: unknown): void => socket.send(JSON.stringify(message))
const settle = (milliseconds = 600): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

describe('a flood of keystrokes', () => {
  it('does not all reach the agent', async () => {
    const panes = recordingPanes()
    const socket = await connect(panes)
    const errors: string[] = []
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage
      if (m.type === 'error') errors.push(m.message)
    })
    send(socket, { type: 'focus', sessionId: SESSION })
    await settle(200)

    for (let i = 0; i < 5000; i += 1) send(socket, { type: 'key', sessionId: SESSION, key: 'Up' })
    await settle(1200)

    // Before the budget this was 5000.
    expect(panes.writes).toBeLessThan(500)
    expect(panes.writes).toBeGreaterThan(0)
    expect(errors.some((e) => /too much input/.test(e))).toBe(true)
  })

  it('says so once, not once per refused message', async () => {
    const panes = recordingPanes()
    const socket = await connect(panes)
    const errors: string[] = []
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage
      if (m.type === 'error') errors.push(m.message)
    })
    send(socket, { type: 'focus', sessionId: SESSION })
    await settle(200)
    for (let i = 0; i < 3000; i += 1) send(socket, { type: 'key', sessionId: SESSION, key: 'Up' })
    await settle(1200)

    // An error per refusal would answer a flood with a flood.
    expect(errors.filter((e) => /too much input/.test(e)).length).toBe(1)
  })
})

describe('ordinary use', () => {
  it('is never refused', async () => {
    const panes = recordingPanes()
    const socket = await connect(panes)
    const errors: string[] = []
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage
      if (m.type === 'error') errors.push(m.message)
    })
    send(socket, { type: 'focus', sessionId: SESSION })
    await settle(200)

    // A brisk sentence typed into the Attach view, faster than most people manage.
    for (const ch of 'the quick brown fox jumps over the lazy dog') {
      send(socket, { type: 'paste', sessionId: SESSION, text: ch, submit: false })
      await new Promise((r) => setTimeout(r, 15))
    }
    await settle(400)

    expect(errors).toEqual([])
    expect(panes.writes).toBe(43)
  })

  it('recovers after a burst rather than staying shut', async () => {
    const panes = recordingPanes()
    const socket = await connect(panes)
    send(socket, { type: 'focus', sessionId: SESSION })
    await settle(200)
    for (let i = 0; i < 3000; i += 1) send(socket, { type: 'key', sessionId: SESSION, key: 'Up' })
    await settle(1500)
    const afterFlood = panes.writes

    // The bucket refills; a user who let go of the key can type again.
    send(socket, { type: 'key', sessionId: SESSION, key: 'Enter' })
    await settle(400)
    expect(panes.writes).toBeGreaterThan(afterFlood)
  })
})

describe('an oversized frame', () => {
  it('is refused before it is parsed', async () => {
    const panes = recordingPanes()
    const socket = await connect(panes)
    let closed = false
    socket.on('close', () => (closed = true))
    send(socket, { type: 'focus', sessionId: SESSION })
    await settle(200)

    // `MAX_PASTE` would refuse this too, but only after ws buffered it and
    // JSON.parse built the whole string. ws allows 100MB by default.
    send(socket, { type: 'paste', sessionId: SESSION, text: 'x'.repeat(5_000_000), submit: false })
    await settle(800)

    expect(panes.writes).toBe(0)
    expect(closed).toBe(true)
  })
})
