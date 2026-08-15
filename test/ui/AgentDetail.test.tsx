import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
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

const noop = () => {}

beforeEach(resetStore)

describe('AgentDetail', () => {
  it('names the agent and its status', () => {
    renderApp(
      <AgentDetail
        agent={agent({ sessionId: 'a', name: 'monitor-50', derivedName: false, status: 'busy' })}
        tab="chat"
        sheet={false}
        onTab={noop}
        onClose={noop}
      />,
    )
    expect(screen.getByTestId('detail-name').textContent).toBe('monitor-50')
    expect(screen.getByTestId('detail-status').textContent).toBe('busy')
  })

  it('explains a blocked agent and offers the action that fixes it', () => {
    renderApp(
      <AgentDetail
        agent={agent({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open' })}
        tab="chat"
        sheet={false}
        onTab={noop}
        onClose={noop}
      />,
    )
    const banner = screen.getByTestId('blocked-banner')
    expect(banner.textContent).toContain('dialog open')
    expect(screen.getByTestId('unblock-button')).toBeDefined()
  })

  // A stale banner would tell you to go and do something already done.
  it('clears the blocked banner once the agent stops waiting', () => {
    const { rerender } = renderApp(
      <AgentDetail
        agent={agent({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open' })}
        tab="chat"
        sheet={false}
        onTab={noop}
        onClose={noop}
      />,
    )
    expect(screen.queryByTestId('blocked-banner')).not.toBeNull()

    rerender(
      <AgentDetail
        agent={agent({ sessionId: 'a', status: 'busy' })}
        tab="chat"
        sheet={false}
        onTab={noop}
        onClose={noop}
      />,
    )
    expect(screen.queryByTestId('blocked-banner')).toBeNull()
  })

  it('disables the Attach tab for an agent with no pane', () => {
    renderApp(
      <AgentDetail
        agent={agent({ sessionId: 'a', paneId: undefined })}
        tab="chat"
        sheet={false}
        onTab={noop}
        onClose={noop}
      />,
    )
    expect(screen.getByTestId<HTMLButtonElement>('tab-attach').disabled).toBe(true)
  })

  it('marks the open tab as selected', () => {
    renderApp(
      <AgentDetail
        agent={agent({ sessionId: 'a' })}
        tab="attach"
        sheet={false}
        onTab={noop}
        onClose={noop}
      />,
    )
    expect(screen.getByTestId('tab-attach').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('tab-chat').getAttribute('aria-selected')).toBe('false')
  })
})

// On a phone the header had 33px of a 353px name visible and no tooltip, so the
// agent you were looking at was genuinely unidentifiable.
describe('narrow sheet header', () => {
  it('drops the waiting reason from the pill to give the name room', () => {
    const blocked = agent({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open' })
    const { rerender } = renderApp(
      <AgentDetail agent={blocked} tab="chat" sheet={false} onTab={noop} onClose={noop} />,
    )
    expect(screen.getByTestId('detail-status').textContent).toContain('dialog open')

    rerender(<AgentDetail agent={blocked} tab="chat" sheet onTab={noop} onClose={noop} />)
    // The reason still reaches assistive tech and hover via the title.
    expect(screen.getByTestId('detail-status').textContent).not.toContain('dialog open')
    expect(screen.getByTestId('detail-status').getAttribute('title')).toContain('dialog open')
  })

  it('keeps the full name recoverable when it is truncated', () => {
    renderApp(
      <AgentDetail
        agent={agent({ sessionId: 'a', name: 'a-very-long-session-name-that-will-not-fit' })}
        tab="chat"
        sheet
        onTab={noop}
        onClose={noop}
      />,
    )
    const title = screen.getByTestId('detail-name').getAttribute('title') ?? ''
    expect(title).toContain('a-very-long-session-name-that-will-not-fit')
    expect(title).toContain('/Users/me/Projects/thing')
  })
})
