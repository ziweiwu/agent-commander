import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FleetList } from '../../src/web/components/FleetList.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
}))

const FLEET = [
  agent({ sessionId: 'w', name: 'blog-redesign', status: 'waiting', waitingFor: 'dialog open' }),
  agent({ sessionId: 'b', name: 'monitor-50', status: 'busy', activity: 'Task → sweep' }),
  agent({ sessionId: 'i', name: 'lego-scraper', status: 'idle', cwd: '/Users/me/Projects/lego-deals', folder: 'lego-deals' }),
]

beforeEach(resetStore)

describe('FleetList', () => {
  it('groups agents with the blocked one first', () => {
    useStore.setState({ agents: FLEET })
    renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)

    const titles = screen.getAllByTestId('group-title').map((el) => el.textContent)
    expect(titles).toEqual(['Needs you', 'Working', 'Idle'])
  })

  it('shows why an agent is blocked on its card', () => {
    useStore.setState({ agents: FLEET })
    renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)
    const statuses = screen.getAllByTestId('agent-status').map((el) => el.textContent)
    expect(statuses[0]).toBe('waiting · dialog open')
  })

  it('filters as you type', async () => {
    const user = userEvent.setup()
    useStore.setState({ agents: FLEET })
    renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)

    await user.type(screen.getByTestId('search'), 'lego')
    const names = screen.getAllByTestId('agent-name').map((el) => el.textContent)
    expect(names).toEqual(['lego-scraper'])
  })

  it('explains an empty result rather than showing a blank column', async () => {
    const user = userEvent.setup()
    useStore.setState({ agents: FLEET })
    renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)

    await user.type(screen.getByTestId('search'), 'zzzz')
    expect(screen.getByTestId('empty-state').textContent).toContain('zzzz')
  })

  it('tells you how to start one when there are none', () => {
    renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)
    expect(screen.getByTestId('empty-state').textContent).toContain('claude')
  })

  it('reports a session that has never been prompted', () => {
    useStore.setState({ agents: [agent({ sessionId: 'fresh', activity: undefined })] })
    renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)
    expect(screen.getByTestId('agent-activity').textContent).toContain('No prompts yet')
  })

  it('selects an agent when its card is clicked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    useStore.setState({ agents: FLEET })
    renderApp(<FleetList tiled selected={null} onSelect={onSelect} />)

    await user.click(screen.getAllByTestId('agent-card')[0] as HTMLElement)
    expect(onSelect).toHaveBeenCalledWith('w')
  })

  it('opens the new-agent dialog', async () => {
    const user = userEvent.setup()
    renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)
    await user.click(screen.getByTestId('new-agent-button'))
    expect(useStore.getState().newAgentOpen).toBe(true)
  })
})

// A 300-character search term used to be echoed verbatim into the empty state,
// forcing the whole document to 2175px and giving the page horizontal scroll.
describe('long input in the empty state', () => {
  it('truncates the query it echoes back', async () => {
    const user = userEvent.setup()
    useStore.setState({ agents: FLEET })
    renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)

    await user.type(screen.getByTestId('search'), 'a'.repeat(200))
    const text = screen.getByTestId('empty-state').textContent ?? ''
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(200)
  })
})
