/**
 * Interrupting from the conversation, and choosing what Send does to a working
 * agent.
 *
 * `Escape` destroys whatever the agent had in flight, so INV-6 says it may not
 * reach a live session unless a human said so. The standalone stop asks every
 * time, because it is its own act. Interrupt *mode* asks once, when it is
 * armed, and the Send button then relabels to say what it will do — a modal in
 * front of every message is one people learn to dismiss without reading, which
 * guards less than a single deliberate choice.
 *
 * What these pin down is the boundary itself: nothing may send an unconfirmed
 * `Escape`, and queue mode may not send one at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Chat } from '../../src/web/components/Chat.tsx'
import { agent, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'
import type { Agent } from '../../src/shared/types.ts'
import { MODES } from '../../src/web/lib/modes.ts'

const transport = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendConfirmedKey: vi.fn(),
  interruptAndSend: vi.fn(),
  sendShiftTab: vi.fn(async () => ({ ok: true, detail: 'sent' } as const)),
}))

vi.mock('../../src/web/store/transport.ts', () => ({
  ...transport,
  sendKey: vi.fn(),
  sendText: vi.fn(),
  flushText: vi.fn(),
  setAttached: vi.fn(),
  setAgentGoal: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

const working = (over: Partial<Agent> = {}): Agent =>
  agent({ sessionId: 'a', status: 'busy', paneId: '%1', permissionMode: 'default', ...over })

/** Reopen from scratch: a second mount would leave two composers on screen. */
function open(subject: Agent) {
  cleanup()
  resetStore()
  return render(
    <MemoryRouter>
      <Chat agent={subject} />
    </MemoryRouter>,
  )
}

/*
 * jsdom does not reliably expose storage here, and the per-agent memory is
 * exactly what two of these tests are about — so it is stubbed rather than
 * assumed, the same way `test/prefs-filter.test.ts` does it.
 */
const store = new Map<string, string>()

beforeEach(() => {
  setViewport(() => false)
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  })
  for (const fn of Object.values(transport)) fn.mockClear()
  // Restored first: spying on an existing spy stacks them, and the call count
  // then carries over from the previous test.
  vi.restoreAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('the standalone interrupt', () => {
  it('asks first, then sends a confirmed Escape', async () => {
    const user = userEvent.setup()
    open(working())

    await user.click(screen.getByTestId('chat-interrupt'))

    expect(window.confirm).toHaveBeenCalledOnce()
    expect(transport.sendConfirmedKey).toHaveBeenCalledWith('Escape')
  })

  it('sends nothing when the confirmation is declined', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    open(working())

    await user.click(screen.getByTestId('chat-interrupt'))

    expect(transport.sendConfirmedKey).not.toHaveBeenCalled()
  })

  // There is nothing to stop, and offering it would imply there was.
  it('is not offered at all on an agent that is not working', () => {
    open(working({ status: 'idle' }))
    expect(screen.queryByTestId('chat-interrupt')).toBeNull()
  })
})

describe('what Send does to a working agent', () => {
  it('queues by default, without ever sending an Escape', async () => {
    const user = userEvent.setup()
    open(working())

    await user.type(screen.getByTestId('composer-input'), 'try the other approach')
    await user.click(screen.getByTestId('composer-send'))

    expect(transport.sendMessage).toHaveBeenCalledWith('try the other approach')
    expect(transport.interruptAndSend).not.toHaveBeenCalled()
    expect(transport.sendConfirmedKey).not.toHaveBeenCalled()
  })

  it('interrupts once the mode is armed, and says so on the button', async () => {
    const user = userEvent.setup()
    open(working())

    await user.click(screen.getByTestId('send-mode-interrupt'))
    expect(window.confirm).toHaveBeenCalledOnce()

    await user.type(screen.getByTestId('composer-input'), 'stop and read this')
    expect(screen.getByTestId('composer-send').textContent).toBe('Interrupt & send')

    await user.click(screen.getByTestId('composer-send'))
    expect(transport.interruptAndSend).toHaveBeenCalledWith('stop and read this')
    expect(transport.sendMessage).not.toHaveBeenCalled()
  })

  it('stays in queue mode when the arming confirmation is declined', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    open(working())

    await user.click(screen.getByTestId('send-mode-interrupt'))

    expect(screen.getByTestId('send-mode-queue').getAttribute('aria-pressed')).toBe('true')
    await user.type(screen.getByTestId('composer-input'), 'hello')
    await user.click(screen.getByTestId('composer-send'))
    expect(transport.sendMessage).toHaveBeenCalled()
    expect(transport.interruptAndSend).not.toHaveBeenCalled()
  })

  // Interrupting something that is not running is not interrupting.
  it('sends normally in interrupt mode when the agent is idle', async () => {
    const user = userEvent.setup()
    open(working({ status: 'idle' }))

    await user.click(screen.getByTestId('send-mode-interrupt'))
    await user.type(screen.getByTestId('composer-input'), 'next task please')
    await user.click(screen.getByTestId('composer-send'))

    expect(transport.sendMessage).toHaveBeenCalledWith('next task please')
    expect(transport.interruptAndSend).not.toHaveBeenCalled()
  })
})

