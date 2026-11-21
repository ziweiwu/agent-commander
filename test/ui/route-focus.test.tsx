/**
 * A2+B4: say where you are, and put you back.
 *
 * Leaving an agent dropped focus on <body>: Esc from its composer unmounted
 * the box that held it, and a keyboard reader then needed 43 Tabs to reach the
 * eighth card again. On a phone opening an agent, opening Help and going back
 * all left focus on <body>, and the tab title never changed. Driven through the
 * real route tree, as `routes.tsx` builds it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom'
import { App, FleetRoute } from '../../src/web/components/App.tsx'
import { HelpRoute } from '../../src/web/components/HelpRoute.tsx'
import { nearestCard } from '../../src/web/hooks/useRouteFocus.ts'
import { useStore } from '../../src/web/store/store.ts'
import { agent, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'

vi.mock('../../src/web/store/transport.ts', async () => {
  const { useStore: store } = await import('../../src/web/store/store.ts')
  return {
    sendMessage: vi.fn(),
    sendKey: vi.fn(),
    sendConfirmedKey: vi.fn(),
    sendText: vi.fn(),
    loadEnv: vi.fn(),
    startAgent: vi.fn(),
    focusAgent: vi.fn((id: string | null) => store.setState({ selected: id })),
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
  }
})

vi.mock('../../src/web/components/LazyTerminal.tsx', () => ({
  LazyPanePeek: () => null,
  LazyTerminal: () => <div data-testid="term-wrap" tabIndex={0} />,
}))

const IDS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']
const MINUTE = 60_000
const FIFTH = 4

let navigateTo: NavigateFunction = () => {}

function Steer() {
  navigateTo = useNavigate()
  return null
}

function shell(startPath = '/') {
  return render(
    <MemoryRouter initialEntries={[startPath]}>
      <Steer />
      <Routes>
        <Route path="/*" element={<App />}>
          <Route index element={<FleetRoute />} />
          <Route path="agent/:sessionId" element={<FleetRoute />} />
          <Route path="help" element={<HelpRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

const card = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="agent-card"][data-session-id="${id}"]`) as HTMLElement

const flush = () => act(async () => {})

beforeEach(() => {
  resetStore()
  setViewport(() => false)
  useStore.setState({
    agents: IDS.map((id, index) =>
      agent({ sessionId: id, name: `agent-${id}`, paneId: `%${index}`, lastActivityAt: Date.now() - index * MINUTE }),
    ),
  })
})

describe('A2+B4 leaving an agent puts focus back on its card', () => {
  it('returns to the fifth card after Enter then Esc', async () => {
    const user = userEvent.setup()
    shell()
    const fifth = [...document.querySelectorAll<HTMLElement>('[data-testid="agent-card"]')][FIFTH] as HTMLElement
    const id = fifth.dataset.sessionId as string
    fifth.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('agent-detail')).toBeTruthy()
    screen.getByTestId('composer-input').focus()

    await user.keyboard('{Escape}')
    await flush()
    expect(screen.queryByTestId('agent-detail')).toBeNull()
    expect(document.activeElement).toBe(card(id))
  })

  it('returns there from the back button too', async () => {
    const user = userEvent.setup()
    shell('/agent/a3')
    await user.click(screen.getByTestId('back-button'))
    await flush()
    expect(document.activeElement).toBe(card('a3'))
  })

  it('lands on the nearest remaining card when the agent has gone', async () => {
    shell('/agent/a3')
    await flush()
    act(() => useStore.setState({ agents: useStore.getState().agents.filter((a) => a.sessionId !== 'a3') }))
    await act(async () => navigateTo('/'))
    await flush()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('agent-card')
  })

  it('leaves focus alone when something on the fleet already holds it', async () => {
    shell('/agent/a3')
    await flush()
    screen.getByTestId('search').focus()
    await act(async () => navigateTo('/'))
    await flush()
    expect(document.activeElement).toBe(screen.getByTestId('search'))
  })
})

const PHONE = (query: string) => query.includes('coarse') || query.includes('max-width')

describe('A2+B4 on a phone, focus moves to where you went', () => {
  it('puts focus on the agent’s heading when its card is tapped', async () => {
    setViewport(PHONE)
    const user = userEvent.setup()
    shell()
    await user.click(card('a2'))
    await flush()
    expect(document.activeElement).toBe(screen.getByTestId('detail-name'))
  })

  it('puts focus on Help’s heading, and back on the help button after it', async () => {
    setViewport(PHONE)
    const user = userEvent.setup()
    shell()
    await user.click(screen.getByTestId('help-button'))
    await flush()
    expect(document.activeElement?.tagName).toBe('H2')
    await user.click(screen.getByTestId('help-close'))
    await flush()
    expect(document.activeElement).toBe(screen.getByTestId('help-button'))
  })
})

describe('A2+B4 INV-3 the tab title says where you are, by a name that is not conversation', () => {
  it('names a given name, Help, and keeps the waiting count', async () => {
    useStore.setState({
      agents: [agent({ sessionId: 'n', name: 'deploy-bot', derivedName: false, status: 'waiting' })],
    })
    shell('/agent/n')
    await flush()
    expect(document.title).toBe('(1) deploy-bot · agent-commander')
    await act(async () => navigateTo('/help'))
    expect(document.title).toBe('(1) Help · agent-commander')
    await act(async () => navigateTo('/'))
    expect(document.title).toBe('(1) agent-commander')
  })

  it('names a made-up name by its folder and branch, never by its title', async () => {
    useStore.setState({
      agents: [
        agent({
          sessionId: 'd',
          name: 'ziweiwu-35',
          derivedName: true,
          folder: 'kb-vault',
          gitBranch: 'main',
          aiTitle: 'Fix the private thing',
        }),
      ],
    })
    shell('/agent/d')
    await flush()
    expect(document.title).toBe('kb-vault · main · agent-commander')
  })
})

describe('A2+B4 the nearest card', () => {
  const ORDER = ['a', 'b', 'c', 'd']
  it('takes the one below, then the one above, then gives up', () => {
    expect(nearestCard(ORDER, 'b', (id) => id !== 'b')).toBe('c')
    expect(nearestCard(ORDER, 'd', (id) => id !== 'd')).toBe('c')
    expect(nearestCard(ORDER, 'b', (id) => id === 'a')).toBe('a')
    expect(nearestCard(ORDER, 'b', () => false)).toBeNull()
  })
})
