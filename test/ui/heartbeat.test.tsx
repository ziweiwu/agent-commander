/**
 * INV-4, from the browser's side: a socket that has stopped carrying anything
 * is dropped rather than believed.
 *
 * The failure this exists for is the one a phone actually hits. A tab that
 * sleeps behind Tailscale wakes holding a socket that both ends still call
 * OPEN — no `close` fires, so nothing reconnects, the header reads "live", and
 * `send()` returns true for writes that reach nobody. `readyState` cannot tell
 * that apart from a quiet fleet; only the absence of the server's beat can.
 *
 * The other half is the re-ask. `focus` is the sole thing that subscribes a
 * tab to a conversation and the server has several ways to drop one in
 * silence, chiefly a session id the registry does not know *yet* — which is
 * what a reconnect into a restarted server looks like. `focusAgent` cannot
 * cover it, because it early-returns when the selection has not changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from '../../src/web/store/transport.ts'
import { useStore } from '../../src/web/store/store.ts'

/** Enough of a socket to open, carry text, and be closed. */
class FakeSocket {
  static last: FakeSocket | null = null
  static readonly OPEN = 1
  readyState = 1
  sent: string[] = []
  closed = false
  #listeners = new Map<string, (event?: unknown) => void>()
  constructor() {
    FakeSocket.last = this
  }
  addEventListener(kind: string, fn: (event?: unknown) => void): void {
    this.#listeners.set(kind, fn)
  }
  fire(kind: string, event?: unknown): void {
    this.#listeners.get(kind)?.(event)
  }
  /** A server message arriving, as the transport sees it. */
  deliver(msg: unknown): void {
    this.fire('message', { data: JSON.stringify(msg) })
  }
  send(text: string): void {
    this.sent.push(text)
  }
  close(): void {
    this.closed = true
    this.readyState = 3
    this.fire('close')
  }
  /** What this socket was asked to send, parsed. */
  messages(): { type: string; sessionId?: string | null }[] {
    return this.sent.map((s) => JSON.parse(s) as { type: string; sessionId?: string | null })
  }
}

const original = globalThis.WebSocket

function useFakeSocket(): void {
  const ctor = vi.fn(function () {
    return new FakeSocket()
  })
  ;(ctor as unknown as { OPEN: number }).OPEN = 1
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = ctor
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.last = null
  useStore.setState({ conn: 'connecting', selected: null, timelineAt: null, timelineStalledAt: null })
  useFakeSocket()
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.WebSocket = original
  useStore.setState({ selected: null, timelineAt: null, timelineStalledAt: null })
})

describe('INV-4 the heartbeat', () => {
  it('answers the server, so it is not taken for a tab that has gone', () => {
    connect()
    const ws = FakeSocket.last!
    ws.fire('open')
    ws.deliver({ type: 'ping' })
    expect(ws.messages().map((m) => m.type)).toContain('pong')
  })

  it('drops a socket that has carried nothing for longer than the beat', () => {
    connect()
    const first = FakeSocket.last!
    first.fire('open')
    first.deliver({ type: 'ping' })
    expect(useStore.getState().conn).toBe('open')

    // Under the silence threshold, a quiet fleet is just a quiet fleet.
    vi.advanceTimersByTime(60_000)
    expect(first.closed).toBe(false)

    vi.advanceTimersByTime(30_000)
    expect(first.closed).toBe(true)
    // Closing by hand is the point: `close` is what schedules the reconnect,
    // and a half-open socket never fires one on its own.
    expect(useStore.getState().conn).toBe('closed')
  })

  it('keeps a socket that is still being beaten to', () => {
    connect()
    const ws = FakeSocket.last!
    ws.fire('open')
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(30_000)
      ws.deliver({ type: 'ping' })
    }
    expect(ws.closed).toBe(false)
    expect(useStore.getState().conn).toBe('open')
  })

  /*
   * The pairing this has to survive: `npm run build` rewrites `dist/web` under
   * a server that has been up for days, so a page newer than the binary
   * answering it is what a rebuild ordinarily produces here. Such a server
   * sends no beat, and a watchdog that assumed one would drop a perfectly good
   * socket every minute the fleet was quiet.
   */
  it('leaves a socket alone when its server has never beaten', () => {
    connect()
    const ws = FakeSocket.last!
    ws.fire('open')
    ws.deliver({ type: 'fleet', agents: [], mock: false })
    vi.advanceTimersByTime(5 * 60_000)
    expect(ws.closed).toBe(false)
    expect(useStore.getState().conn).toBe('open')
  })

  it('does not close a socket that was replaced while it was dying', () => {
    connect()
    const first = FakeSocket.last!
    first.fire('open')
    // A reconnect lands before the old socket's close is delivered.
    connect()
    const second = FakeSocket.last!
    expect(second).not.toBe(first)
    second.fire('open')

    first.fire('close')
    // The live socket survives its predecessor's funeral: without the identity
    // check the module's `socket` would be nulled and `send()` would refuse
    // for the life of the page under a caption reading "reconnecting…".
    expect(useStore.getState().conn).toBe('open')
  })
})

describe('INV-4 a focus that was never answered', () => {
  it('is asked again, and stops the moment the conversation arrives', () => {
    useStore.setState({ selected: 'a1' })
    connect()
    const ws = FakeSocket.last!
    ws.fire('open')
    expect(ws.messages().filter((m) => m.type === 'focus').length).toBe(1)

    vi.advanceTimersByTime(3_500)
    expect(ws.messages().filter((m) => m.type === 'focus').length).toBe(2)

    ws.deliver({ type: 'timeline', sessionId: 'a1', events: [], reset: true })
    vi.advanceTimersByTime(30_000)
    expect(ws.messages().filter((m) => m.type === 'focus').length).toBe(2)
    expect(useStore.getState().timelineAt).not.toBeNull()
  })

  it('gives up saying so, rather than asking for ever (INV-4, INV-11)', () => {
    useStore.setState({ selected: 'a1' })
    connect()
    const ws = FakeSocket.last!
    ws.fire('open')

    vi.advanceTimersByTime(60_000)
    const asks = ws.messages().filter((m) => m.type === 'focus').length
    expect(asks).toBeLessThanOrEqual(6)
    expect(useStore.getState().timelineStalledAt).not.toBeNull()
    expect(useStore.getState().timelineAt).toBeNull()
  })
})
