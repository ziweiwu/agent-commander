/**
 * A4: the card says why, and every Details button names its agent.
 *
 * Fourteen identical "Details" buttons in a row tell a screen reader nothing
 * about which card each one opens, and the card's own name stopped at its
 * status and folder: what a waiting agent is asking about, and what a working
 * one is doing, were on the card in the DOM and in no accessible property.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
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

const DESCRIPTION_CAP = 160
const noop = () => {}

const describedBy = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')

beforeEach(resetStore)

describe('A4 the card says why', () => {
  it('describes a waiting card by what it is waiting for and doing', () => {
    renderApp(
      <AgentCard
        agent={agent({
          sessionId: 'w',
          name: 'rebuild-dist',
          status: 'waiting',
          waitingFor: 'permission prompt',
          activity: 'Bash: rm -rf dist && npm run build',
          paneId: '%1',
        })}
        selected={false}
        onSelect={noop}
      />,
    )
    const description = describedBy(screen.getByTestId('agent-card'))
    expect(description).toContain('permission prompt')
    expect(description).toContain('Bash: rm -rf dist && npm run build')
  })

  it('says it in Chinese for a Chinese reader', () => {
    useStore.setState({ lang: 'zh-CN' })
    renderApp(
      <AgentCard
        agent={agent({ sessionId: 'w', status: 'waiting', waitingFor: 'dialog open', paneId: '%1' })}
        selected={false}
        onSelect={noop}
      />,
    )
    expect(describedBy(screen.getByTestId('agent-card'))).not.toContain('dialog open')
  })

  it('is capped so a long activity is not read in full on every focus', () => {
    renderApp(
      <AgentCard
        agent={agent({ sessionId: 'b', status: 'busy', activity: `Bash: ${'x'.repeat(400)}`, paneId: '%1' })}
        selected={false}
        onSelect={noop}
      />,
    )
    expect(describedBy(screen.getByTestId('agent-card')).length).toBeLessThanOrEqual(DESCRIPTION_CAP)
  })
})

describe('A4 every Details names its agent', () => {
  it('gives two Details buttons two different names', () => {
    useStore.setState({
      agents: [
        agent({ sessionId: 'a', name: 'blog-redesign', status: 'idle' }),
        agent({ sessionId: 'b', name: 'lego-scraper', status: 'idle' }),
      ],
    })
    renderApp(<FleetList tiled selected={null} onSelect={noop} />)
    const names = screen.getAllByTestId('details-toggle').map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['Details for blog-redesign', 'Details for lego-scraper'])
  })

  it('groups the cards as a list', () => {
    useStore.setState({
      agents: [
        agent({ sessionId: 'a', name: 'blog-redesign', status: 'idle' }),
        agent({ sessionId: 'b', name: 'lego-scraper', status: 'idle' }),
      ],
    })
    renderApp(<FleetList tiled selected={null} onSelect={noop} />)
    const list = screen.getByRole('list', { name: 'Idle' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })
})
