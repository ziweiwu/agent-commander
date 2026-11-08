/**
 * FR-FLEET-11 and INV-11: nothing before the first live fleet frame reads as a
 * reading (round 3, R3).
 *
 * A cold start paints the fleet this browser last saw, and the socket opening
 * is not the server speaking. Between the two the remembered cards said "No
 * prompts yet" over agents mid-turn, the pill said "live" with the stale
 * caption gone, Prune offered to close sessions the snapshot had simply
 * forgotten the prompts of, and the composer and the answer card would type
 * into a pane nothing had confirmed still exists. A first visit with no
 * snapshot read "0 agents" above "Connecting…".
 *
 * Driven through the real transport over a fake socket, so "open but silent"
 * is the transport's own state rather than a store value set by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { App, FleetRoute } from '../../src/web/components/App.tsx'
import { connect } from '../../src/web/store/transport.ts'
import { initPreferences, useStore } from '../../src/web/store/store.ts'
import { saveFleetSnapshot } from '../../src/web/lib/prefs.ts'
import type { Agent, PendingPrompt } from '../../src/shared/types.ts'
import { agent, pastArrival, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'

vi.mock('../../src/web/components/LazyTerminal.tsx', () => ({
  LazyPanePeek: () => null,
  LazyTerminal: () => null,
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
}

const originalSocket = globalThis.WebSocket
const originalFetch = globalThis.fetch

const NOW = Date.now()
const MINUTE = 60_000

const BUSY = agent({
  sessionId: 'b1',
  name: 'rebuild-dist',
  status: 'busy',
  paneId: '%1',
  activity: 'Bash: npm run build',
  lastActivityAt: NOW - MINUTE,
})
const WAITING = agent({
  sessionId: 'w1',
  name: 'plan-the-migration',
  status: 'waiting',
  waitingFor: 'dialog open',
  paneId: '%2',
  activity: 'AskUserQuestion',
  lastActivityAt: NOW - 2 * MINUTE,
})
/** Opened and never prompted, as the snapshot remembers it: what Prune would close. */
const UNUSED = agent({ sessionId: 'i1', name: 'fresh-one', status: 'idle', paneId: '%3' })
const FLEET: Agent[] = [BUSY, WAITING, UNUSED]

const QUESTION: PendingPrompt = {
  tool: 'AskUserQuestion',
  question: 'Which migration should run first?',
  options: [{ label: 'Backfill the index' }, { label: 'Swap the table' }],
  id: 'prompt-one',
}

const DESKTOP = () => false

function stubStorage(): void {
  const kept = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
    clear: () => kept.clear(),
  })
}

