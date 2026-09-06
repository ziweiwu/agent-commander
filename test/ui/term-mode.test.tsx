/**
 * The mode chord on the surface that is the terminal.
 *
 * Shift+Tab is how Claude Code's own keyboard cycles the permission mode, and
 * deciding "this next step should run in plan mode" happens while watching the
 * agent work — which is the Attach tab. It was reachable only from the Chat
 * tab's composer, and a phone has no hardware keyboard to send the chord with
 * either, so from the terminal the mode could not be changed at all.
 *
 * It goes through the control action the server composes rather than as a key:
 * `BTab` is deliberately not on `ALLOWED_KEYS` (INV-8). Into a CLI that does
 * not speak Claude Code's chords it is a stray keystroke, so INV-7's gate
 * applies here as everywhere else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Terminal } from '../../src/web/components/Terminal.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'

const sendShiftTab = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const))
vi.mock('../../src/web/store/transport.ts', () => ({
  sendShiftTab,
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendText: vi.fn(),
  setAttached: vi.fn(),
  requestHistory: vi.fn(),
}))

const noop = (): void => {}
const open = (over = {}) =>
  renderApp(<Terminal agent={agent({ sessionId: 'a', paneId: '%1', ...over })} onExit={noop} />)

beforeEach(() => {
  resetStore()
  sendShiftTab.mockClear()
})

describe('the terminal offers the mode chord', () => {
  it('puts it in the key bar for a CLI that speaks it', () => {
    open()
    expect(screen.queryByTestId('shift-tab')).not.toBeNull()
  })

  it('withholds it from a CLI that does not', () => {
    open({ agentKind: 'kiro' })
    expect(screen.queryByTestId('shift-tab')).toBeNull()
  })

  it('sends it once when the button is pressed', async () => {
    const user = userEvent.setup()
    open()
    await user.click(screen.getByTestId('shift-tab'))
    await waitFor(() => expect(sendShiftTab).toHaveBeenCalledTimes(1))
  })
})
