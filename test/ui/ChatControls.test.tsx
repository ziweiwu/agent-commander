/**
 * The two controls that sit above the message box: Shift+Tab, and the session
 * goal (`/goal`).
 *
 * The two are guarded differently, and INV-8 says why. Setting a goal types
 * into the agent's own prompt, so a busy agent is refused. Shift+Tab sends
 * `BTab`, a control key the agent handles wherever it is, so it stays available
 * mid-run — which is the only time anyone reaches for it. INV-2's "exactly
 * once" applies to both either way: each is an instruction to a live session,
 * however small the control that sends it looks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatControls } from '../../src/web/components/ChatControls.tsx'
import { agent, answer, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'

const setAgentGoal = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const))
const sendShiftTab = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, detail: 'sent' }) as { ok: true; detail?: string }),
)
const clearAgentContext = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, detail: 'session-after' }) as { ok: true; detail?: string }),
)
const compactAgentContext = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as { ok: true }))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('../../src/web/store/transport.ts', () => ({
  setAgentGoal,
  sendShiftTab,
  clearAgentContext,
  compactAgentContext,
}))
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}))

const GOAL = { condition: 'every test passes', met: false, at: 1_786_000_000_000 }

beforeEach(() => {
  resetStore()
  setAgentGoal.mockClear()
  sendShiftTab.mockClear()
  sendShiftTab.mockResolvedValue({ ok: true, detail: 'sent' })
  clearAgentContext.mockClear()
  compactAgentContext.mockClear()
  navigate.mockClear()
  clearAgentContext.mockResolvedValue({ ok: true, detail: 'session-after' })
})

describe('shift+tab', () => {
  /*
   * Two earlier shapes of this control both aimed at a *mode* — a `<select>`
   * that named one, then a button that pressed once and waited to be told
   * which one it reached — and both were reported as broken. Neither was wrong
   * about the key: `BTab` moves a live session exactly as it should. What
   * neither could do is see it, because Claude Code writes its permission mode
   * down at the end of a turn and a session at its prompt writes nothing.
   * `send_shift_tab` in `rust/src/control.rs` carries the measurement.
   *
   * So what is left to get wrong is the press, and only the press.
   */

  it('sends the chord from the chat, without opening the panel row', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)
    await user.click(screen.getByTestId('shift-tab'))
    expect(sendShiftTab).toHaveBeenCalledOnce()
  })

  /*
   * INV-8's exception. This sends `BTab` — a control key the agent handles
   * wherever it is — rather than typing into its prompt, so it is the one
   * control that stays available mid-run. That is when it is wanted: the
   * decision that the next step needs plan mode is made while the agent works.
   */
  it('stays available while the agent is busy', async () => {
    const user = userEvent.setup()
    renderApp(
      <ChatControls agent={agent({ sessionId: 'a', status: 'busy', permissionMode: 'default' })} />,
    )
    const button = screen.getByTestId('shift-tab') as HTMLButtonElement
    expect(button.disabled).toBe(false)

    await user.click(button)
    expect(sendShiftTab).toHaveBeenCalledOnce()
  })

  /*
   * The mode the session recorded is the session's claim, so the chat window
   * repeats it. Both surfaces get it from the one shared `ShiftTabButton`,
   * which is why this is asserted here rather than twice.
   */
  it('names the mode the agent last recorded', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'plan' })} />)
    expect(screen.getByTestId('shift-tab-mode').textContent).toMatch(/plan/i)
  })

  /*
   * INV-11. An agent that has not taken a turn has written no `permission-mode`
   * record, and there is nothing to substitute for it: no "unknown", no assumed
   * `default`. Either would be this app naming a mode it was never told.
   */
  it('names no mode when the agent has recorded none', () => {
    const unreported = agent({ sessionId: 'a' })
    delete (unreported as { permissionMode?: string }).permissionMode
    renderApp(<ChatControls agent={unreported} />)

    expect(screen.queryByTestId('shift-tab-mode')).toBeNull()
    expect(screen.getByTestId('shift-tab').textContent).not.toMatch(/mode|unknown/i)
  })

  /*
   * A mode from a newer Claude Code than this build knows about is echoed
   * rather than dropped — `modeLabel`'s fallback, which is what keeps the
   * readout a report of the session instead of a filter on it.
   */
  it('echoes a mode it has no label for', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'someFutureMode' })} />)
    expect(screen.getByTestId('shift-tab-mode').textContent).toBe('someFutureMode')
  })

  /*
   * INV-11, and the half of the old design that has to survive the readout
   * being there at all. The press is not a mode switch this app can observe:
   * Claude Code writes the record at the end of a turn, so pressing must leave
   * the readout exactly where the session left it and claim nothing about
   * where it landed. A button that moved its own label here would be the
   * stale-name bug that got the previous two versions reported as broken.
   */
  it('leaves the recorded mode alone when the chord is sent', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'plan' })} />)

    await user.click(screen.getByTestId('shift-tab'))

    expect(screen.getByTestId('shift-tab-mode').textContent).toMatch(/plan/i)
    expect(useStore.getState().toast).not.toMatch(/plan/i)
  })

  // It still says the key went out, because that much is known.
  it('confirms the press', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)
    await user.click(screen.getByTestId('shift-tab'))
    expect(useStore.getState().toast).toMatch(/shift\+tab sent/i)
  })

  /*
   * INV-2's "exactly once", applied to a control. Two clicks in one React batch
   * both read `pending` before it flushes; the ref is what stops the second
   * sending another Shift+Tab into a live session.
   */
  it('sends one press from a double click', async () => {
    const user = userEvent.setup()
    sendShiftTab.mockReturnValue(new Promise(() => {}) as never)
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'default' })} />)

    const button = screen.getByTestId('shift-tab')
    await user.click(button)
    await user.click(button)

    expect(sendShiftTab).toHaveBeenCalledOnce()
  })

  // Reachability is still required: no pane, nothing to send the key to.
  it('is unavailable on an agent with no pane', () => {
    const noPane = agent({ sessionId: 'a', status: 'busy' })
    delete (noPane as { paneId?: string }).paneId
    renderApp(<ChatControls agent={noPane} />)
    expect((screen.getByTestId('shift-tab') as HTMLButtonElement).disabled).toBe(true)
  })

  // The glyph alone does not say what pressing it will do.
  it('says what the chord does for a screen reader', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'plan' })} />)
    const label = screen.getByTestId('shift-tab').getAttribute('aria-label') ?? ''
    expect(label).toMatch(/shift\+tab/i)
    expect(label).toMatch(/permission mode/i)
    /* The mode is drawn `aria-hidden` so it is not announced twice, which makes
       the accessible name the only place a screen reader can hear it. */
    expect(label).toMatch(/plan/i)
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
   * On a 390px phone the mode control pushed Set and Cancel off the end of the
   * strip's scroller, leaving no visible way to finish typing a goal.
   */
  it('gives the whole strip to the goal field while it is open', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={agent({ sessionId: 'a', permissionMode: 'plan' })} />)
    await user.click(screen.getByTestId('goal-toggle'))
    expect(screen.queryByTestId('shift-tab')).toBeNull()
    // The memory actions go with it: on a 390px phone anything left beside the
    // field pushes Set and Cancel off the end of the scroller.
    expect(screen.queryByTestId('clear-agent')).toBeNull()
    expect(screen.queryByTestId('compact-agent')).toBeNull()
    await user.click(screen.getByTestId('goal-cancel'))
    expect(screen.getByTestId('shift-tab')).toBeTruthy()
    expect(screen.getByTestId('clear-agent')).toBeTruthy()
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

