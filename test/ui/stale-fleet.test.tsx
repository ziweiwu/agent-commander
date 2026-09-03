/**
 * INV-11: the dashboard never asserts more than it knows.
 *
 * With the socket down, every card still holds the last values it was sent —
 * and each one is a claim about *now*: "busy", "waiting · dialog open", an
 * activity line, a relative timestamp that keeps ticking. The only thing that
 * changed was a chip in the header. For an app whose whole job is "which agent
 * needs me", acting on a card that went stale twenty minutes ago is the
 * failure that matters.
 *
 * The last known state is still the most useful thing on screen, so it is
 * muted and captioned rather than hidden.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { FleetList } from '../../src/web/components/FleetList.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  flushText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
}))

beforeEach(resetStore)

const shell = (): void => {
  renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)
}

describe('while the socket is open', () => {
  it('says nothing about staleness', () => {
    useStore.setState({ agents: [agent({ sessionId: 'a' })], conn: 'open', fleetAt: Date.now() })
    shell()
    expect(screen.queryByTestId('fleet-stale')).toBeNull()
    expect(screen.getByTestId('fleet-list').dataset.stale).toBeUndefined()
  })
})

/*
 * The first frame is the case the stale caption cannot cover: there is nothing
 * to caption yet. Over Tailscale on a phone the gap before it lands is
 * measured in seconds, and "No Claude Code sessions found" in that gap is a
 * guess wearing the words of a reading.
 */
describe('INV-11 before the first frame', () => {
  it('does not claim the fleet is empty while nothing has arrived', () => {
    useStore.setState({ agents: [], conn: 'connecting', fleetAt: null })
    shell()
    expect(screen.queryByTestId('empty-state')).toBeNull()
    const loading = screen.getByTestId('fleet-loading')
    expect(loading.textContent).toMatch(/connecting/i)
    expect(loading.getAttribute('role')).toBe('status')
  })

  it('still does not claim it while the socket is open but silent', () => {
    // Between `onopen` and the first fleet frame `conn` is already 'open', so
    // the gate has to be the frame, not the connection.
    useStore.setState({ agents: [], conn: 'open', fleetAt: null })
    shell()
    expect(screen.queryByTestId('empty-state')).toBeNull()
    expect(screen.getByTestId('fleet-loading')).toBeTruthy()
  })

  it('says empty only once the server has said zero', () => {
    useStore.setState({ agents: [], conn: 'open', fleetAt: Date.now() })
    shell()
    expect(screen.queryByTestId('fleet-loading')).toBeNull()
    expect(screen.getByTestId('empty-state').textContent).toMatch(/no claude code sessions/i)
  })
})

describe('while the socket is down', () => {
  it('says the cards are a memory, and when it stopped knowing', () => {
    useStore.setState({
      agents: [agent({ sessionId: 'a' })],
      conn: 'closed',
      fleetAt: Date.now() - 20 * 60_000,
    })
    shell()
    const note = screen.getByTestId('fleet-stale')
    expect(note.textContent).toMatch(/not connected/i)
    // The age is the point: "not connected" alone does not tell you whether to
    // trust what is on screen.
    expect(note.textContent).toMatch(/\d/)
  })

  it('marks the cards without hiding them', () => {
    useStore.setState({ agents: [agent({ sessionId: 'a' })], conn: 'closed', fleetAt: Date.now() })
    shell()
    expect(screen.getByTestId('fleet-list').dataset.stale).toBe('true')
    // Still readable: a disconnected dashboard is exactly when someone squints
    // at the last thing it knew.
    expect(screen.getAllByTestId('agent-card').length).toBe(1)
  })

  it('is announced, not just drawn', () => {
    useStore.setState({ agents: [agent({ sessionId: 'a' })], conn: 'closed', fleetAt: Date.now() })
    shell()
    expect(screen.getByTestId('fleet-stale').getAttribute('role')).toBe('status')
  })

  it('says nothing when there are no cards to mistrust', () => {
    useStore.setState({ agents: [], conn: 'closed', fleetAt: null })
    shell()
    // An empty fleet asserts nothing, so there is nothing to caveat — and
    // nothing to call empty either, since no frame ever said so.
    expect(screen.queryByTestId('fleet-stale')).toBeNull()
    expect(screen.queryByTestId('empty-state')).toBeNull()
  })

  it('still captions the fleet when it never heard a first time', () => {
    useStore.setState({ agents: [agent({ sessionId: 'a' })], conn: 'connecting', fleetAt: null })
    shell()
    expect(screen.getByTestId('fleet-stale').textContent).toMatch(/not connected/i)
  })
})
