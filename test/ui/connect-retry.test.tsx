/**
 * The reconnect loop has to survive a constructor that throws.
 *
 * `new WebSocket()` does not always fail by firing an event. Mixed content on
 * an https page, or a token that will not survive `URL`, throws synchronously —
 * and the throw escaped `connect()` from inside the retry timer. No socket
 * meant no `close` event, and `close` was the only thing that scheduled the
 * next attempt, so the chain ended there.
 *
 * What that looked like is why this test exists: `conn` stayed `'closed'` for
 * the life of the page, so Send, Stop and every quick prompt were disabled
 * under a caption reading "reconnecting…" about a reconnection nothing was
 * attempting. The only way out was a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from '../../src/web/store/transport.ts'
import { useStore } from '../../src/web/store/store.ts'

/** Enough of a socket for `connect` to attach its listeners to. */
class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 1
  #listeners = new Map<string, () => void>()
  constructor() {
    FakeSocket.last = this
  }
  addEventListener(kind: string, fn: () => void): void {
    this.#listeners.set(kind, fn)
  }
  fire(kind: string): void {
    this.#listeners.get(kind)?.()
  }
  close(): void {}
}

const original = globalThis.WebSocket

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.last = null
  useStore.setState({ conn: 'connecting' })
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.WebSocket = original
})

describe('the websocket retry chain', () => {
  it('schedules another attempt when the constructor throws', () => {
    const ctor = vi.fn(function () {
      // Fail once, the way a transient failure does, then succeed.
      if (ctor.mock.calls.length === 1) throw new DOMException('insecure', 'SecurityError')
      return new FakeSocket()
    })
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = ctor

    connect()
    // It failed, and said so, rather than leaving a stale 'connecting'.
    expect(ctor.mock.calls.length).toBe(1)
    expect(useStore.getState().conn).toBe('closed')

    // The retry that the missing catch used to swallow.
    vi.advanceTimersByTime(10_000)
    expect(ctor.mock.calls.length).toBeGreaterThan(1)

    // And what comes back is a live socket again, not a wedged caption.
    FakeSocket.last?.fire('open')
    expect(useStore.getState().conn).toBe('open')
  })

  it('keeps trying when every attempt throws, rather than stopping', () => {
    const ctor = vi.fn(function () {
      throw new DOMException('insecure', 'SecurityError')
    })
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = ctor

    connect()
    vi.advanceTimersByTime(60_000)
    // The backoff caps at 10s, so a minute is several attempts however it is
    // counted. The point is only that it never gave up.
    expect(ctor.mock.calls.length).toBeGreaterThan(2)
    expect(useStore.getState().conn).toBe('closed')
  })
})