function shell(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<App />}>
          <Route index element={<FleetRoute />} />
          <Route path="agent/:sessionId" element={<FleetRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

/** A cold start: the stored fleet painted, the socket open, and no frame yet. */
function coldStartOpenSilent(): FakeSocket {
  saveFleetSnapshot(FLEET, NOW - 5 * MINUTE)
  initPreferences()
  connect()
  const ws = FakeSocket.last!
  ws.fire('open')
  return ws
}

beforeEach(() => {
  stubStorage()
  resetStore()
  useStore.setState({ conn: 'connecting', fleetAt: null, agents: [], fleetLive: false } as never)
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
  vi.unstubAllGlobals()
})

const card = (sessionId: string): HTMLElement =>
  screen
    .getAllByTestId('agent-card')
    .find((el) => el.dataset.sessionId === sessionId) as HTMLElement

describe('FR-FLEET-11 a remembered fleet, socket open, before the first live frame', () => {
  it('says when each card was last seen, never "No prompts yet"', () => {
    coldStartOpenSilent()
    shell('/')
    expect(screen.getAllByTestId('agent-card')).toHaveLength(FLEET.length)
    expect(document.body.textContent).not.toMatch(/No prompts yet/)
    for (const { sessionId } of FLEET) {
      const line = within(card(sessionId)).getByTestId('agent-activity')
      expect(line.dataset.remembered).toBe('true')
      expect(line.textContent).toMatch(/^Last seen 5m ago — waiting for a live update$/)
    }
  })

  it('keeps the list captioned as a memory and the pill off "live"', () => {
    coldStartOpenSilent()
    shell('/')
    expect(screen.getByTestId('fleet-stale').textContent).toMatch(/last state received 5m ago/)
    expect(screen.getByTestId('fleet-list').dataset.stale).toBe('true')
    const pill = screen.getByTestId('connection-status')
    expect(pill.textContent).not.toBe('live')
    expect(pill.dataset.state).not.toBe('open')
  })

  it('disables Prune, which would close sessions on what the snapshot forgot', () => {
    coldStartOpenSilent()
    shell('/')
    expect((screen.getByTestId('prune-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('claims no reach and offers no Answer verb on a remembered card', () => {
    coldStartOpenSilent()
    shell('/')
    expect(document.body.textContent).not.toMatch(/terminal reachable/)
    expect(screen.queryByTestId('agent-answer-cta')).toBeNull()
  })

  it('holds Send and the answer options until the first live frame confirms the pane', () => {
    const ws = coldStartOpenSilent()
    shell('/agent/w1')
    act(() => ws.deliver({ type: 'timeline', sessionId: 'w1', reset: true, events: [], prompt: QUESTION }))
    for (const option of screen.getAllByTestId('answer-option')) {
      expect((option as HTMLButtonElement).disabled).toBe(true)
    }
    expect((screen.getByTestId('composer-send') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('composer-offline')).toBeTruthy()
  })
})

describe('FR-FLEET-11 the first live frame', () => {
  it('turns the memory into a reading: activity, pill, caption, Prune and Answer', () => {
    const ws = coldStartOpenSilent()
    shell('/agent/w1')
    act(() => ws.deliver({ type: 'fleet', agents: FLEET, mock: false }))
    act(() => ws.deliver({ type: 'timeline', sessionId: 'w1', reset: true, events: [], prompt: QUESTION }))
    expect(within(card('b1')).getByTestId('agent-activity').textContent).toBe('Bash: npm run build')
    expect(screen.queryByTestId('fleet-stale')).toBeNull()
    expect(screen.getByTestId('connection-status').textContent).toBe('live')
    expect((screen.getByTestId('prune-button') as HTMLButtonElement).disabled).toBe(false)
    for (const option of screen.getAllByTestId('answer-option')) {
      expect((option as HTMLButtonElement).disabled).toBe(false)
    }
  })

  it('stays the gate across a drop: a reconnect is live again at once, as before', () => {
    const ws = coldStartOpenSilent()
    shell('/')
    act(() => ws.deliver({ type: 'fleet', agents: FLEET, mock: false }))
    act(() => ws.close())
    expect(screen.getByTestId('fleet-stale').textContent).toMatch(/not connected/i)
    expect(screen.getByTestId('connection-status').dataset.state).toBe('closed')
    act(() => connect())
    act(() => FakeSocket.last!.fire('open'))
    expect(screen.queryByTestId('fleet-stale')).toBeNull()
    expect(screen.getByTestId('connection-status').textContent).toBe('live')
  })
})

describe('FR-FLEET-11 a card that has been live, through a drop', () => {
  it('keeps what the server last said, and is not repainted as a memory', () => {
    const ws = coldStartOpenSilent()
    shell('/')
    act(() => ws.deliver({ type: 'fleet', agents: FLEET, mock: false }))
    act(() => ws.close())
    const line = within(card('b1')).getByTestId('agent-activity')
    expect(line.textContent).toBe('Bash: npm run build')
    expect(line.dataset.remembered).toBeUndefined()
    expect(within(card('b1')).getByTestId('agent-reach').dataset.reach).toBe('reachable')
    expect(screen.getByTestId('agent-answer-cta')).toBeTruthy()
  })
})

describe('INV-2 the arrival guard, alongside the wait for the first live frame', () => {
  const askThenGoLive = (socket: FakeSocket): void => {
    act(() => socket.deliver({ type: 'timeline', sessionId: 'w1', reset: true, events: [], prompt: QUESTION }))
    act(() => socket.deliver({ type: 'fleet', agents: FLEET, mock: false }))
  }
  const answers = (socket: FakeSocket): number =>
    socket.sent.filter((text) => (JSON.parse(text) as { type: string }).type === 'answer').length

  it('still ignores a press inside the window the question arrived in', () => {
    const ws = coldStartOpenSilent()
    shell('/agent/w1')
    askThenGoLive(ws)
    fireEvent.click(screen.getAllByTestId('answer-option')[0] as HTMLElement)
    expect(answers(ws)).toBe(0)
  })

  it('writes nothing for a press before the frame, and one answer for a press after it', () => {
    const ws = coldStartOpenSilent()
    shell('/agent/w1')
    act(() => ws.deliver({ type: 'timeline', sessionId: 'w1', reset: true, events: [], prompt: QUESTION }))
    pastArrival()
    fireEvent.click(screen.getAllByTestId('answer-option')[0] as HTMLElement)
    expect(answers(ws)).toBe(0)
    act(() => ws.deliver({ type: 'fleet', agents: FLEET, mock: false }))
    fireEvent.click(screen.getAllByTestId('answer-option')[0] as HTMLElement)
    expect(answers(ws)).toBe(1)
  })
})

describe('FR-FLEET-11 a first visit names no count before the first frame', () => {
  it('draws no "0 agents" chip above "Connecting…"', () => {
    connect()
    act(() => FakeSocket.last!.fire('open'))
    shell('/')
    expect(screen.getByTestId('fleet-loading')).toBeTruthy()
    for (const chip of screen.queryAllByTestId('filter-chip')) {
      expect(chip.textContent ?? '').not.toMatch(/\d/)
    }
  })

  it('counts once the server has said', () => {
    connect()
    const ws = FakeSocket.last!
    act(() => ws.fire('open'))
    shell('/')
    act(() => ws.deliver({ type: 'fleet', agents: FLEET, mock: false }))
    const all = screen.getAllByTestId('filter-chip').find((chip) => chip.dataset.key === 'all')
    expect(all?.textContent).toMatch(/^3 agents$/)
  })
})

describe('FR-FLEET-11 in Chinese', () => {
  it('says when a remembered card was last seen', () => {
    useStore.getState().setLang('zh-CN')
    coldStartOpenSilent()
    shell('/')
    const line = within(card('b1')).getByTestId('agent-activity')
    expect(line.textContent).toBe('5 分钟前的记录 — 等待实时更新')
    expect(document.body.textContent).not.toMatch(/还没有任何指令/)
  })
})
