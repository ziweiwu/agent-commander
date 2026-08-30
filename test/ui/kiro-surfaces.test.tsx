/**
 * An agent whose CLI keeps no transcript, across every surface that shows one.
 *
 * The Chat tab was hidden in `AgentDetail` and left in `FullscreenView`, one
 * click apart — so full screen offered a tab that flickered a route change and
 * snapped back, on the one agent kind that structurally cannot have a
 * conversation. Nothing caught it: no test rendered `FullscreenView` with a
 * non-Claude agent at all.
 *
 * Hiding it in one surface and not its sibling is worse than not hiding it
 * anywhere, because the app then contradicts itself within two clicks. These
 * tests pin both surfaces together for that reason.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
import { FullscreenView } from '../../src/web/components/FullscreenView.tsx'
import { AgentControls } from '../../src/web/components/AgentControls.tsx'
import { agent, resetStore } from './helpers.tsx'
import type { Agent } from '../../src/shared/types.ts'

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
  closeAgent: vi.fn(),
  cycleAgentMode: vi.fn(),
  setAgentModel: vi.fn(),
  setAgentGoal: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

vi.mock('../../src/web/components/LazyTerminal.tsx', () => ({
  LazyTerminal: () => <div data-testid="term-stub" />,
}))

const kiro = (over: Partial<Agent> = {}): Agent =>
  agent({
    sessionId: 'tmux:kiro-1787832510',
    agentKind: 'kiro',
    name: 'folio',
    paneId: '%302',
    tmuxSession: 'kiro-1787832510',
    ...over,
  })

const noop = (): void => {}

function fullscreen(subject: Agent, tab: 'chat' | 'attach' = 'attach') {
  resetStore()
  return render(
    <MemoryRouter>
      <FullscreenView agent={subject} tab={tab} onTab={noop} onExit={noop} />
    </MemoryRouter>,
  )
}

describe('full screen hides the Chat tab it cannot fill', () => {
  it('offers no Chat tab for an agent with no transcript', () => {
    fullscreen(kiro())
    expect(screen.queryByTestId('fullscreen-tab-chat')).toBeNull()
    expect(screen.queryByTestId('fullscreen-tab-attach')).not.toBeNull()
  })

  it('still offers it for Claude', () => {
    fullscreen(agent({ sessionId: 'claude-1', paneId: '%1' }))
    expect(screen.queryByTestId('fullscreen-tab-chat')).not.toBeNull()
  })

  /*
   * Hiding the tab is not enough on its own: the route can still say `chat`
   * — a stale URL, a back button — and rendering an empty conversation is the
   * exact state the hidden tab exists to prevent.
   */
  it('shows the terminal even when the route still says chat', () => {
    fullscreen(kiro(), 'chat')
    expect(screen.queryByTestId('term-stub')).not.toBeNull()
  })
})

describe('the detail panel agrees with full screen', () => {
  it('hides the Chat tab there too', () => {
    resetStore()
    render(
      <MemoryRouter>
        <AgentDetail agent={kiro()} tab="attach" sheet={false} onTab={noop} onClose={noop} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('tab-chat')).toBeNull()
  })
})

describe('controls that would type a Claude command are not offered', () => {
  it('hides mode and model, and keeps close', () => {
    resetStore()
    render(
      <MemoryRouter>
        <AgentControls agent={kiro({ status: 'idle' })} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('mode-cycle')).toBeNull()
    expect(screen.queryByTestId('model-select')).toBeNull()
    // /clear and /compact are Claude Code commands too, so for another CLI
    // they are not a disabled feature but a wrong one (INV-7).
    expect(screen.queryByTestId('clear-agent')).toBeNull()
    expect(screen.queryByTestId('compact-agent')).toBeNull()
    expect(screen.queryByTestId('close-agent')).not.toBeNull()
  })

  it('offers all three for Claude', () => {
    resetStore()
    render(
      <MemoryRouter>
        <AgentControls agent={agent({ sessionId: 'claude-1', status: 'idle', paneId: '%1' })} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('mode-cycle')).not.toBeNull()
    expect(screen.queryByTestId('model-select')).not.toBeNull()
    expect(screen.queryByTestId('clear-agent')).not.toBeNull()
    expect(screen.queryByTestId('compact-agent')).not.toBeNull()
  })
})
