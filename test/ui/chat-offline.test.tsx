/**
 * The composer with the socket down.
 *
 * `transport.send()` returns without doing anything when the socket is not
 * open, which is correct — INV-2's one prohibition is replaying input into a
 * live agent, so a queue is not an option. But the composer used to accept the
 * message anyway: it cleared the box, marked the message `sending…`, and twelve
 * seconds later called it `not delivered`. The fleet list and the tree both
 * caption a disconnected view; this is the one surface where a user *acts*, and
 * it said nothing at all (INV-11).
 *
 * The bargain is only acceptable if the refusal is loud where the action is and
 * the draft survives. "We didn't send it and we didn't keep it" is the worst
 * outcome available: the person has to retype from memory, and what they retype
 * is not what they wrote.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Chat } from '../../src/web/components/Chat.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'

const sendMessage = vi.hoisted(() => vi.fn())
const sendConfirmedKey = vi.hoisted(() => vi.fn())

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage,
  sendConfirmedKey,
  sendKey: vi.fn(),
  sendText: vi.fn(),
  flushText: vi.fn(),
  interruptAndSend: vi.fn(),
  loadEnv: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  setAgentGoal: vi.fn(),
  clearAgentGoal: vi.fn(),
  sendShiftTab: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

const busy = () => agent({ sessionId: 'a', status: 'busy', paneId: '%1' })

beforeEach(() => {
  resetStore()
  sendMessage.mockClear()
  sendConfirmedKey.mockClear()
})

describe('INV-2 the composer refuses rather than pretending, with the socket down', () => {
  it('keeps every character of the draft when a send cannot go', async () => {
    const user = userEvent.setup()
    useStore.setState({ conn: 'closed' })
    renderApp(<Chat agent={busy()} />)

    const box = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await user.click(box)
    await user.type(box, 'rebuild the index from scratch')
    await user.keyboard('{Enter}')

    expect(sendMessage).not.toHaveBeenCalled()
    expect(box.value).toBe('rebuild the index from scratch')
  })

  it('says so at the composer, not only in the header chip', async () => {
    useStore.setState({ conn: 'closed' })
    renderApp(<Chat agent={busy()} />)

    // The keyboard hint is replaced rather than supplemented: Enter no longer
    // sends, so leaving that promise up would be a claim the app cannot keep.
    expect(screen.queryByTestId('composer-hint')).toBeNull()
    expect(screen.getByTestId('composer-offline')).toBeTruthy()
  })

  it('reaches someone arriving by keyboard, not just someone who can see grey', async () => {
    useStore.setState({ conn: 'closed' })
    renderApp(<Chat agent={busy()} />)

    const described = screen.getByTestId('composer-input').getAttribute('aria-describedby')
    expect(described).toBeTruthy()
    expect(document.getElementById(described as string)).toBeTruthy()
  })

  it('does not offer to interrupt an agent it cannot reach', async () => {
    useStore.setState({ conn: 'closed' })
    renderApp(<Chat agent={busy()} />)

    const stop = screen.queryByTestId('chat-interrupt') as HTMLButtonElement | null
    if (stop) expect(stop.disabled).toBe(true)
    expect(sendConfirmedKey).not.toHaveBeenCalled()
  })

  it('sends the preserved draft once the connection is back', async () => {
    const user = userEvent.setup()
    useStore.setState({ conn: 'closed' })
    const { rerender } = renderApp(<Chat agent={busy()} />)

    const box = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await user.click(box)
    await user.type(box, 'carry on')
    await user.keyboard('{Enter}')
    expect(sendMessage).not.toHaveBeenCalled()

    useStore.setState({ conn: 'open' })
    rerender(<Chat agent={busy()} />)
    await user.click(screen.getByTestId('composer-input'))
    await user.keyboard('{Enter}')

    // Sent because the person sent it again — never replayed on reconnect.
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
