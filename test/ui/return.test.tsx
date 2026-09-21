/**
 * INV-4 and INV-11, from the phone's side: coming back to the app is cheap.
 *
 * iOS closes a backgrounded web app's socket without telling the page, and a
 * page that was evicted repaints from nothing. Until now a returning user
 * waited on whichever came first — a backoff of up to ten seconds, or the
 * watchdog's next tick after seventy-five seconds of silence — while the
 * header read "live" over a socket that reached nobody. The page's own return
 * is the event that should decide it: a socket waiting out a backoff connects
 * now, one that slept past the beat is closed now, and one that merely looks
 * open is asked, once, with a short deadline (INV-2 forbids replaying anything
 * on the way back; nothing here sends a keystroke).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from '../../src/web/store/transport.ts'
import { useStore } from '../../src/web/store/store.ts'

class FakeSocket {
  static last: FakeSocket | null = null
  static made = 0
  static readonly OPEN = 1
  readyState = 1
  sent: string[] = []
  closed = false
  #listeners = new Map<string, (event?: unknown) => void>()
  constructor() {
    FakeSocket.last = this
    FakeSocket.made += 1
  }
  addEventListener(kind: string, fn: (event?: unknown) => void): void {
    this.#listeners.set(kind, fn)
  }
  fire(kind: string, event?: unknown): void {
    this.#listeners.get(kind)?.(event)
  }
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
  types(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type)
  }
}

const originalSocket = globalThis.WebSocket
const originalFetch = globalThis.fetch

function useFakeSocket(): void {
  const ctor = vi.fn(function () {
    return new FakeSocket()
  })
  ;(ctor as unknown as { OPEN: number }).OPEN = 1
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = ctor
}

function setVisible(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

function comeBack(): void {
  setVisible('visible')
  document.dispatchEvent(new Event('visibilitychange'))
}

/** A server the probe can reach. */
function serverAnswers(): void {
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch
}

/** A server the probe cannot reach. */
function serverIsDown(): void {
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('down'))) as typeof fetch
}

/** A socket that opened and has heard the server beat. */
function liveSocket(): FakeSocket {
  connect()
  const ws = FakeSocket.last!
  ws.fire('open')
  ws.deliver({ type: 'ping' })
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.last = null
  FakeSocket.made = 0
  useStore.setState({ conn: 'connecting', reach: 'unknown', selected: null })
  useFakeSocket()
  serverAnswers()
  setVisible('visible')
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.WebSocket = originalSocket
  globalThis.fetch = originalFetch
})

describe('INV-4 coming back to the page is the event, not a timer', () => {
  it('reconnects at once instead of waiting out the backoff', () => {
    const ws = liveSocket()
    ws.close()
    // Past the first retry, deep into the backoff: the next attempt is seconds away.
    vi.advanceTimersByTime(600)
    FakeSocket.last!.close()
    const before = FakeSocket.made
    comeBack()
    expect(FakeSocket.made).toBe(before + 1)
  })

  it('closes a socket that slept past the beat, without waiting for the watchdog tick', () => {
    const ws = liveSocket()
    // Seventy seconds pass with the page awake: under the threshold, so the
    // watchdog's ticks leave the socket alone.
    vi.advanceTimersByTime(70_000)
    expect(ws.closed).toBe(false)
    // Then the phone sleeps: the clock moves and no timer fires, which is what
    // a suspended page looks like. Twenty more seconds of silence, unnoticed.
    vi.setSystemTime(Date.now() + 20_000)
    expect(ws.closed).toBe(false)
    comeBack()
    expect(ws.closed).toBe(true)
  })

  it('asks a socket that looks open, and drops it when nothing answers', () => {
    const ws = liveSocket()
    comeBack()
    expect(ws.types()).toContain('ping')
    vi.advanceTimersByTime(4_500)
    expect(ws.closed).toBe(true)
  })

  it('keeps the socket when the server answers the probe', () => {
    const ws = liveSocket()
    comeBack()
    ws.deliver({ type: 'pong' })
    vi.advanceTimersByTime(4_500)
    expect(ws.closed).toBe(false)
    expect(ws.types().filter((t) => t === 'ping')).toHaveLength(1)
  })

  it('does nothing for a page that is not visible', () => {
    const ws = liveSocket()
    setVisible('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(ws.types()).not.toContain('ping')
  })
})

describe('INV-11 a closed socket and an unreachable server are told apart', () => {
  it('names the server as unreachable when the probe fails', async () => {
    serverIsDown()
    const ws = liveSocket()
    ws.close()
    await vi.advanceTimersByTimeAsync(10)
    expect(useStore.getState().reach).toBe('unreachable')
  })

  it('reports it reachable again once a probe gets through', async () => {
    serverIsDown()
    const ws = liveSocket()
    ws.close()
    await vi.advanceTimersByTimeAsync(10)
    serverAnswers()
    comeBack()
    await vi.advanceTimersByTimeAsync(10)
    expect(useStore.getState().reach).toBe('reachable')
  })
})