describe('the choice is remembered per agent', () => {
  it('survives reopening the same agent', async () => {
    const user = userEvent.setup()
    open(working())
    await user.click(screen.getByTestId('send-mode-interrupt'))

    open(working())
    expect(screen.getByTestId('send-mode-interrupt').getAttribute('aria-pressed')).toBe('true')
  })

  /*
   * The point of keying it per agent: arming interrupt on a scratch session
   * must not quietly arm it on a long-running one you would rather not cut off.
   */
  it('does not carry onto a different agent', async () => {
    const user = userEvent.setup()
    open(working())
    await user.click(screen.getByTestId('send-mode-interrupt'))

    open(working({ sessionId: 'b' }))
    expect(screen.getByTestId('send-mode-queue').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('Shift+Tab cycles the permission mode', () => {
  /*
   * The chord in the message box is the same act as the mode button beside it,
   * and now sends the same thing: one press, no target.
   *
   * It used to compute the next mode from the one the agent last reported and
   * ask the server to reach *that*. Wrong twice over — the cycle silently omits
   * modes that are unavailable, so the arithmetic named a mode that was not
   * next; and reaching a named mode is what made the whole control unreliable
   * (see `send_shift_tab` in `rust/src/control.rs`).
   */
  it('sends one press from the composer', async () => {
    const user = userEvent.setup()
    open(working({ status: 'idle', permissionMode: 'default' }))

    screen.getByTestId('composer-input').focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')

    expect(transport.sendShiftTab).toHaveBeenCalledOnce()
  })

  /*
   * INV-8's exception, from the keyboard. This sends a key rather than typing,
   * so unlike every other control it works mid-run — which is the only time
   * anyone reaches for it: you decide the next step needs plan mode while the
   * agent is running, not before you opened the tab.
   */
  it('works while the agent is working', async () => {
    const user = userEvent.setup()
    open(working({ status: 'busy', permissionMode: 'default' }))

    screen.getByTestId('composer-input').focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')

    expect(transport.sendShiftTab).toHaveBeenCalledOnce()
  })

  // Nothing about the press depends on where the session currently is, which is
  // the property that removed the wrap-around arithmetic along with its bug.
  it('sends the same press from the last mode in the cycle', async () => {
    const user = userEvent.setup()
    open(working({ permissionMode: MODES[MODES.length - 1] as string }))

    screen.getByTestId('composer-input').focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')

    expect(transport.sendShiftTab).toHaveBeenCalledExactlyOnceWith()
  })
})

/**
 * An IME's Enter belongs to the IME.
 *
 * Typing Chinese or Japanese goes through a composition: you type pinyin, the
 * input method offers candidates, and Enter commits the one you picked. That
 * Enter reaches the textarea as a real keydown carrying `isComposing`, and
 * without a guard it sent the half-composed buffer and swallowed the keypress
 * the IME was waiting for — so the message went out as raw pinyin and the
 * candidate never landed. This app translates itself into Chinese and follows
 * the conversation's language when offering quick replies, so those are exactly
 * its users.
 */
describe('Enter during IME composition', () => {
  it('does not send while a candidate is being composed', async () => {
    open(working({ status: 'idle' }))
    const box = screen.getByTestId('composer-input') as HTMLTextAreaElement

    fireEvent.change(box, { target: { value: 'nihao' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })

    expect(transport.sendMessage).not.toHaveBeenCalled()
  })

  it('still sends on a plain Enter', async () => {
    open(working({ status: 'idle' }))
    const box = screen.getByTestId('composer-input') as HTMLTextAreaElement

    fireEvent.change(box, { target: { value: 'ready' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(transport.sendMessage).toHaveBeenCalledWith('ready')
  })
})
