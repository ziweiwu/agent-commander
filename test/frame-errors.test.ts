/**
 * A dead pane ends the terminal, not the conversation.
 *
 * The two views read different things — the Attach tab polls tmux, the chat
 * tails a file on disk — but both timers hung off one `clearTimers()`, so a
 * pane that exited took the transcript poll down with it. The user answered
 * "pane has exited", and from then on that tab's conversation was frozen with
 * nothing to say why. The transcript is still on disk and is still the record
 * of what the agent did.
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
import type { PaneMeta } from '../src/server/pane.ts'
import type { ServerMessage } from '../src/shared/types.ts'

/** The agent the mock fixtures give a live pane. */
const SESSION = 'mock-busy'

const started: Server[] = []
const dirs: string[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Panes that are dead on arrival; everything else behaves as the fixtures do. */
function deadPanes(): PaneApi {
  const real = new MockPanes()
  return {
    meta: async (): Promise<PaneMeta> => ({
      cols: 96,
      rows: 24,
      cursorX: 0,
      cursorY: 0,
      alternate: false,
      dead: true,
    }),
    capture: (paneId, rows) => real.capture(paneId, rows),
    // Pasting still works: it is what puts a new event in the transcript, and
    // the point of this test is that such an event still reaches the browser.
    paste: (paneId, text, submit) => real.paste(paneId, text, submit),
    key: () => real.key(),
  }
}

/**
 * Panes whose reads fail for a while and then recover.
 *
 * This is what a machine out of process slots looks like from here: `spawn
 * tmux` returns EAGAIN, the read throws, and a moment later it works again.
 * It is not a pane that has ended, and the two must not be treated alike.
 */
function flakyPanes(failures: number): PaneApi {
  const real = new MockPanes()
  let seen = 0
  return {
    meta: async (): Promise<PaneMeta> => {
      seen += 1
      if (seen <= failures) throw new Error('spawn tmux EAGAIN')
      return real.meta()
    },
    capture: (paneId, rows) => real.capture(paneId, rows),
    paste: (paneId, text, submit) => real.paste(paneId, text, submit),
    key: () => real.key(),
  }
}

async function open(panes: PaneApi = deadPanes()): Promise<WebSocket> {
  const webRoot = await mkdtemp(join(tmpdir(), 'ac-frame-'))
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

/** Resolve on the first server message matching a predicate. */
function next(
  socket: WebSocket,
  match: (msg: ServerMessage) => boolean,
  ms = 4000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timed out waiting for a matching message'))
    }, ms)
    function onMessage(raw: unknown): void {
      const msg = JSON.parse(String(raw)) as ServerMessage
      if (!match(msg)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(msg)
    }
    socket.on('message', onMessage)
  })
}

const send = (socket: WebSocket, msg: unknown): void => socket.send(JSON.stringify(msg))

describe('when the pane has exited', () => {
  it('says so', async () => {
    const socket = await open()
    send(socket, { type: 'focus', sessionId: SESSION })
    await next(socket, (m) => m.type === 'timeline')
    send(socket, { type: 'attach', sessionId: SESSION, on: true })

    const error = await next(socket, (m) => m.type === 'error')
    expect(error).toMatchObject({ type: 'error', message: 'pane has exited' })
  })

  it('keeps sending the conversation afterwards', async () => {
    const socket = await open()
    send(socket, { type: 'focus', sessionId: SESSION })
    await next(socket, (m) => m.type === 'timeline')

    send(socket, { type: 'attach', sessionId: SESSION, on: true })
    await next(socket, (m) => m.type === 'error')

    // A message sent after the pane died still shows up in the chat, which is
    // only true if the transcript poll survived the frame failure.
    send(socket, { type: 'paste', sessionId: SESSION, text: 'still listening?', submit: true })
    const timeline = await next(
      socket,
      (m) => m.type === 'timeline' && m.events.some((e) => e.text === 'still listening?'),
    )
    expect(timeline).toMatchObject({ type: 'timeline', sessionId: SESSION })
  })
})

describe('when a read fails but the pane is alive', () => {
  /*
   * The read failing once used to end the terminal. On a machine at its
   * process cap that is an ordinary event, so the Attach view would stop for
   * good with a toast about EAGAIN and no way back but closing and re-opening
   * it -- while the agent behind it was working perfectly well.
   */
  it('rides out a run of failures and then draws the pane', async () => {
    const socket = await open(flakyPanes(3))
    send(socket, { type: 'focus', sessionId: SESSION })
    await next(socket, (m) => m.type === 'timeline')
    send(socket, { type: 'attach', sessionId: SESSION, on: true })

    const frame = await next(socket, (m) => m.type === 'frame')
    expect(frame).toMatchObject({ type: 'frame' })
  })

  it('still gives up when the failures do not stop', async () => {
    const socket = await open(flakyPanes(Number.MAX_SAFE_INTEGER))
    send(socket, { type: 'focus', sessionId: SESSION })
    await next(socket, (m) => m.type === 'timeline')
    send(socket, { type: 'attach', sessionId: SESSION, on: true })

    // Tolerating a blip is not the same as pretending forever. The reason the
    // user is shown is the real one from tmux, not a guess.
    const error = await next(socket, (m) => m.type === 'error')
    expect(error).toMatchObject({ type: 'error', message: expect.stringMatching(/EAGAIN/) })
  })
})
