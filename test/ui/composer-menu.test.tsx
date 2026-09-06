/**
 * The composer's menu: one button beside Send, holding everything that is not
 * typing.
 *
 * It replaced a permanent row above the message box. That row cost 50px of
 * every screen at rest — 6% of a phone — and could not show what it held:
 * measured at 500px wide, its children came to 721px inside a 450px sideways
 * scroller, so most of what it exposed was already past the end of a scroll
 * nobody could see. A row that is both the most expensive thing on the screen
 * and unable to display its own contents is a menu that has not been written
 * yet. INV-17 allows the fold because the button is on screen and named.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Chat } from '../../src/web/components/Chat.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'

const clearAgentContext = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, detail: 'session-after' }) as { ok: true; detail?: string }),
)
vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendText: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  flushText: vi.fn(),
  setAttached: vi.fn(),
  focusAgent: vi.fn(),
  answerPrompt: vi.fn(),
  interruptAgent: vi.fn(async () => ({ ok: true })),
  setAgentGoal: vi.fn(async () => ({ ok: true })),
  sendShiftTab: vi.fn(async () => ({ ok: true })),
  setAgentModel: vi.fn(async () => ({ ok: true })),
  compactAgentContext: vi.fn(async () => ({ ok: true })),
  clearAgentContext,
}))

/** Everything the menu is the only home for. */
const IN_THE_MENU = [
  'quick-prompt',
  'send-mode-queue',
  'send-mode-interrupt',
  'shift-tab',
  'model-select',
  'goal-toggle',
  'compact-agent',
  'clear-agent',
]

const open = () => renderApp(<Chat agent={agent({ sessionId: 'a', paneId: '%1' })} />)

beforeEach(() => {
  resetStore()
  clearAgentContext.mockClear()
})

describe('the composer menu', () => {
  it('holds everything that is not typing, behind one named button', async () => {
    const user = userEvent.setup()
    open()
    const toggle = screen.getByTestId('strip-toggle')
    // 4.1.2: the glyph is not the name.
    expect(toggle.getAttribute('aria-label')).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    for (const id of IN_THE_MENU) expect(screen.queryAllByTestId(id)).toEqual([])

    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const missing = IN_THE_MENU.filter((id) => screen.queryAllByTestId(id).length === 0)
    expect(missing, `not in the menu: ${missing.join(', ')}`).toEqual([])
  })

  /*
   * INV-11, and the other half of the detail line's silence: the mode is not
   * guessed anywhere, and the one place that still says it has not been
   * reported is the control that changes it.
   */
  it('says the mode has not been reported, on the control that changes it', async () => {
    const user = userEvent.setup()
    open()
    await user.click(screen.getByTestId('strip-toggle'))
    expect(screen.getByTestId('shift-tab').textContent).toMatch(/not reported/i)
  })

  it('leaves the message box and Send on the face, where typing happens', () => {
    open()
    expect(screen.getByTestId('composer-input')).toBeTruthy()
    expect(screen.getByTestId('composer-send')).toBeTruthy()
  })

  /*
   * Clear asks before it acts, and its confirmation is portalled to the body —
   * so the press on "Clear it" lands outside the panel. Treated as a press
   * away, it closed the menu, unmounted the controls that owned the dialog,
   * and took the dialog with them: a destructive action that quietly did
   * nothing, which is worse than one that fails loudly.
   */
  it('stays open for a dialog it raised, so the action can be confirmed', async () => {
    const user = userEvent.setup()
    open()
    await user.click(screen.getByTestId('strip-toggle'))
    await user.click(screen.getByTestId('clear-agent'))
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(dialog).toBeTruthy()

    await user.click(screen.getByTestId('confirm-accept'))
    expect(clearAgentContext).toHaveBeenCalledTimes(1)
  })
})
