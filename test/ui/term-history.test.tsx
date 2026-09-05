/**
 * Earlier output on the Attach tab: the pane's scrollback, on request.
 *
 * INV-4 in the browser's half. One press is one request, the next page is
 * asked for only once the last has answered, and nothing is re-asked on a
 * reconnect or carried to another agent. The lines render on a surface of
 * their own, so the live capture's fixed grid is never touched.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { ClientMessage } from '../../src/shared/types.ts'
import { useStore, withPage } from '../../src/web/store/store.ts'
import {
  HISTORY_DEPTH,
  HISTORY_PAGE,
  connect,
  focusAgent,
  requestHistory,
} from '../../src/web/store/transport.ts'
import { Terminal } from '../../src/web/components/Terminal.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'

const sent: ClientMessage[] = []
const sockets: FakeSocket[] = []

class FakeSocket {
  static readonly OPEN = 1
  readyState = 1
  readonly listeners = new Map<string, Array<(e: unknown) => void>>()
  constructor(readonly url: unknown) {
    sockets.push(this)
  }
  send(raw: string): void {
    sent.push(JSON.parse(raw) as ClientMessage)
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
}

const live = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket

/** Only the history requests: mounting the terminal sends its own attach. */
const requests = (): ClientMessage[] => sent.filter((m) => m.type === 'history')

function arrives(msg: object): void {
  live().fire('message', { data: JSON.stringify(msg) })
}

const request = (before: number): ClientMessage => ({
  type: 'history',
  sessionId: 'a',
  before,
  lines: HISTORY_PAGE,
})

const TOTAL = 5
const older = ['line -5', 'line -4']
const nearest = ['line -3', 'line -2', 'line -1']

const A = agent({ sessionId: 'a', status: 'idle', paneId: '%1' })

beforeAll(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 400, configurable: true })
  connect()
  live().fire('open')
})

beforeEach(() => {
  resetStore()
  useStore.setState({ selected: 'a', tab: 'attach', exited: [] })
  sent.length = 0
})

describe('withPage joins pages where they meet', () => {
  const held = { sessionId: 'a', lines: nearest, total: TOTAL }

  it('starts over on a first page and prepends the page that joins on', () => {
    expect(withPage(null, { sessionId: 'a', before: 0, lines: nearest, total: TOTAL })).toEqual(held)
    expect(withPage(held, { sessionId: 'a', before: 3, lines: older, total: TOTAL })).toEqual({
      sessionId: 'a',
      lines: [...older, ...nearest],
      total: TOTAL,
    })
  })

  it('drops a page that does not join on, or belongs to another agent', () => {
    expect(withPage(held, { sessionId: 'a', before: 9, lines: older, total: TOTAL })).toEqual(held)
    expect(withPage(held, { sessionId: 'b', before: 3, lines: older, total: TOTAL })).toEqual(held)
    expect(withPage(null, { sessionId: 'a', before: 3, lines: older, total: TOTAL })).toBeNull()
  })
})

describe('INV-4 one press is one request', () => {
  it('asks for the first page, and for nothing else until it answers', () => {
    expect(requestHistory()).toBe(true)
    expect(requestHistory()).toBe(false)
    expect(sent).toEqual([request(0)])
    expect(useStore.getState().historyPending).toBe(true)
  })

  it('asks for the page above the held lines once the last has answered', () => {
    requestHistory()
    arrives({ type: 'history', sessionId: 'a', before: 0, lines: nearest, total: TOTAL })
    expect(useStore.getState().history).toEqual({ sessionId: 'a', lines: nearest, total: TOTAL })
    expect(useStore.getState().historyPending).toBe(false)
    requestHistory()
    expect(sent).toEqual([request(0), request(nearest.length)])
  })

  it('sends nothing with no agent selected', () => {
    useStore.setState({ selected: null })
    expect(requestHistory()).toBe(false)
    expect(sent).toEqual([])
  })

  it('lets the next press through after a refusal', () => {
    requestHistory()
    arrives({
      type: 'error',
      sessionId: 'a',
      kind: 'history-failed',
      message: 'could not read earlier output',
    })
    expect(useStore.getState().historyPending).toBe(false)
    expect(requestHistory()).toBe(true)
  })

  /*
   * One request is outstanding at a time, so the latch has to be released by
   * the failure of *this* read and nothing else. Released by any error naming
   * the agent, an unrelated one — a dead pane, a run of failed frame reads —
   * let the reply still on its way be dropped, and the press was lost with
   * nothing said (INV-11).
   */
  it('keeps waiting through an error that is not this read failing', () => {
    requestHistory()
    arrives({ type: 'error', sessionId: 'a', kind: 'pane-exited', message: 'pane has exited' })
    expect(useStore.getState().historyPending).toBe(true)

    arrives({ type: 'history', sessionId: 'a', before: 0, lines: nearest, total: TOTAL })
    expect(useStore.getState().history).toEqual({ sessionId: 'a', lines: nearest, total: TOTAL })
  })

  /*
   * The server clamps how far above the screen it will start, so past that
   * depth every request comes back for a window already on screen, which
   * cannot be joined on. Asking anyway made the button do nothing at all,
   * silently, on any pane deeper than this — and a real one here holds 11,973
   * lines.
   */
  it('stops asking at the depth it can reach, rather than asking for nothing', () => {
    const deep = Array.from({ length: HISTORY_DEPTH }, (_, i) => `line ${i}`)
    useStore.setState({ history: { sessionId: 'a', lines: deep, total: 11_973 } })
    expect(requestHistory()).toBe(false)
    expect(sent).toEqual([])
  })
})

