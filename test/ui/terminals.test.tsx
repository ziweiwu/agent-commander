/**
 * The plain terminal: a tmux session this app opened with no agent in it.
 *
 * It is the only kind the app *creates* that answers none of the questions the
 * fleet exists to ask — a shell is never blocked, never delegating and never
 * needs you — so it is out of the fleet's scope until asked for. Out of scope
 * is not hidden: the chip that admits them says how many there are, because a
 * count that appears nowhere is a fleet with a hole in it (INV-11).
 *
 * Everything else about it falls out of the capability table it shares with
 * Kiro. It keeps no transcript, so the agent screen is the Attach tab alone,
 * and it answers no slash command, so `/goal`, `/model`, `/clear` and
 * `/compact` are not offered at a shell that would only receive the words
 * (INV-7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TERMINAL_KIND } from '../../src/shared/agent-kinds.ts'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
import { NewAgentDialog } from '../../src/web/components/NewAgentDialog.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'

const transport = vi.hoisted(() => ({
  startAgent: vi.fn(async () => ({ ok: true, cwd: '/Users/me/Projects/thing' }) as const),
  startTerminal: vi.fn(async () => ({ ok: true, cwd: '/Users/me/Projects/thing' }) as const),
}))

vi.mock('../../src/web/store/transport.ts', () => ({
  ...transport,
  loadEnv: vi.fn(),
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendText: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  answerPrompt: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
  setAgentModel: vi.fn(),
  setGoal: vi.fn(),
  clearGoal: vi.fn(),
  sendShiftTab: vi.fn(),
}))

const terminal = agent({
  sessionId: 'tmux:term-1',
  name: 'scratch',
  agentKind: TERMINAL_KIND,
  paneId: '%85',
})

beforeEach(() => {
  resetStore()
  setViewport(() => false)
  for (const fn of Object.values(transport)) fn.mockClear()
})

describe('a terminal is the Attach tab and nothing else', () => {
  function open(): void {
    useStore.setState({ selected: terminal.sessionId, tab: 'attach' })
    renderApp(
      <AgentDetail
        agent={terminal}
        tab="attach"
        sheet={false}
        onTab={() => {}}
        onClose={() => {}}
      />,
    )
  }

  it('offers no conversation, because there is no transcript to read', () => {
    open()
    expect(screen.queryByTestId('tab-chat')).toBeNull()
    expect(screen.getByTestId('tab-attach')).toBeTruthy()
  })

  /*
   * The load-bearing half. Every one of these types Claude Code's own slash
   * commands into a pane, and at a shell prompt that does not degrade — it
   * runs `/goal` as a command, or leaves the words sitting in somebody's
   * shell. The capability table refuses them; this is what pins that it does.
   */
  it.each(['goal-toggle', 'model-select', 'clear-agent', 'compact-agent', 'shift-tab'])(
    'does not offer %s at a shell prompt',
    (id) => {
      open()
      expect(screen.queryAllByTestId(id)).toEqual([])
    },
  )
})

describe('opening one', () => {
  async function openDialog(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup()
    useStore.setState({ newAgentOpen: true, env: { tmux: true } as never })
    renderApp(<NewAgentDialog />)
    return user
  }

  it('goes to its own route, carrying a folder and nothing else', async () => {
    const user = await openDialog()
    await user.click(screen.getByTestId('new-kind-terminal'))
    await user.type(screen.getByTestId('new-agent-dir'), '~/Projects/thing')
    await user.click(screen.getByTestId('new-agent-submit'))

    expect(transport.startTerminal).toHaveBeenCalledExactlyOnceWith('~/Projects/thing', {})
    expect(transport.startAgent).not.toHaveBeenCalled()
  })

  /*
   * Withheld rather than disabled: both are flags on `claude`, and there is no
   * shell equivalent to grey out. A disabled select would say the setting
   * exists here and is merely unavailable (INV-11).
   */
  it('does not ask for a model or a permission mode', async () => {
    const user = await openDialog()
    expect(screen.getByTestId('new-agent-model')).toBeTruthy()
    await user.click(screen.getByTestId('new-kind-terminal'))
    expect(screen.queryByTestId('new-agent-model')).toBeNull()
    expect(screen.queryByTestId('new-agent-mode')).toBeNull()
  })

  it('still starts an agent when that is what was chosen', async () => {
    const user = await openDialog()
    await user.click(screen.getByTestId('new-kind-terminal'))
    await user.click(screen.getByTestId('new-kind-agent'))
    await user.type(screen.getByTestId('new-agent-dir'), '~/Projects/thing')
    await user.click(screen.getByTestId('new-agent-submit'))

    expect(transport.startAgent).toHaveBeenCalledOnce()
    expect(transport.startTerminal).not.toHaveBeenCalled()
  })

  /*
   * The default hides terminals, and that default is about the fleet you did
   * not ask for. Leaving it on here made the button look like it had done
   * nothing at all.
   */
  it('admits terminals to the fleet, having just made one', async () => {
    const user = await openDialog()
    expect(useStore.getState().fleet.terminals).toBe(false)
    await user.click(screen.getByTestId('new-kind-terminal'))
    await user.type(screen.getByTestId('new-agent-dir'), '~/Projects/thing')
    await user.click(screen.getByTestId('new-agent-submit'))
    expect(useStore.getState().fleet.terminals).toBe(true)
  })

  it('leaves the filter alone when an agent was started', async () => {
    const user = await openDialog()
    await user.type(screen.getByTestId('new-agent-dir'), '~/Projects/thing')
    await user.click(screen.getByTestId('new-agent-submit'))
    expect(useStore.getState().fleet.terminals).toBe(false)
  })

  it('says which of the two the button will do', async () => {
    const user = await openDialog()
    const submit = screen.getByTestId('new-agent-submit')
    const asAgent = submit.textContent
    await user.click(screen.getByTestId('new-kind-terminal'))
    expect(submit.textContent).not.toBe(asAgent)
  })
})
