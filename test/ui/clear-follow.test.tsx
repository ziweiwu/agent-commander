/**
 * The route follows an agent whose session id has turned over.
 *
 * `/clear` replaces a session rather than editing it. The button's clear is
 * told the new id by the server; a `/clear` typed into the message box or into
 * the terminal is text like any other and reports nothing, so the old id just
 * stops being listed. The route used to read that as "the agent ended while it
 * was open" and bounce to the fleet — which, from the user's side, was the
 * panel closing itself every time they cleared. Now it finds the agent again by
 * its process and goes there, keeping the panel up in between.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { App, FleetRoute } from '../../src/web/components/App.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  answerPrompt: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
  setAgentModel: vi.fn(),
  setGoal: vi.fn(),
  clearGoal: vi.fn(),
  sendShiftTab: vi.fn(),
  closeAgentById: vi.fn(),
  closeAgent: vi.fn(),
  fetchTree: vi.fn(),
}))

const PID = 4421
const before = agent({ sessionId: 'before', pid: PID, paneId: '%7' })
const after = agent({ sessionId: 'after', pid: PID, paneId: '%7' })
const bystander = agent({ sessionId: 'bystander', pid: PID + 1, paneId: '%9' })

/** Longer than the route waits for an agent to come back. */
const PAST_THE_WAIT_MS = 9_000

function Path() {
  return <div data-testid="path">{useLocation().pathname}</div>
}

function shell(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Path />
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

const path = () => screen.getByTestId('path').textContent

/** The next fleet frame. */
function fleet(agents: ReturnType<typeof agent>[]): void {
  act(() => {
    useStore.setState({ agents, fleetAt: Date.now() })
  })
}

beforeEach(() => {
  resetStore()
  useStore.setState({ agents: [before, bystander], selected: 'before' })
})

describe('after a /clear the browser was not told about', () => {
  it('follows the agent to the id it is now running', () => {
    shell('/agent/before')
    expect(screen.getByTestId('agent-detail')).toBeTruthy()

    fleet([bystander, after])

    expect(path()).toBe('/agent/after')
    expect(screen.getByTestId('agent-detail')).toBeTruthy()
  })

  it('stays on the terminal if that is where it was', () => {
    shell('/agent/before/term')
    fleet([bystander, after])
    expect(path()).toBe('/agent/after/term')
  })

  it('keeps the panel up through the gap before the new id is listed', () => {
    vi.useFakeTimers()
    try {
      shell('/agent/before')
      // The frame that dropped the old id, before the scan that lists the new.
      fleet([bystander])
      expect(path()).toBe('/agent/before')
      expect(screen.getByTestId('agent-detail')).toBeTruthy()

      fleet([bystander, after])
      expect(path()).toBe('/agent/after')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up on an agent that never comes back, and says so by leaving', () => {
    vi.useFakeTimers()
    try {
      shell('/agent/before')
      fleet([bystander])
      expect(path()).toBe('/agent/before')

      act(() => {
        vi.advanceTimersByTime(PAST_THE_WAIT_MS)
      })
      expect(path()).toBe('/')
      expect(screen.queryByTestId('agent-detail')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not follow a reused pid into another pane', () => {
    vi.useFakeTimers()
    try {
      shell('/agent/before')
      fleet([bystander, agent({ sessionId: 'stranger', pid: PID, paneId: '%8' })])
      expect(path()).toBe('/agent/before')
      act(() => {
        vi.advanceTimersByTime(PAST_THE_WAIT_MS)
      })
      expect(path()).toBe('/')
    } finally {
      vi.useRealTimers()
    }
  })

  // The rule this is an exception to: an id this page never saw is not an
  // agent that ended, it is a link that is wrong, and waiting would show a
  // blank panel for a session that does not exist.
  it('still bounces at once from an id it never saw', () => {
    shell('/agent/never')
    expect(path()).toBe('/')
  })
})
