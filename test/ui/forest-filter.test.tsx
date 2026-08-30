/**
 * The forest answers to the same query, filter and sort as the card list.
 *
 * AGENTS.md's rule — anything true of the fleet must be true in both
 * renderings — and "what the search shows" is its sharpest case: a search that
 * narrowed one view and not the other would make the two views disagree about
 * which agents exist. The forest also keeps the grouping as ordering: blocked
 * families first whatever the sort, because no sort key may bury the one agent
 * that needs you.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { ForestRoute } from '../../src/web/components/ForestRoute.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'

vi.mock('../../src/web/store/transport.ts', () => ({
  fetchTree: vi.fn().mockResolvedValue({ changed: false }),
  closeAgentById: vi.fn(),
}))

const families = () =>
  [...document.querySelectorAll('[data-testid="forest-family"]')].map((el) =>
    el.getAttribute('data-session-id'),
  )

beforeEach(() => {
  resetStore()
  useStore.setState({
    agents: [
      agent({ sessionId: 'kb', name: 'kb-vault', folder: 'kb-vault', status: 'idle' }),
      agent({ sessionId: 'web', name: 'web-app', folder: 'web-app', status: 'busy' }),
      agent({ sessionId: 'blocked', name: 'stuck-one', folder: 'api', status: 'waiting' }),
    ],
  })
})

describe('the forest narrows and orders like the card list', () => {
  it('shows only what the query matches', () => {
    useStore.setState({ fleet: { query: 'kb-vault', filter: 'all', sort: 'recent', dir: 'desc' } })
    renderApp(<ForestRoute />)

    expect(families()).toEqual(['kb'])
  })

  it('shows only the filtered status', () => {
    useStore.setState({ fleet: { query: '', filter: 'busy', sort: 'recent', dir: 'desc' } })
    renderApp(<ForestRoute />)

    expect(families()).toEqual(['web'])
  })

  it('keeps a blocked family first whatever the sort', () => {
    useStore.setState({ fleet: { query: '', filter: 'all', sort: 'name', dir: 'asc' } })
    renderApp(<ForestRoute />)

    // 'stuck-one' sorts last by name; the grouping keeps it first anyway.
    expect(families()[0]).toBe('blocked')
  })

  it('says in words when nothing matches, echoing the query', () => {
    useStore.setState({
      fleet: { query: 'nothing-has-this-name', filter: 'all', sort: 'recent', dir: 'desc' },
    })
    renderApp(<ForestRoute />)

    expect(screen.getByTestId('empty-state').textContent).toMatch(/nothing-has-this-name/)
    expect(screen.queryByTestId('forest-view')).toBeNull()
  })
})
