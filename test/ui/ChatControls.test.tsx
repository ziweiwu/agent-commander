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
import { ChatControls } from '../../src/web/components/ChatControls.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'

const setAgentGoal = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const))
const cycleAgentMode = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, detail: 'plan' }) as { ok: true; detail?: string }),
)
vi.mock('../../src/web/store/transport.ts', () => ({ setAgentGoal, cycleAgentMode }))

const GOAL = { condition: 'every test passes', met: false, at: 1_786_000_000_000 }

beforeEach(() => {
  resetStore()
  setAgentGoal.mockClear()
  cycleAgentMode.mockClear()
  cycleAgentMode.mockResolvedValue({ ok: true, detail: 'plan' })
})

describe('mode', () => {
  /*
   * This was a `<select>` and is now one button, because asking for a *named*
   * mode is what made the control unreliable — see `ModeButton` and `cycleMode`
   * in `src/server/control.ts`. The cases below are about a press and a
   * reading, which is all there is left to get wrong.
   */

  it('shows the mode the session is actually in', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'plan' })} />)
    expect(screen.getByTestId('mode-cycle').textContent).toContain('Plan')
  })

  it('advances one step from the chat, without opening the panel row', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)
    await user.click(screen.getByTestId('mode-cycle'))
    expect(cycleAgentMode).toHaveBeenCalledOnce()
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
    const button = screen.getByTestId('mode-cycle') as HTMLButtonElement
    expect(button.disabled).toBe(false)

    await user.click(button)
    expect(cycleAgentMode).toHaveBeenCalledOnce()
  })

  /*
   * The label is bound to the mode the *agent* reports, which comes out of a
   * transcript a busy session writes only when its turn ends. Without holding
   * the server's answer, the next fleet broadcast repainted the old value a
   * second later and the click read as though it had done nothing.
   */
  it('holds the new mode until the agent confirms it', async () => {
    const user = userEvent.setup()
    cycleAgentMode.mockResolvedValue({ ok: true, detail: 'acceptEdits' })
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)

    await user.click(screen.getByTestId('mode-cycle'))

    expect(screen.getByTestId('mode-cycle').textContent).toContain('Accept edits')
  })

  /*
   * INV-2's "exactly once", applied to a control. Two clicks in one React batch
   * both read `pending` before it flushes; the ref is what stops the second
   * sending another Shift+Tab into a live session.
   */
  it('sends one press from a double click', async () => {
    const user = userEvent.setup()
    cycleAgentMode.mockReturnValue(new Promise(() => {}) as never)
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)

    const button = screen.getByTestId('mode-cycle')
    await user.click(button)
    await user.click(button)

    expect(cycleAgentMode).toHaveBeenCalledOnce()
  })

  /*
   * The press went out and the session has not written a mode down. Saying
   * nothing would report an unconfirmed switch as a clean success, and showing
   * a mode would claim one this app never read (INV-11).
   */
  it('says the press was not reported rather than naming a mode', async () => {
    const user = userEvent.setup()
    cycleAgentMode.mockResolvedValue({ ok: true, detail: 'unverified' })
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)

    await user.click(screen.getByTestId('mode-cycle'))

    expect(useStore.getState().toast).toBeTruthy()
    const button = screen.getByTestId('mode-cycle')
    expect(button.getAttribute('data-unreported')).toBe('true')
    expect(button.textContent).toContain('pressed')
  })

  // Reachability is still required: no pane, nothing to send the key to.
  it('is unavailable on an agent with no pane', () => {
    const noPane = agent({ sessionId: 'a', status: 'busy' })
    delete (noPane as { paneId?: string }).paneId
    renderApp(<ChatControls agent={noPane} />)
    expect((screen.getByTestId('mode-cycle') as HTMLButtonElement).disabled).toBe(true)
  })

  /*
   * Two of these are on screen at once — the composer strip and the detail
   * panel's control row — and they show one setting. Held per component,
   * pressing one updated it and left the other reading the old mode two inches
   * away until the enricher caught up. An app that contradicts itself within
   * one glance is worse than one that is briefly behind.
   */
  it('agrees with the other mode button on screen', async () => {
    const user = userEvent.setup()
    cycleAgentMode.mockResolvedValue({ ok: true, detail: 'acceptEdits' })
    const a = agent({ sessionId: 'a', permissionMode: 'default' })
    renderApp(
      <>
        <ChatControls agent={a} />
        <ChatControls agent={a} />
      </>,
    )

    const [first, second] = screen.getAllByTestId('mode-cycle')
    await user.click(first as HTMLElement)

    expect(first?.textContent).toContain('Accept edits')
    expect(second?.textContent).toContain('Accept edits')
  })

  // A hold belongs to the agent it was made on, not to the next one opened.
  it('does not carry a held mode onto another agent', async () => {
    const user = userEvent.setup()
    cycleAgentMode.mockResolvedValue({ ok: true, detail: 'acceptEdits' })
    renderApp(
      <>
        <ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />
        <ChatControls agent={agent({ sessionId: 'b', permissionMode: 'plan' })} />
      </>,
    )

    const [first, second] = screen.getAllByTestId('mode-cycle')
    await user.click(first as HTMLElement)

    expect(first?.textContent).toContain('Accept edits')
    expect(second?.textContent).toContain('Plan')
  })

  // The glyph and a mode name do not say what pressing will do.
  it('names both halves of the action for a screen reader', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'plan' })} />)
    const label = screen.getByTestId('mode-cycle').getAttribute('aria-label') ?? ''
    expect(label).toContain('Plan')
    expect(label).toMatch(/next mode/i)
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
    expect(screen.queryByTestId('mode-cycle')).toBeNull()
    await user.click(screen.getByTestId('goal-cancel'))
    expect(screen.getByTestId('mode-cycle')).toBeTruthy()
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
    // `renderApp` supplies the router through `wrapper`, so a rerender keeps
    // it — passing another one here would nest two Routers.
    rerender(<ChatControls agent={agent({ sessionId: 'a', status: 'busy' })} />)
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
