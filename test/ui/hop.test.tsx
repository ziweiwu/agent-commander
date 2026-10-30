/**
 * F3: "✋ 2 ›", the hand-off after an answer, and the ⌥ chords.
 *
 * Driven through the real transport over a fake socket, the way
 * `return.test.tsx` is, so "the socket is down" is the transport's own state
 * and an answer is a frame that was really written, rather than a mock that
 * was called. What is asserted about INV-2 is therefore about the wire: after
 * a hop, Enter writes no `answer`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { App, FleetRoute } from '../../src/web/components/App.tsx'
import { connect } from '../../src/web/store/transport.ts'
import { useStore } from '../../src/web/store/store.ts'
import type { Agent, PendingPrompt } from '../../src/shared/types.ts'
import { agent, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'

vi.mock('../../src/web/components/LazyTerminal.tsx', () => ({
  LazyPanePeek: () => null,
  LazyTerminal: () => <div data-testid="term-wrap" tabIndex={0} />,
}))

class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 1
  sent: string[] = []
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
  deliver(msg: unknown): void {
    this.fire('message', { data: JSON.stringify(msg) })
  }
  send(text: string): void {
    this.sent.push(text)
  }
  close(): void {
    this.readyState = 3
    this.fire('close')
  }
  answers(): number {
    return this.sent.filter((s) => (JSON.parse(s) as { type: string }).type === 'answer').length
  }
}

const originalSocket = globalThis.WebSocket
const originalFetch = globalThis.fetch

const NOW = Date.now()
const MINUTE = 60_000
/**
 * The open one; newest, so the list draws it first in the waiting group and
 * "next" reaches it last.
 */
const W1 = agent({
  sessionId: 'w1',
  name: 'first-blocked',
  status: 'waiting',
  paneId: '%1',
  lastActivityAt: NOW - MINUTE,
})
/** Blocked longest: what the chip, ⌥H and the hand-off all name from w1, wrapping round. */
const W2 = agent({
  sessionId: 'w2',
  name: 'second-blocked',
  status: 'waiting',
  paneId: '%2',
  lastActivityAt: NOW - 14 * MINUTE,
})
/** Between the two: what ⌥J opens from w1, since the list sorts newest first. */
const W3 = agent({
  sessionId: 'w3',
  name: 'third-blocked',
  status: 'waiting',
  paneId: '%3',
  lastActivityAt: NOW - 5 * MINUTE,
})
const IDLE = agent({
  sessionId: 'i1',
  name: 'quiet-one',
  status: 'idle',
  paneId: '%4',
  lastActivityAt: NOW - 1000,
})
const FLEET = [W1, W2, W3, IDLE]

const QUESTION: PendingPrompt = {
  tool: 'AskUserQuestion',
  question: 'Which migration should run first?',
  options: [{ label: 'Backfill the index' }, { label: 'Swap the table' }],
  id: 'prompt-one',
}

const DESKTOP = () => false
const NARROW = (query: string) => query.includes('max-width: 900px')

let where: { path: string; back: () => void } = { path: '', back: () => {} }

function Probe() {
  const location = useLocation()
  const navigate = useNavigate()
  where = { path: location.pathname, back: () => navigate(-1) }
  return null
}

