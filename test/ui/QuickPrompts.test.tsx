/**
 * The replies that get typed over and over, offered from one menu beside the
 * composer.
 *
 * They were a row of five chips, and the row overflowed the strip at every
 * width the detail panel actually has — two of five out of sight at 1280px —
 * so the frequent shortcut was the one nobody could see. One press opens the
 * list; the property that matters most is still INV-2: picking one is one
 * deliberate action that sends one message, and nothing else reaches the
 * agent. In particular a reply must not quietly pick up whatever is half-typed
 * in the box.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Chat } from '../../src/web/components/Chat.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { buildMessages } from '../../src/web/lib/chat.ts'
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
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

beforeEach(() => {
  resetStore()
  sendMessage.mockClear()
})

/** The leading ➤ is decorative — it signals "this sends", it is not the text. */
const label = (item: HTMLElement): string => (item.textContent ?? '').replace('➤', '').trim()

/** Open the replies menu, the one press that precedes every reply. */
async function openReplies(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('quick-menu'))
}

describe('quick replies', () => {
  it('offers the common replies behind one menu', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    // Closed at rest: the strip carries one chip, not five.
    expect(screen.queryAllByTestId('quick-prompt')).toEqual([])
    await openReplies(user)
    expect(screen.getAllByTestId('quick-prompt').map(label)).toEqual([
      'continue',
      'yes, go ahead',
      'run the tests',
      "what's blocking you?",
      'summarise where you are',
    ])
  })

  it('sends the reply that was picked, and only that, then closes', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    await openReplies(user)
    await user.click(screen.getByRole('menuitem', { name: 'Send “continue”' }))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('continue')
    // One press, one reply: the list does not stay open inviting a second.
    expect(screen.queryAllByTestId('quick-prompt')).toEqual([])
    expect(screen.getByTestId('quick-menu').getAttribute('aria-expanded')).toBe('false')
  })

  // What is in the box is the user's, not an argument to the reply.
  it('leaves a half-typed draft untouched', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await user.type(input, 'a longer thought I am still writing')
    await openReplies(user)
    await user.click(screen.getByRole('menuitem', { name: 'Send “continue”' }))

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('continue')
    expect(input.value).toBe('a longer thought I am still writing')
  })

  // An item reads like something that fills the box in. Its accessible name
  // has to say that it sends, or a screen reader user cannot tell.
  it('announces that picking one sends it', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    const menu = screen.getByTestId('quick-menu')
    expect(menu.getAttribute('aria-haspopup')).toBe('menu')
    await openReplies(user)
    expect(screen.getByRole('menu', { name: 'Common replies' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Send “run the tests”' })).toBeTruthy()
  })

  /*
   * The chip sits at the right end of the strip and the list is pinned to its
   * left edge, so at a desktop width the list ran past the viewport and
   * clipped its last two replies. jsdom lays nothing out, so the measurement
   * is stubbed: a list that would end 100px past the edge is shifted back.
   */
  it('stays inside the viewport when the chip is near the right edge', async () => {
    const user = userEvent.setup()
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      // The list is measured after it renders; the anchor is the chip's box.
      if (this.getAttribute('role') === 'menu') {
        return { left: 1100, top: 400, width: 280, height: 200, right: 1380, bottom: 600 } as DOMRect
      }
      if (this.querySelector(':scope > [data-testid="quick-menu"]')) {
        return { left: 1100, top: 700, width: 80, height: 30, right: 1180, bottom: 730 } as DOMRect
      }
      return original.call(this)
    }
    try {
      await openReplies(user)
      const list = screen.getByRole('menu', { name: 'Common replies' }) as HTMLElement
      // 1100 + 280 = 1380 overshoots 1280 - 8 by 108, so the list moves left by that.
      expect(list.style.left).toBe('992px')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original
    }
  })

  /*
   * No focus() call here: this is what a click-to-open leaves behind. The
   * first version of this test focused a menu item by hand before pressing
   * Escape, which tested the guard only in a state a real click never
   * reached — and in the real one Escape closed the whole agent panel.
   */
  it('moves focus into the list, and Escape closes the list and nothing else', async () => {
    const user = userEvent.setup()
    useStore.setState({ selected: 'a' })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    await openReplies(user)
    expect(document.activeElement).toBe(screen.getAllByTestId('quick-prompt')[0])
    await user.keyboard('{Escape}')
    expect(screen.queryAllByTestId('quick-prompt')).toEqual([])
    // Still on the agent: Escape stopped at the menu.
    expect(useStore.getState().selected).toBe('a')
    // And focus is back where the list was opened from.
    expect(document.activeElement).toBe(screen.getByTestId('quick-menu'))
  })

  it('closes on Escape from the chip itself, before focus has moved', async () => {
    const user = userEvent.setup()
    useStore.setState({ selected: 'a' })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    await openReplies(user)
    screen.getByTestId('quick-menu').focus()
    await user.keyboard('{Escape}')
    expect(screen.queryAllByTestId('quick-prompt')).toEqual([])
    expect(useStore.getState().selected).toBe('a')
  })

  // No pane means nothing can be typed into, so offering the replies would be
  // offering an action that cannot work.
  it('is hidden for an agent with no terminal', () => {
    renderApp(<Chat agent={agent({ sessionId: 'a', paneId: undefined })} />)
    expect(screen.queryByTestId('quick-menu')).toBeNull()
  })

  /*
   * The prompt is a message to the agent, not label text, so it follows the
   * conversation rather than the interface. Reading an English UI is no reason
   * to send an agent that is working in Chinese an English instruction.
   */
  it('offers Chinese prompts in a Chinese conversation under an English UI', async () => {
    const user = userEvent.setup()
    useStore.setState({
      lang: 'en',
      messages: buildMessages([
        { id: 'e1', at: Date.now() - 2000, kind: 'user', text: '帮我把深色模式的开关加到页面顶部' },
        { id: 'e2', at: Date.now() - 1000, kind: 'assistant', text: '好的，我先看一下现在的代码结构。' },
      ]),
    })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    await openReplies(user)
    const items = screen.getAllByTestId('quick-prompt')
    expect(label(items[0] as HTMLElement)).toBe('继续')
    await user.click(items[0] as HTMLElement)
    expect(sendMessage).toHaveBeenCalledWith('继续')
  })

  it('offers English prompts in an English conversation under a Chinese UI', async () => {
    const user = userEvent.setup()
    useStore.setState({
      lang: 'zh-CN',
      messages: buildMessages([
        { id: 'e1', at: Date.now() - 2000, kind: 'user', text: 'add a dark mode toggle' },
        { id: 'e2', at: Date.now() - 1000, kind: 'assistant', text: 'Getting oriented in the codebase.' },
      ]),
    })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    await openReplies(user)
    expect(label(screen.getAllByTestId('quick-prompt')[0] as HTMLElement)).toBe('continue')
  })
})