describe('a reply belongs to the agent it was asked for', () => {
  it('ignores a page for an agent this tab is not looking at', () => {
    arrives({ type: 'history', sessionId: 'b', before: 0, lines: nearest, total: TOTAL })
    expect(useStore.getState().history).toBeNull()
  })

  it('drops the held lines on leaving the agent, and re-asks for nothing on reconnect', () => {
    requestHistory()
    arrives({ type: 'history', sessionId: 'a', before: 0, lines: nearest, total: TOTAL })
    sent.length = 0
    live().fire('open')
    expect(sent).toEqual([{ type: 'focus', sessionId: 'a' }])
    focusAgent('b')
    expect(useStore.getState().history).toBeNull()
    expect(useStore.getState().historyPending).toBe(false)
  })
})

describe('the surface', () => {
  const noop = (): void => {}

  it('offers the control, and a press is the request', () => {
    renderApp(<Terminal agent={A} onExit={noop} />)
    expect(screen.queryByTestId('term-history')).toBeNull()
    fireEvent.click(screen.getByTestId('history-toggle'))
    expect(requests()).toEqual([request(0)])
  })

  /*
   * FR-CTL-12: one control, one place. The key bar's button relabelled itself
   * to "Hide earlier output" while the panel drew a button with those exact
   * words and that exact action a couple of inches away.
   */
  it('offers one way to hide the panel, not two', () => {
    useStore.setState({ history: { sessionId: 'a', lines: nearest, total: TOTAL } })
    renderApp(<Terminal agent={A} onExit={noop} />)
    expect(screen.queryAllByTestId('history-toggle')).toHaveLength(0)
    expect(screen.queryAllByTestId('history-hide')).toHaveLength(1)
    expect(screen.queryAllByText(/hide earlier output/i)).toHaveLength(1)
  })

  it('draws the held lines above the live capture, and says how many', () => {
    useStore.setState({ history: { sessionId: 'a', lines: [...older, ...nearest], total: TOTAL } })
    renderApp(<Terminal agent={A} onExit={noop} />)
    const history = screen.getByTestId('term-history')
    expect(screen.getByTestId('history-caption').textContent).toContain('5 lines')
    // The history sits above the pane, never inside it.
    const order = Array.from(screen.getByTestId('terminal').children)
    expect(order.indexOf(history)).toBeLessThan(order.indexOf(screen.getByTestId('term-wrap')))
    expect(screen.getByTestId('term-wrap').contains(history)).toBe(false)
    // Everything the pane holds is on screen, so there is no earlier to ask for.
    expect((screen.getByTestId('history-more') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('history-hide'))
    expect(useStore.getState().history).toBeNull()
    expect(screen.queryAllByTestId('history-toggle')).toHaveLength(1)
  })

  it('still offers earlier output for a pane that has exited', () => {
    useStore.setState({ exited: ['a'] })
    renderApp(<Terminal agent={A} onExit={noop} />)
    const toggle = screen.getByTestId('history-toggle') as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
    fireEvent.click(toggle)
    expect(requests()).toEqual([request(0)])
  })

  it('says so when the pane holds nothing above its screen', () => {
    useStore.setState({ history: { sessionId: 'a', lines: [], total: 0 } })
    renderApp(<Terminal agent={A} onExit={noop} />)
    expect(screen.getByTestId('history-empty')).toBeTruthy()
  })

  /*
   * INV-11: "the pane has nothing older" and "this is as far back as the app
   * reads" are different claims, and only the pane can support the first.
   */
  it('distinguishes a drained pane from the depth it will read to', () => {
    const deep = Array.from({ length: HISTORY_DEPTH }, (_, i) => `line ${i}`)
    useStore.setState({ history: { sessionId: 'a', lines: deep, total: 11_973 } })
    const view = renderApp(<Terminal agent={A} onExit={noop} />)
    const more = () => screen.getByTestId('history-more') as HTMLButtonElement
    expect(more().disabled).toBe(true)
    expect(more().textContent).toMatch(/as far back/i)

    view.unmount()
    // Every line the pane holds is on screen: that end is the pane's word.
    useStore.setState({ history: { sessionId: 'a', lines: [...older, ...nearest], total: TOTAL } })
    renderApp(<Terminal agent={A} onExit={noop} />)
    expect(more().disabled).toBe(true)
    expect(more().textContent).toMatch(/no earlier output/i)
  })

  /*
   * The scroll box holds an `inert` capture, so without a tabindex there is no
   * way for a keyboard to reach the scroll at all — WCAG 2.1.1, and the rule
   * `audit:a11y` enforces as `scrollable-region-focusable`.
   */
  it('lets a keyboard reach the scroll, and speaks for the capture inside it', () => {
    useStore.setState({ history: { sessionId: 'a', lines: nearest, total: TOTAL } })
    renderApp(<Terminal agent={A} onExit={noop} />)
    const box = screen.getByRole('img', { name: /earlier output/i })
    expect(box.getAttribute('tabindex')).toBe('0')
    expect(box.querySelector('[inert]')).toBeTruthy()
  })
})
