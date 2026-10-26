/**
 * F6, through the transport: the divider is placed from how far a session had
 * been shown *before* this tab's own focus moved the record, and held there.
 *
 * Opening an agent tells the server it is on screen, and the server answers
 * within a round trip with a record that says it has been shown through now.
 * Read naively, every divider would vanish the moment it was drawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, focusAgent } from '../../src/web/store/transport.ts'
import { useStore } from '../../src/web/store/store.ts'
import { agent, resetStore } from './helpers.tsx'
import { buildMessages } from '../../src/web/lib/chat.ts'
import { dividerFor } from '../../src/web/lib/newSince.ts'

class FakeSocket {
  static last: FakeSocket | null = null
  static readonly OPEN = 1
  readyState = 1
  sent: string[] = []
  #listeners = new Map<string, (event?: unknown) => void>()
  constructor() {
    FakeSocket.last = this
  }
  addEventListener(kind: string, fn: (event?: unknown) => void): void {
    this.#listeners.set(kind, fn)
  }
  deliver(msg: unknown): void {
    this.#listeners.get('message')?.({ data: JSON.stringify(msg) })
  }
  send(text: string): void {
    this.sent.push(text)
  }
  close(): void {
    this.readyState = 3
  }
}

const original = globalThis.WebSocket
const SHOWN_AT = 1_786_600_000_000
const REPLIED_AT = SHOWN_AT + 60_000

beforeEach(() => {
  vi.useFakeTimers()
  resetStore()
  useStore.setState({ conn: 'connecting' })
  const ctor = vi.fn(function () {
    return new FakeSocket()
  })
  ;(ctor as unknown as { OPEN: number }).OPEN = 1
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = ctor
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.WebSocket = original
})

const frozenFleet = (lastActivityAt: number) => ({
  type: 'fleet',
  mock: false,
  caughtUp: false,
  agents: [agent({ sessionId: 'x', lastActivityAt })],
})
const caughtUpFleet = (lastActivityAt: number) => ({ ...frozenFleet(lastActivityAt), caughtUp: true })
const fleet = caughtUpFleet(REPLIED_AT)

/** A tab already connected to a caught-up server, then opening `x`, last shown through its latest activity. */
const warmOpen = (): FakeSocket => {
  connect()
  const socket = FakeSocket.last!
  socket.deliver(fleet)
  socket.deliver({ type: 'seen', seenThrough: { x: REPLIED_AT } })
  focusAgent('x')
  return socket
}

const divider = (events: Parameters<typeof buildMessages>[0]) => dividerFor(buildMessages(events), useStore.getState().visit)

describe('F6 the visit', () => {
  it('is how far the session had been shown when it was opened, not after', () => {
    connect()
    const socket = FakeSocket.last!
    socket.deliver(fleet)
    socket.deliver({ type: 'seen', seenThrough: { x: SHOWN_AT } })
    focusAgent('x')
    socket.deliver({ type: 'seen', seenThrough: { x: REPLIED_AT } })
    expect(useStore.getState().seenThrough).toEqual({ x: REPLIED_AT })
    expect(useStore.getState().visit).toMatchObject({ sessionId: 'x', seenThrough: SHOWN_AT, activityAt: REPLIED_AT })
  })

  it('on a cold load after the enricher idled, takes the catch-up that lands on the focused tab', () => {
    focusAgent('x')
    connect()
    const socket = FakeSocket.last!
    socket.deliver(frozenFleet(SHOWN_AT))
    socket.deliver({ type: 'seen', seenThrough: { x: SHOWN_AT } })
    socket.deliver({ type: 'seen', seenThrough: { x: REPLIED_AT } })
    socket.deliver(frozenFleet(REPLIED_AT))
    socket.deliver(caughtUpFleet(REPLIED_AT))
    socket.deliver(caughtUpFleet(REPLIED_AT + 2_000))
    expect(useStore.getState().visit).toMatchObject({ seenThrough: SHOWN_AT, activityAt: REPLIED_AT, following: false })
    expect(divider([{ id: 'a', at: REPLIED_AT, kind: 'assistant', text: 'Done.' }])?.before).toBe('a')
  })

  it('on a warm open, takes the agent going on two seconds later as nothing new', () => {
    const socket = warmOpen()
    socket.deliver(caughtUpFleet(REPLIED_AT + 2_000))
    expect(divider([
      { id: 'old', at: REPLIED_AT, kind: 'assistant', text: 'Done.' },
      { id: 'live', at: REPLIED_AT + 2_000, kind: 'assistant', text: 'And the tests pass.' },
    ])).toBeNull()
  })

  it('on a warm open, takes the reader’s own send as nothing new', () => {
    const socket = warmOpen()
    socket.deliver(caughtUpFleet(REPLIED_AT + 1_000))
    expect(divider([
      { id: 'old', at: REPLIED_AT, kind: 'assistant', text: 'Done.' },
      { id: 'mine', at: REPLIED_AT + 1_000, kind: 'user', text: 'now the docs' },
    ])).toBeNull()
  })

  it('on a cold load, is taken from the first record to arrive after the selection', () => {
    focusAgent('x')
    expect(useStore.getState().visit).toBeNull()
    connect()
    const socket = FakeSocket.last!
    socket.deliver(fleet)
    socket.deliver({ type: 'seen', seenThrough: { x: SHOWN_AT } })
    socket.deliver({ type: 'seen', seenThrough: { x: REPLIED_AT } })
    expect(useStore.getState().visit?.seenThrough).toBe(SHOWN_AT)
  })

  it('ends with the visit: the next selection starts from the record as it stands', () => {
    connect()
    const socket = FakeSocket.last!
    socket.deliver(fleet)
    socket.deliver({ type: 'seen', seenThrough: { x: SHOWN_AT } })
    focusAgent('x')
    socket.deliver({ type: 'seen', seenThrough: { x: REPLIED_AT } })
    focusAgent(null)
    focusAgent('x')
    expect(useStore.getState().visit?.seenThrough).toBe(REPLIED_AT)
  })
})
