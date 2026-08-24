/**
 * INV-4: "nothing polls what nobody is watching."
 *
 * A tab that is closed sends a close frame, `ws` reports it, and everything
 * that tab was driving stops. A phone that goes to sleep on the far side of
 * Tailscale — the flow INV-3 exists to support — sends nothing at all. The TCP
 * connection is half open: the server has a `Viewer` that is still tailing an
 * agent's transcript once a second and, if the terminal was open, still holding
 * a share of that pane's poller and making real tmux round trips, on behalf of
 * a browser that is not there. Nothing in the app noticed, and the OS keepalive
 * can take hours to.
 *
 * A ping is the only thing the protocol offers here, so these tests are about
 * what happens to a socket that stops answering one.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { WebSocket } from 'ws'
import { createAppServer } from '../src/server/routes.ts'
import { MockLimits, MockPanes, MockSource, MockTail } from '../src/server/mock.ts'
import type { ServerMessage } from '../src/shared/types.ts'

const SESSION = 'mock-busy'

/*
 * The heartbeat interval these tests run at. Production is 30s; this has to be
 * short enough to test a timeout without waiting one, and long enough that a
 * *live* socket can answer within it.
 *
 * It was 40ms, which is the wrong side of that line: a client has one interval
 * to pong, and on a machine busy enough to be running the rest of this suite a
 * loopback round trip does not reliably fit in 40ms — so the test asserting a
 * healthy socket survives failed intermittently, blaming the server for a
 * deadline the test had set too tight.
 */
const BEAT = 150

const started: Server[] = []
const dirs: string[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** A transcript tail that says when it was read, so a stopped one is visible. */
function countingTail(sessionId: string, onRead: () => void) {
  const real = new MockTail(sessionId)
  return {
    read: async () => {
      onRead()
      return real.read()
    },
  }
}

const settle = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

interface Harness {
  port: number
  /** Transcript reads across the whole server, so a stopped tail is visible. */
  tailReads: () => number
  viewerCounts: number[]
}

async function serve(): Promise<Harness> {
  const webRoot = await mkdtemp(join(tmpdir(), 'ac-beat-'))
  dirs.push(webRoot)
  let tailReads = 0
  const viewerCounts: number[] = []

  const server = createAppServer({
    source: new MockSource(),
    panes: new MockPanes(),
    makeTail: (id: string) => countingTail(id, () => (tailReads += 1)),
    limits: new MockLimits(),
    mock: true,
    webRoot,
    heartbeatMs: BEAT,
    onViewers: (count) => viewerCounts.push(count),
    env: { tailscale: null, tmux: true, port: 0, platform: 'darwin' },
  })
  started.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    tailReads: () => tailReads,
    viewerCounts,
  }
}

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  sockets.push(socket)
  await new Promise((resolve) => socket.on('open', resolve))
  return socket
}

const send = (socket: WebSocket, msg: unknown): void => socket.send(JSON.stringify(msg))

/**
 * A peer that is still there at the TCP level and answering nothing above it:
 * exactly a slept phone. Pausing the underlying socket leaves the server's ping
 * sitting unread in the kernel buffer, so no pong is ever sent — and the test
 * does not have to hand-roll a WebSocket handshake to get there.
 */
function goSilent(socket: WebSocket): void {
  ;(socket as unknown as { _socket: { pause: () => void } })._socket.pause()
}

/** Poll a condition rather than guessing one sleep long enough to cover it. */
async function until(ok: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return
    await settle(10)
  }
  throw new Error('condition never held')
}

/** Resolve on the first server message matching a predicate. */
function next(socket: WebSocket, match: (m: ServerMessage) => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timed out waiting for a matching message'))
    }, ms)
    function onMessage(raw: unknown): void {
      if (!match(JSON.parse(String(raw)) as ServerMessage)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve()
    }
    socket.on('message', onMessage)
  })
}

describe('INV-4 a socket that stops answering is dropped', () => {
  it('keeps a socket that answers its pings', async () => {
    const { port } = await serve()
    const socket = await connect(port)

    // `ws` answers a ping itself, which is what a live browser does.
    await settle(BEAT * 5)

    expect(socket.readyState).toBe(WebSocket.OPEN)
  })

  it('closes one that has gone silent, within two rounds', async () => {
    const { port, viewerCounts } = await serve()
    const socket = await connect(port)
    await settle(20)
    expect(viewerCounts.at(-1)).toBe(1)

    goSilent(socket)

    /*
     * Asserted from the server, not from the client. A paused socket cannot
     * observe its own close either — which is the whole point of the peer being
     * simulated this way — so the evidence that has to exist is the server
     * letting the viewer go.
     */
    await until(() => viewerCounts.at(-1) === 0, BEAT * 12)
  })

  it('stops that viewer tailing the transcript once it is dropped', async () => {
    const { port, tailReads, viewerCounts } = await serve()
    const socket = await connect(port)

    send(socket, { type: 'focus', sessionId: SESSION })
    await next(socket, (m) => m.type === 'timeline')

    // The tail runs at a second, so this is what "still polling" looks like.
    const readsWhileWatching = tailReads()
    await settle(1_200)
    expect(tailReads()).toBeGreaterThan(readsWhileWatching)

    goSilent(socket)
    await until(() => viewerCounts.at(-1) === 0, BEAT * 12)

    // The drop has to release the timers, not merely close the socket: it was
    // this tail that went on reading a file for a browser that was not there.
    const atDrop = tailReads()
    await settle(1_500)
    expect(tailReads()).toBe(atDrop)
  })

  it('reports the viewer count so the fleet enricher can idle', async () => {
    const { port, viewerCounts } = await serve()
    expect(viewerCounts).toEqual([])

    const a = await connect(port)
    const b = await connect(port)
    await settle(20)
    expect(viewerCounts).toEqual([1, 2])

    a.close()
    b.close()
    await settle(60)
    expect(viewerCounts.at(-1)).toBe(0)
  })
})
