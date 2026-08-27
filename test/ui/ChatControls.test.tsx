/**
 * The two switches that sit above the message box: permission mode, and the
 * session goal (`/goal`).
 *
 * The two are guarded differently, and INV-8 says why. Setting a goal types
 * into the agent's own prompt, so a busy agent is refused. Switching mode sends
 * `BTab`, a control key the agent handles wherever it is, so it stays available
 * mid-run — which is the only time anyone reaches for it. INV-2's "exactly
 * once" applies to the goal either way: it is an instruction to a live session,
 * however small the control that sends it looks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ChatControls } from '../../src/web/components/ChatControls.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'

const setAgentGoal = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const))
const setAgentMode = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const))
vi.mock('../../src/web/store/transport.ts', () => ({ setAgentGoal, setAgentMode }))

const GOAL = { condition: 'every test passes', met: false, at: 1_786_000_000_000 }

beforeEach(() => {
  resetStore()
  setAgentGoal.mockClear()
  setAgentMode.mockClear()
})

describe('mode', () => {
  it('shows the mode the session is actually in', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'plan' })} />)
    expect((screen.getByTestId('chat-mode-select') as HTMLSelectElement).value).toBe('plan')
  })

  it('switches mode from the chat, without opening the panel row', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)
    await user.selectOptions(screen.getByTestId('chat-mode-select'), 'plan')
    expect(setAgentMode).toHaveBeenCalledExactlyOnceWith('plan')
  })

  /*
   * INV-8's exception. Mode sends `BTab` — a control key the agent handles
   * wherever it is — rather than typing into its prompt, so it is the one
   * control that stays available mid-run. That is when it is wanted: the
   * decision that the next step needs plan mode is made while the agent works.
   */
  it('stays available while the agent is busy', async () => {
    const user = userEvent.setup()
    renderApp(
      <ChatControls agent={agent({ sessionId: 'a', status: 'busy', permissionMode: 'default' })} />,
    )
    const select = screen.getByTestId('chat-mode-select') as HTMLSelectElement
    expect(select.disabled).toBe(false)

    await user.selectOptions(select, 'plan')
    expect(setAgentMode).toHaveBeenCalledExactlyOnceWith('plan')
  })

  /*
   * The select is bound to the mode the *agent* reports, which comes out of a
   * transcript a busy session writes only when its turn ends. Without holding
   * the pick, the next fleet broadcast repainted the old value a second later
   * and the click read as though it had done nothing.
   *
   * This existed in the detail panel and not here, so the same control was
   * fixed two clicks away and broken in the view people actually read.
   */
  it('holds the picked mode until the agent confirms it', async () => {
    const user = userEvent.setup()
    setAgentMode.mockReturnValue(new Promise(() => {}) as Promise<{ ok: true }>)
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)

    await user.selectOptions(screen.getByTestId('chat-mode-select'), 'plan')

    expect((screen.getByTestId('chat-mode-select') as HTMLSelectElement).value).toBe('plan')
  })

  // The server said it could not confirm the switch. Reporting that as a clean
  // success is the interface asserting more than it knows (INV-11).
  it('surfaces an unverified switch rather than staying silent', async () => {
    const user = userEvent.setup()
    setAgentMode.mockResolvedValue({ ok: true, detail: 'unverified' } as never)
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)

    await user.selectOptions(screen.getByTestId('chat-mode-select'), 'plan')

    expect(useStore.getState().toast).toBeTruthy()
  })

  // Reachability is still required: no pane, nothing to send the key to.
  it('is unavailable on an agent with no pane', () => {
    const noPane = agent({ sessionId: 'a', status: 'busy' })
    delete (noPane as { paneId?: string }).paneId
    renderApp(<ChatControls agent={noPane} />)
    expect((screen.getByTestId('chat-mode-select') as HTMLSelectElement).disabled).toBe(true)
  })
})

