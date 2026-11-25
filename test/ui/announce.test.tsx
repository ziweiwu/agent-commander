/**
 * A3: the page's one polite live region carries every spoken line, so a toast
 * and the connection are heard the way a blocked agent is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announce, clearAnnouncement } from '../../src/web/lib/announce.ts'
import { connect } from '../../src/web/store/transport.ts'
import { useStore } from '../../src/web/store/store.ts'

class FakeSocket {
  static last: FakeSocket | null = null
  static readonly OPEN = 1
  readyState = 1
  #listeners = new Map<string, (event?: unknown) => void>()
  constructor() {
    FakeSocket.last = this
  }
  addEventListener(kind: string, fn: (event?: unknown) => void): void {
    this.#listeners.set(kind, fn)
  }
  fire(kind: string): void {
    this.#listeners.get(kind)?.()
  }
  send(): void {}
  close(): void {
    this.readyState = 3
    this.fire('close')
  }
}

const originalSocket = globalThis.WebSocket
const originalFetch = globalThis.fetch
let region: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  region = document.createElement('div')
  region.id = 'live-region'
  document.body.append(region)
  const ctor = vi.fn(function () {
    return new FakeSocket()
  })
  ;(ctor as unknown as { OPEN: number }).OPEN = 1
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = ctor
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('down'))) as typeof fetch
  useStore.setState({ lang: 'en', conn: 'connecting', reach: 'unknown', toast: null })
})

afterEach(() => {
  region.remove()
  vi.useRealTimers()
  globalThis.WebSocket = originalSocket
  globalThis.fetch = originalFetch
})

async function frame(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20)
}

describe('announce', () => {
  it('clears the region and sets the text on the next frame', async () => {
    region.textContent = 'old'
    announce('hello')
    expect(region.textContent).toBe('')
    await frame()
    expect(region.textContent).toBe('hello')
  })

  it('says the same line twice by clearing in between', async () => {
    announce('same')
    await frame()
    announce('same')
    expect(region.textContent).toBe('')
    await frame()
    expect(region.textContent).toBe('same')
  })
})

describe('announce before the page has mounted its region', () => {
  it('waits for the region rather than dropping the line', async () => {
    region.remove()
    announce('early')
    await frame()
    document.body.append(region)
    await frame()
    expect(region.textContent).toBe('early')
  })
})

describe('changing language', () => {
  it('drops a line spoken in the old one', async () => {
    announce('2 agents need you: a, b')
    await frame()
    useStore.getState().setLang('zh-CN')
    expect(region.textContent).toBe('')
    useStore.getState().setLang('en')
  })

  it('drops a line announced in the same frame as the clear', async () => {
    announce('2 agents need you: a, b')
    clearAnnouncement()
    await frame()
    expect(region.textContent).toBe('')
  })
})

describe('a toast goes through the live region', () => {
  it('writes its message there and the visible toast is not a second status', async () => {
    useStore.getState().showToast('Could not send')
    await frame()
    expect(region.textContent).toBe('Could not send')
  })
})

describe('the connection is spoken only when it stayed down', () => {
  function liveSocket(): FakeSocket {
    connect()
    const ws = FakeSocket.last!
    ws.fire('open')
    return ws
  }

  it('says nothing for a drop that recovers within five seconds', async () => {
    const ws = liveSocket()
    ws.close()
    await vi.advanceTimersByTimeAsync(2000)
    liveSocket()
    await vi.advanceTimersByTimeAsync(6000)
    expect(region.textContent).toBe('')
  })

  it('says it lost the connection after five seconds, and that it is back once', async () => {
    const ws = liveSocket()
    ws.close()
    await vi.advanceTimersByTimeAsync(5100)
    expect(region.textContent).toBe('Connection lost. Reconnecting.')
    FakeSocket.last!.fire('open')
    await vi.advanceTimersByTimeAsync(50)
    expect(region.textContent).toBe('Connected again.')
  })

  it('says it in Chinese', async () => {
    useStore.setState({ lang: 'zh-CN' })
    const ws = liveSocket()
    ws.close()
    await vi.advanceTimersByTimeAsync(5100)
    expect(region.textContent).toBe('连接已断开，正在重连。')
  })

  it('says signed out rather than reconnecting when the server answers 401', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('no', { status: 401 })),
    ) as typeof fetch
    const ws = liveSocket()
    ws.close()
    await vi.advanceTimersByTimeAsync(5100)
    expect(region.textContent).toBe('signed out — open your saved link again')
  })
})