function shell(...entries: string[]) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Probe />
      <Routes>
        <Route path="/*" element={<App />}>
          <Route index element={<FleetRoute />} />
          <Route path="agent/:sessionId" element={<FleetRoute />} />
          <Route path="agent/:sessionId/term" element={<FleetRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

/** A socket that opened and has delivered this fleet. */
function liveFleet(agents: Agent[] = FLEET): FakeSocket {
  connect()
  const ws = FakeSocket.last!
  ws.fire('open')
  ws.deliver({ type: 'fleet', agents, mock: false })
  return ws
}

/** The open agent's conversation, carrying the question it is blocked on. */
function ask(socket: FakeSocket, sessionId: string, prompt: PendingPrompt = QUESTION): void {
  act(() => socket.deliver({ type: 'timeline', sessionId, reset: true, events: [], prompt }))
}

function chord(target: Element, code: string, extra: Partial<KeyboardEventInit> = {}): void {
  fireEvent.keyDown(target, { key: '∆', code, altKey: true, ...extra })
}

beforeEach(() => {
  resetStore()
  useStore.setState({ conn: 'connecting', fleetAt: null })
  setViewport(DESKTOP)
  const ctor = vi.fn(function () {
    return new FakeSocket()
  })
  ;(ctor as unknown as { OPEN: number }).OPEN = 1
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = ctor
  globalThis.fetch = vi.fn(() =>
    Promise.resolve(new Response('{"trees":[]}', { status: 200 })),
  ) as typeof fetch
})

afterEach(() => {
  globalThis.WebSocket = originalSocket
  globalThis.fetch = originalFetch
})

describe('F3 the waiting chip is drawn only where the list is not', () => {
  it('is absent beside the list on a desktop', () => {
    liveFleet()
    shell('/agent/w1')
    expect(screen.getByTestId('fleet-list')).toBeTruthy()
    expect(screen.queryByTestId('waiting-chip')).toBeNull()
  })

  it('takes the filters’ slot once the column is collapsed', () => {
    liveFleet()
    useStore.setState({ sidebar: 'collapsed' })
    shell('/agent/w1')
    expect(screen.queryByTestId('fleet-list')).toBeNull()
    expect(screen.getAllByTestId('waiting-chip')).toHaveLength(1)
  })

  it('rides in the sheet’s topbar on a phone', () => {
    setViewport(NARROW)
    liveFleet()
    shell('/agent/w1')
    expect(screen.getAllByTestId('waiting-chip')).toHaveLength(1)
  })

  it('moves into the full-screen header, once', () => {
    liveFleet()
    useStore.setState({ fullscreen: true })
    shell('/agent/w1')
    const chips = screen.getAllByTestId('waiting-chip')
    expect(chips).toHaveLength(1)
    expect(within(screen.getByTestId('fullscreen-view')).getByTestId('waiting-chip')).toBe(chips[0])
  })

  it('counts the other agents and names the next, in both languages', () => {
    setViewport(NARROW)
    liveFleet()
    shell('/agent/w1')
    const chip = screen.getByTestId('waiting-chip')
    expect(chip.textContent).toContain('2')
    expect(chip.getAttribute('aria-label')).toBe(
      '2 other agents need you — open «second-blocked», waiting 14m',
    )
    act(() => useStore.getState().setLang('zh-CN'))
    expect(screen.getByTestId('waiting-chip').getAttribute('aria-label')).toBe(
      '还有 2 个代理需要你 — 打开「second-blocked」，已等待 14 分钟',
    )
  })

  it('is absent when no other agent needs you', () => {
    setViewport(NARROW)
    liveFleet([W1, IDLE])
    shell('/agent/w1')
    expect(screen.queryByTestId('waiting-chip')).toBeNull()
  })

  it('goes muted and says "as of" while the socket is down', () => {
    setViewport(NARROW)
    const ws = liveFleet()
    shell('/agent/w1')
    expect(screen.getByTestId('waiting-chip').dataset.stale).toBeUndefined()
    act(() => ws.close())
    const chip = screen.getByTestId('waiting-chip')
    expect(chip.dataset.stale).toBe('true')
    expect(chip.textContent).toContain('as of')
    expect(chip.getAttribute('aria-label')).toContain('as of')
  })

  it('opens the next on the Chat tab by replacing the entry, so back lands on the fleet', async () => {
    const user = userEvent.setup()
    setViewport(NARROW)
    liveFleet()
    shell('/', '/agent/w1')
    await user.click(screen.getByTestId('waiting-chip'))
    expect(where.path).toBe('/agent/w2')
    act(() => where.back())
    expect(where.path).toBe('/')
  })
})

describe('F3 the ⌥ chords', () => {
  it('⌥J from the composer opens the next agent in the list', () => {
    liveFleet()
    shell('/', '/agent/w1')
    chord(screen.getByTestId('composer-input'), 'KeyJ')
    expect(where.path).toBe('/agent/w3')
    chord(screen.getByTestId('composer-input'), 'KeyK')
    expect(where.path).toBe('/agent/w1')
  })

  it('walks the list with the column collapsed, wrapping round', () => {
    liveFleet()
    useStore.setState({ sidebar: 'collapsed' })
    shell('/agent/i1')
    chord(document.body, 'KeyJ')
    expect(where.path).toBe('/agent/w1')
  })

  it('keeps the tab the reader is on', () => {
    liveFleet()
    shell('/agent/w1/term')
    chord(document.body, 'KeyJ')
    expect(where.path).toBe('/agent/w3/term')
  })

  it('ignores a chord while an input method is composing', () => {
    liveFleet()
    shell('/agent/w1')
    chord(screen.getByTestId('composer-input'), 'KeyJ', { isComposing: true })
    expect(where.path).toBe('/agent/w1')
  })

  it('leaves every key inside the terminal to the agent', () => {
    liveFleet()
    shell('/agent/w1/term')
    chord(screen.getByTestId('term-wrap'), 'KeyJ')
    chord(screen.getByTestId('term-wrap'), 'KeyH')
    expect(where.path).toBe('/agent/w1/term')
  })

  it('matches the physical key, not the character Option makes of it', () => {
    liveFleet()
    shell('/agent/w1')
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyN', altKey: true })
    expect(where.path).toBe('/agent/w1')
  })

  it('⌥H opens the agent blocked longest, or says nothing needs you', () => {
    liveFleet()
    shell('/agent/w1')
    chord(document.body, 'KeyH')
    expect(where.path).toBe('/agent/w2')
    act(() => FakeSocket.last!.deliver({ type: 'fleet', agents: [W2, IDLE], mock: false }))
    chord(document.body, 'KeyH')
    expect(where.path).toBe('/agent/w2')
    expect(screen.getByTestId('toast').textContent).toBe('Nothing needs you')
  })
})

describe('F3 the hand-off after an answer', () => {
  it('names the agent blocked longest under the spent card, and goes nowhere by itself', async () => {
    const user = userEvent.setup()
    const ws = liveFleet()
    shell('/agent/w1')
    ask(ws, 'w1')
    expect(screen.queryByTestId('answer-next')).toBeNull()
    await user.click(screen.getAllByTestId('answer-option')[0]!)
    expect(ws.answers()).toBe(1)
    const next = screen.getByTestId('answer-next')
    expect(next.textContent).toContain('Next: second-blocked · waiting 14m')
    expect(next.textContent).toContain('⌥H')
    expect(where.path).toBe('/agent/w1')
  })

  it('stays after the card has gone, for the next scan', async () => {
    const user = userEvent.setup()
    const ws = liveFleet()
    shell('/agent/w1')
    ask(ws, 'w1')
    await user.click(screen.getAllByTestId('answer-option')[0]!)
    act(() => ws.deliver({ type: 'fleet', agents: [{ ...W1, status: 'busy' }, W2, W3, IDLE], mock: false }))
    expect(screen.queryByTestId('answer-card')).toBeNull()
    expect(screen.getByTestId('answer-next')).toBeTruthy()
  })

  it('lands on the question, not option 1, so a habitual Enter answers nothing (INV-2)', async () => {
    const user = userEvent.setup()
    const ws = liveFleet()
    shell('/', '/agent/w1')
    ask(ws, 'w1')
    await user.click(screen.getAllByTestId('answer-option')[0]!)
    await user.click(screen.getByTestId('answer-next'))
    expect(where.path).toBe('/agent/w2')
    ask(ws, 'w2', { ...QUESTION, id: 'prompt-two' })
    expect(document.activeElement).toBe(screen.getByTestId('answer-question'))
    await user.keyboard('{Enter}')
    expect(ws.answers()).toBe(1)
    act(() => where.back())
    expect(where.path).toBe('/')
  })

  it('lands on the question after a chord too', async () => {
    const user = userEvent.setup()
    const ws = liveFleet()
    shell('/agent/w1')
    chord(document.body, 'KeyH')
    ask(ws, 'w2')
    expect(document.activeElement).toBe(screen.getByTestId('answer-question'))
    await user.keyboard('{Enter}')
    expect(ws.answers()).toBe(0)
  })

  it('still lands on option 1 when the agent was opened by its card', () => {
    const ws = liveFleet()
    shell('/agent/w1')
    ask(ws, 'w1')
    expect(document.activeElement).toBe(screen.getAllByTestId('answer-option')[0])
  })
})

/**
 * R5: one "next". The chip, the button under a spent answer and ⌥H used to
 * follow two orders — the list's newest-first sort and the oldest block — so
 * the two controls on screen after an answer opened opposite ends of the queue,
 * and ⌥H pressed again bounced between the two oldest for ever.
 */
describe('R5 the chip, the hand-off and ⌥H name one "next"', () => {
  it('after an answer on a phone, the chip and the Next button name the same agent', async () => {
    const user = userEvent.setup()
    setViewport(NARROW)
    const ws = liveFleet()
    shell('/agent/w1')
    ask(ws, 'w1')
    await user.click(screen.getAllByTestId('answer-option')[0]!)
    expect(screen.getByTestId('waiting-chip').getAttribute('aria-label')).toContain('«second-blocked»')
    expect(screen.getByTestId('answer-next').textContent).toContain('Next: second-blocked')
  })

  it('from an agent that is not waiting, the chip and ⌥H both open the one blocked longest', () => {
    liveFleet()
    useStore.setState({ sidebar: 'collapsed' })
    shell('/agent/i1')
    expect(screen.getByTestId('waiting-chip').getAttribute('aria-label')).toContain('«second-blocked»')
    chord(document.body, 'KeyH')
    expect(where.path).toBe('/agent/w2')
  })

  it('⌥H pressed again and again walks every waiting agent, oldest first, and wraps round', () => {
    liveFleet()
    shell('/agent/i1')
    const visited: string[] = []
    for (let press = 0; press < 4; press++) {
      chord(document.body, 'KeyH')
      visited.push(where.path)
    }
    expect(visited).toEqual(['/agent/w2', '/agent/w3', '/agent/w1', '/agent/w2'])
  })

  it('the chip tapped again and again walks the same ring', async () => {
    const user = userEvent.setup()
    liveFleet()
    useStore.setState({ sidebar: 'collapsed' })
    shell('/agent/i1')
    const visited: string[] = []
    for (let tap = 0; tap < 4; tap++) {
      await user.click(screen.getByTestId('waiting-chip'))
      visited.push(where.path)
    }
    expect(visited).toEqual(['/agent/w2', '/agent/w3', '/agent/w1', '/agent/w2'])
  })
})
