import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
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
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

const noop = () => {}

beforeEach(resetStore)

/*
 * The status line under the tabs: the session's mode, model and delegates on
 * the screen where the work is read, not only on the card that is glanced at.
 */
describe('the status line', () => {
  const open = (over: Parameters<typeof agent>[0]) =>
    renderApp(
      <AgentDetail agent={agent(over)} tab="chat" sheet={false} onTab={noop} onClose={noop} />,
    )

  it('names the mode the session recorded, and the model', () => {
    open({ sessionId: 'a', permissionMode: 'plan', model: 'claude-opus-5' })
    expect(screen.getByTestId('detail-mode').textContent).toMatch(/plan/i)
    expect(screen.getByTestId('detail-mode').dataset.reported).toBe('true')
    expect(screen.getByTestId('detail-model').textContent).toContain('opus')
  })

  // INV-11: a session that has not finished a turn has written no mode down,
  // and that is said rather than filled with "default".
  it('says the mode is not reported yet rather than guessing one', () => {
    open({ sessionId: 'a', permissionMode: undefined, model: undefined })
    expect(screen.getByTestId('detail-mode').textContent).toMatch(/not reported/i)
    expect(screen.getByTestId('detail-mode').dataset.reported).toBe('false')
    expect(screen.queryByTestId('detail-model')).toBeNull()
  })

  it('reads the delegates from the graph the fleet polled', () => {
    useStore.setState({
      trees: [
        {
          sessionId: 'a',
          children: [
            {
              agentId: 'x',
              agentType: 'Explore',
              description: 'look',
              depth: 1,
              lastWriteAt: Date.now() - 5_000,
              bytes: 1,
              state: 'quiet',
              children: [],
            },
          ],
        },
      ],
    })
    open({ sessionId: 'a', status: 'busy', delegating: true })
    const line = screen.getByTestId('detail-status-line')
    expect(line.querySelector('[data-testid="agent-delegates"]')?.getAttribute('data-claim')).toBe('some')
    expect(line.textContent).toContain('1 quiet')
  })

  it('claims nothing about delegates while the graph has not arrived', () => {
    open({ sessionId: 'a', status: 'busy' })
    expect(screen.queryByTestId('agent-delegates')).toBeNull()
  })
})

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
