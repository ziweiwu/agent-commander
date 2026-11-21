/**
 * A6: the agent's Chat and Attach tabs behave like the tabs their role names.
 *
 * `role="tab"` promises a screen reader and a keyboard user the APG tabs
 * pattern: one Tab stop for the whole list, arrows between tabs, and a panel
 * the tab controls. They had none of it: both tabs were Tab stops, arrows did
 * nothing, and nothing was a panel. Activation is manual, so an arrow moves
 * focus and nothing more: the Attach tab mounts a terminal, and attaching
 * still needs a press (INV-1, INV-2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
import { FullscreenView } from '../../src/web/components/FullscreenView.tsx'
import type { Agent } from '../../src/shared/types.ts'
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

vi.mock('../../src/web/components/LazyTerminal.tsx', () => ({
  LazyTerminal: () => <div data-testid="terminal-stub" />,
}))

beforeEach(resetStore)

const noop = () => {}

type Surface = 'panel' | 'fullscreen'

function open(surface: Surface, onTab: (tab: 'chat' | 'attach') => void, over: Partial<Agent> = {}) {
  const a = agent({ paneId: '%1', ...over, sessionId: 'a' })
  renderApp(
    surface === 'panel' ? (
      <AgentDetail agent={a} tab="chat" sheet={false} onTab={onTab} onClose={noop} />
    ) : (
      <FullscreenView agent={a} tab="chat" onTab={onTab} onExit={noop} />
    ),
  )
  const prefix = surface === 'panel' ? '' : 'fullscreen-'
  return {
    chat: screen.getByTestId(`${prefix}tab-chat`),
    attach: screen.getByTestId(`${prefix}tab-attach`),
  }
}

describe.each<Surface>(['panel', 'fullscreen'])('A6 the %s tabs', (surface) => {
  it('makes the selected tab the only Tab stop', () => {
    const { chat, attach } = open(surface, noop)
    expect(chat.tabIndex).toBe(0)
    expect(attach.tabIndex).toBe(-1)
  })

  it('moves focus with ArrowRight and selects nothing until Enter', async () => {
    const onTab = vi.fn()
    const user = userEvent.setup()
    const { chat, attach } = open(surface, onTab)
    chat.focus()

    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(attach)
    expect(attach.getAttribute('aria-selected')).toBe('false')
    expect(onTab).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')
    expect(onTab).toHaveBeenCalledWith('attach')
  })

})

describe.each<Surface>(['panel', 'fullscreen'])('A6 the %s tabs, past the first step', (surface) => {
  it('wraps with the arrows and jumps with Home and End', () => {
    const { chat, attach } = open(surface, noop)
    chat.focus()
    fireEvent.keyDown(chat, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(attach)
    fireEvent.keyDown(attach, { key: 'Home' })
    expect(document.activeElement).toBe(chat)
    fireEvent.keyDown(chat, { key: 'End' })
    expect(document.activeElement).toBe(attach)
  })

  it('skips a disabled Attach tab', () => {
    const { chat } = open(surface, noop, { paneId: undefined })
    chat.focus()
    fireEvent.keyDown(chat, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(chat)
  })

  it('names the content as the selected tab’s panel', () => {
    const { chat } = open(surface, noop)
    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(chat.id)
    expect(chat.getAttribute('aria-controls')).toBe(panel.id)
  })
})
