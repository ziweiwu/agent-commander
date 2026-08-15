/**
 * A message sent from the browser is echoed locally so sending feels instant,
 * and dropped again once the agent writes it into its own transcript. What was
 * missing was the third case: the echo that is never confirmed. It said
 * "sending…" for ever, which reads as "still on its way" rather than "this may
 * never have arrived".
 *
 * INV-2 is the constraint that shapes the fix — nothing may reach a live agent
 * without an explicit user action, so an unconfirmed message is *marked*, never
 * resent. These tests hold that line as much as they hold the marking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../src/web/store/store.ts'

const CONFIRMED_TEXT = 'add a dark mode toggle'

describe('unconfirmed messages', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useStore.getState().resetConversation()
  })

  it('shows a sent message as pending straight away', () => {
    useStore.getState().addPending(CONFIRMED_TEXT)
    const [message] = useStore.getState().messages
    expect(message?.text).toBe(CONFIRMED_TEXT)
    expect(message?.pending).toBe(true)
    expect(message?.failed).toBeUndefined()
  })

  it('marks it not delivered once the transcript has stayed silent', () => {
    useStore.getState().addPending(CONFIRMED_TEXT)
    vi.advanceTimersByTime(12_000)
    const [message] = useStore.getState().messages
    expect(message?.failed).toBe(true)
    // Two states, not two flags — leaving `pending` set made the rendering
    // depend on which CSS rule happened to be declared last.
    expect(message?.pending).toBe(false)
    // Still readable: the user may want to copy it and send it again by hand.
    expect(message?.text).toBe(CONFIRMED_TEXT)
  })

  it('leaves it alone while the timeout has not elapsed', () => {
    useStore.getState().addPending(CONFIRMED_TEXT)
    vi.advanceTimersByTime(11_000)
    expect(useStore.getState().messages[0]?.failed).toBeUndefined()
  })

  // The whole point of the echo: the transcript confirming it makes it a real
  // message, and the marker must not fire afterwards.
  it('never marks a message the transcript confirmed first', () => {
    useStore.getState().addPending(CONFIRMED_TEXT)
    useStore.setState({
      events: [{ id: 'e1', at: Date.now(), kind: 'user', text: CONFIRMED_TEXT }],
    })
    useStore.getState().rebuildChat()
    vi.advanceTimersByTime(60_000)
    const [message] = useStore.getState().messages
    expect(message?.pending).toBeUndefined()
    expect(message?.failed).toBeUndefined()
    expect(useStore.getState().pending).toEqual([])
  })

  // INV-2: marking is display-only. Nothing is queued for a retry.
  it('does not resend or re-queue an unconfirmed message', () => {
    useStore.getState().addPending(CONFIRMED_TEXT)
    vi.advanceTimersByTime(120_000)
    expect(useStore.getState().pending).toHaveLength(1)
    expect(useStore.getState().messages).toHaveLength(1)
  })

  // Switching agents must not carry one agent's timer into another's chat.
  it('drops pending timers when the conversation resets', () => {
    useStore.getState().addPending(CONFIRMED_TEXT)
    useStore.getState().resetConversation()
    vi.advanceTimersByTime(60_000)
    expect(useStore.getState().messages).toEqual([])
    expect(useStore.getState().pending).toEqual([])
  })
})
