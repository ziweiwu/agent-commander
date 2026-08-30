/**
 * Two views over one fleet, and the choice between them.
 *
 * The card list is not deprecated by the forest — they answer different
 * questions. The list says what each agent is *doing*; the forest says whether
 * anything in a family is still moving, which a list structurally cannot,
 * because a session that delegates stops writing its own transcript and looks
 * exactly like one that died.
 *
 * So the pair has to stay a genuine choice: both reachable, the choice
 * remembered, and neither able to leave the other unreachable. These tests pin
 * that, and they are also what would catch the switch silently defaulting back
 * after a preference-format change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { agent, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  sendConfirmedKey: vi.fn(),
  flushText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  fetchTree: vi.fn(async () => ({ changed: false, etag: null, trees: [] })),
}))

const FLEET = [
  agent({ sessionId: 'mock-busy', name: 'terminal-system-monitor-50', status: 'busy' }),
  agent({ sessionId: 'mock-idle', name: 'kb-operational-hardening', status: 'idle' }),
]

async function fleetRouteWith(view: 'forest' | 'legacy') {
  const { FleetRoute } = await import('../../src/web/components/App.tsx')
  const { useStore } = await import('../../src/web/store/store.ts')
  useStore.setState({ agents: FLEET, view })
  render(
    <MemoryRouter initialEntries={['/']}>
      <FleetRoute />
    </MemoryRouter>,
  )
}

/*
 * `localStorage` is absent in this environment, and `prefs.ts` swallows that on
 * purpose — Safari private mode throws the same way, and a preference that
 * cannot stick is not worth a crash. But swallowing it here would make the two
 * persistence assertions below pass without testing anything, so this file
 * supplies a real one.
 */
const store = new Map<string, string>()
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
}

beforeEach(() => {
  resetStore()
  store.clear()
  vi.stubGlobal('localStorage', fakeStorage)
})

describe('choosing between the two fleet views', () => {
  it('draws the forest, and not the card list, when the forest is chosen', async () => {
    await fleetRouteWith('forest')

    expect(screen.getByTestId('forest-view')).toBeTruthy()
    expect(screen.queryByTestId('fleet-list')).toBeNull()
  })

  it('draws the card list, and not the forest, when cards are chosen', async () => {
    await fleetRouteWith('legacy')

    expect(screen.getByTestId('fleet-list')).toBeTruthy()
    expect(screen.queryByTestId('forest-view')).toBeNull()
  })

  it('remembers the choice across a reload', async () => {
    const { saveView, loadView, DEFAULT_VIEW } = await import('../../src/web/lib/prefs.ts')

    expect(loadView()).toBe(DEFAULT_VIEW)
    saveView('legacy')
    expect(loadView()).toBe('legacy')
  })

  it('falls back to the default rather than crashing on a value it does not know', async () => {
    const { loadView, DEFAULT_VIEW } = await import('../../src/web/lib/prefs.ts')

    // A preference written by a future version, or by hand.
    fakeStorage.setItem('agent-commander.view', 'constellation')

    expect(loadView()).toBe(DEFAULT_VIEW)
  })

  it('shows the same agents either way, so neither view can hide one', async () => {
    await fleetRouteWith('legacy')
    const inList = screen.getAllByTestId('agent-card').length

    resetStore()
    document.body.innerHTML = ''
    await fleetRouteWith('forest')
    const inForest = screen.getAllByTestId('forest-family').length

    expect(inForest).toBe(inList)
    expect(inForest).toBe(FLEET.length)
  })
})
