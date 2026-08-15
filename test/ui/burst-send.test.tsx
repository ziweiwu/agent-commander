/**
 * INV-2: a message is sent exactly once.
 *
 * React state cannot promise that on its own. `draft` is read from a closure
 * and `setDraft('')` does not land until React flushes, so several Enter
 * keydowns delivered in a single batch — OS key repeat, a double click on Send,
 * or input queued up behind a busy main thread — each read the same uncleared
 * draft and each sent it. Three identical instructions reached a live agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Chat } from '../../src/web/components/Chat.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'

const sendMessage = vi.hoisted(() => vi.fn())
vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage,
  sendKey: vi.fn(),
  sendText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
}))

beforeEach(() => {
  resetStore()
  sendMessage.mockClear()
})

/** Type the way a browser does, so React's change detection actually fires. */
function type(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const enter = (el: HTMLTextAreaElement): void => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

describe('burst send', () => {
  it('sends once when Enter fires three times before React flushes', () => {
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

    act(() => type(input, 'hello there'))
    act(() => {
      enter(input)
      enter(input)
      enter(input)
    })

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('hello there')
  })

  it('sends once when Send is clicked three times in one batch', () => {
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    const send = screen.getByTestId('composer-send')

    act(() => type(input, 'ship it'))
    act(() => {
      send.click()
      send.click()
      send.click()
    })

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('ship it')
  })

  // The guard must not become a lockout: a second, deliberate message still goes.
  it('still sends the next message the user actually types', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

    act(() => type(input, 'first'))
    act(() => enter(input))
    await user.type(input, 'second')
    await user.click(screen.getByTestId('composer-send'))

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenNthCalledWith(1, 'first')
    expect(sendMessage).toHaveBeenNthCalledWith(2, 'second')
  })

  // A chip has no draft to clear, and a double tap is two separate tasks that
  // no same-batch check would catch.
  it('sends one message when a quick prompt is double-clicked', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    const chip = screen.getAllByTestId('quick-prompt')[0] as HTMLElement

    await user.click(chip)
    await user.click(chip)

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('continue')
  })

  // The guard is per agent: the same prompt sent to two agents in quick
  // succession is two instructions, not a stutter.
  it('does not swallow the same prompt sent to a different agent', async () => {
    const user = userEvent.setup()
    const { rerender } = renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    await user.click(screen.getAllByTestId('quick-prompt')[0] as HTMLElement)

    rerender(<Chat agent={agent({ sessionId: 'b' })} />)
    await user.click(screen.getAllByTestId('quick-prompt')[0] as HTMLElement)

    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  // Different chips are different intentions, not a mis-tap.
  it('does not swallow a different prompt clicked straight after', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    const chips = screen.getAllByTestId('quick-prompt')

    await user.click(chips[0] as HTMLElement)
    await user.click(chips[2] as HTMLElement)

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenNthCalledWith(2, 'run the tests')
  })
})