/*
 * Clear and compact from the composer strip.
 *
 * They exist in the detail panel's row too. They are repeated here because
 * that row is above the tabs, collapses behind `⋯` below 900px, and is not
 * rendered at all in full screen — which is where a conversation gets long
 * enough to want clearing. Both surfaces run the same `useContextActions`, and
 * these tests exist to prove the strip really does get the whole sequence and
 * not a hopeful copy of half of it.
 */
describe('clear and compact from the composer strip', () => {
  const idle = () => agent({ sessionId: 'session-before', status: 'idle', paneId: '%1' })

  it('asks before discarding, and sends nothing when the answer is no', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={idle()} />)
    await user.click(screen.getByTestId('clear-agent'))
    await answer(user, 'cancel')
    expect(clearAgentContext).not.toHaveBeenCalled()
  })

  /*
   * The case a copy-paste would have lost. `/clear` replaces the session rather
   * than editing it, so the id on screen stops existing; without following it
   * the route bails to the fleet and, from the user's side, the panel closed
   * itself.
   */
  it('follows the agent to the session id it is now running', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={idle()} />)
    await user.click(screen.getByTestId('clear-agent'))
    await answer(user, 'accept')
    expect(clearAgentContext).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/agent/session-after', { replace: true })
  })

  // INV-11: nothing was read, so nothing is claimed — and navigating on that
  // claim would land on an id that may not exist.
  it('stays put when no new session appeared', async () => {
    const user = userEvent.setup()
    clearAgentContext.mockResolvedValue({ ok: true, detail: 'unverified' })
    renderApp(<ChatControls agent={idle()} />)
    await user.click(screen.getByTestId('clear-agent'))
    await answer(user, 'accept')
    expect(navigate).not.toHaveBeenCalled()
  })

  // INV-2 through this surface: the second clear would discard the fresh
  // session the first one just created.
  it('sends one clear from a double click', async () => {
    const user = userEvent.setup()
    clearAgentContext.mockReturnValue(new Promise(() => {}) as never)
    renderApp(<ChatControls agent={idle()} />)
    await user.click(screen.getByTestId('clear-agent'))
    const accept = await screen.findByTestId('confirm-accept')
    await user.click(accept)
    await user.click(accept).catch(() => {})
    expect(clearAgentContext).toHaveBeenCalledOnce()
  })

  // Compaction shortens the context rather than discarding it, and Claude Code
  // does it unprompted when the window fills. Nothing to confirm.
  it('does not ask before compacting', async () => {
    const user = userEvent.setup()
    renderApp(<ChatControls agent={idle()} />)
    await user.click(screen.getByTestId('compact-agent'))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    expect(compactAgentContext).toHaveBeenCalledOnce()
  })

  // INV-8: both type into the agent's own prompt, so both wait for idle.
  it('refuses both while the agent is busy, because both type', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', status: 'busy', paneId: '%1' })} />)
    expect((screen.getByTestId('clear-agent') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('compact-agent') as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers neither to an agent with no pane', () => {
    renderApp(
      <ChatControls agent={agent({ sessionId: 'a', status: 'idle', paneId: undefined })} />,
    )
    expect((screen.getByTestId('clear-agent') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('compact-agent') as HTMLButtonElement).disabled).toBe(true)
  })

  // INV-7: these type a Claude Code slash command. For another CLI they are not
  // a disabled feature but a wrong one.
  it('does not offer them for a CLI that takes no slash commands', () => {
    renderApp(<ChatControls agent={agent({ sessionId: 'a', agentKind: 'kiro', paneId: '%1' })} />)
    expect(screen.queryByTestId('clear-agent')).toBeNull()
    expect(screen.queryByTestId('compact-agent')).toBeNull()
  })
})