describe('goal toggle', () => {
  it('reads as off when the session has no goal', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a' })} />)
    expect(screen.getByTestId('goal-toggle').getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('goal-form')).toBeNull()
  })

  it('asks for a condition before anything is sent', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a' })} />)
    await user.click(screen.getByTestId('goal-toggle'))
    expect(screen.getByTestId('goal-input')).toBeTruthy()
    expect(setAgentGoal).not.toHaveBeenCalled()
  })

  it('sets the goal that was typed', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a' })} />)
    await user.click(screen.getByTestId('goal-toggle'))
    await user.type(screen.getByTestId('goal-input'), 'every test passes')
    await user.click(screen.getByTestId('goal-apply'))
    expect(setAgentGoal).toHaveBeenCalledExactlyOnceWith('every test passes')
  })

  /*
   * On a 390px phone the mode select pushed Set and Cancel off the end of the
   * strip's scroller, leaving no visible way to finish typing a goal.
   */
  it('gives the whole strip to the goal field while it is open', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'plan' })} />)
    await user.click(screen.getByTestId('goal-toggle'))
    expect(screen.queryByTestId('chat-mode-select')).toBeNull()
    await user.click(screen.getByTestId('goal-cancel'))
    expect(screen.getByTestId('chat-mode-select')).toBeTruthy()
  })

  it('cancels without sending, and forgets the draft', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a' })} />)
    await user.click(screen.getByTestId('goal-toggle'))
    await user.type(screen.getByTestId('goal-input'), 'never mind')
    await user.click(screen.getByTestId('goal-cancel'))
    expect(setAgentGoal).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('goal-toggle'))
    expect((screen.getByTestId('goal-input') as HTMLInputElement).value).toBe('')
  })

  it('reads as on, and names the goal, while one is running', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', goal: GOAL })} />)
    const toggle = screen.getByTestId('goal-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.textContent).toContain('every test passes')
  })

  it('clears the running goal when toggled off', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a', goal: GOAL })} />)
    await user.click(screen.getByTestId('goal-toggle'))
    // The empty condition is how the server is told this is a clear, not a set.
    expect(setAgentGoal).toHaveBeenCalledExactlyOnceWith('')
  })

  /*
   * A goal the evaluator has confirmed is over, not running. Showing it as an
   * active goal would offer to clear something that is already finished, and
   * hide the fact that it succeeded.
   */
  it('treats an achieved goal as finished rather than running', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', goal: { ...GOAL, met: true } })} />)
    expect(screen.getByTestId('goal-toggle').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('goal-met')).toBeTruthy()
  })

  it('says a running goal has been checked and not met yet', () => {
    renderApp(
      <ChatControls agent={agent({ sessionId: 'a', goal: { ...GOAL, reason: 'Two fail.' } })} />,
    )
    expect(screen.getByTestId('goal-note').getAttribute('title')).toBe('Two fail.')
  })

  // INV-8 again: setting a goal is typing into the prompt like everything else.
  it('is refused while the agent is busy', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', status: 'busy', goal: GOAL })} />)
    expect((screen.getByTestId('goal-toggle') as HTMLButtonElement).disabled).toBe(true)
  })

  /*
   * INV-8 through the other door. The toggle is disabled while an agent is
   * busy, but the field opens before that and Enter in it reached the send
   * directly -- so an agent that got busy while the condition was being typed
   * could be sent a goal from a control the interface was drawing as
   * unavailable, with the server's refusal arriving as a toast.
   */
  it('does not send on Enter if the agent went busy while the field was open', () => {
    const { rerender } = renderApp(<ChatControls agent={agent({ sessionId: 'a' })} />)
    act(() => {
      screen.getByTestId('goal-toggle').click()
    })
    const input = screen.getByTestId('goal-input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, 'ship it')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // The agent picks up work while the condition is being typed.
    rerender(
      <MemoryRouter>
        <ChatControls agent={agent({ sessionId: 'a', status: 'busy' })} />
      </MemoryRouter>,
    )
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(setAgentGoal).not.toHaveBeenCalled()
  })

  /*
   * INV-2, in the smaller place it also applies: `pending` is React state and
   * does not land until React flushes, so two Enters in one batch would both
   * read it as free and both set the goal on a live session.
   */
  it('sets once when Enter fires twice before React flushes', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a' })} />)
    act(() => {
      screen.getByTestId('goal-toggle').click()
    })
    const input = screen.getByTestId('goal-input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, 'ship it')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(setAgentGoal).toHaveBeenCalledExactlyOnceWith('ship it')
  })
})
