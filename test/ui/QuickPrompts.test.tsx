/**
 * The replies that get typed over and over, offered as a row of chips above the
 * composer.
 *
 * The property that matters most is INV-2: picking a chip is one deliberate
 * action that sends one message, and nothing else reaches the agent. In
 * particular a chip must not quietly pick up whatever is half-typed in the box.
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
}))

beforeEach(() => {
  resetStore()
  sendMessage.mockClear()
})

/** The leading ➤ is decorative — it signals "this sends", it is not the text. */
const label = (chip: HTMLElement): string => (chip.textContent ?? '').replace('➤', '').trim()

describe('quick prompts', () => {
  it('offers the common replies', () => {
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    expect(screen.getAllByTestId('quick-prompt').map(label)).toEqual([
      'continue',
      'yes, go ahead',
      'run the tests',
      "what's blocking you?",
      'summarise where you are',
    ])
  })

  it('sends the chip that was picked, and only that', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    await user.click(screen.getByRole('button', { name: 'Send “continue”' }))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('continue')
  })

  // What is in the box is the user's, not an argument to the chip.
  it('leaves a half-typed draft untouched', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await user.type(input, 'a longer thought I am still writing')
    await user.click(screen.getByRole('button', { name: 'Send “continue”' }))

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('continue')
    expect(input.value).toBe('a longer thought I am still writing')
  })

  // The chip reads like something that fills the box in. Its accessible name
  // has to say that it sends, or a screen reader user cannot tell.
  it('announces that picking one sends it', () => {
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    expect(screen.getByRole('group', { name: 'Common replies' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send “run the tests”' })).toBeTruthy()
  })

  // No pane means nothing can be typed into, so offering the replies would be
  // offering an action that cannot work.
  it('is hidden for an agent with no terminal', () => {
    renderApp(<Chat agent={agent({ sessionId: 'a', paneId: undefined })} />)
    expect(screen.queryAllByTestId('quick-prompt')).toEqual([])
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

    const chips = screen.getAllByTestId('quick-prompt')
    expect(label(chips[0] as HTMLElement)).toBe('继续')
    await user.click(chips[0] as HTMLElement)
    expect(sendMessage).toHaveBeenCalledWith('继续')
  })

  it('offers English prompts in an English conversation under a Chinese UI', () => {
    useStore.setState({
      lang: 'zh-CN',
      messages: buildMessages([
        { id: 'e1', at: Date.now() - 2000, kind: 'user', text: 'add a dark mode toggle' },
        { id: 'e2', at: Date.now() - 1000, kind: 'assistant', text: 'Getting oriented in the codebase.' },
      ]),
    })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    expect(label(screen.getAllByTestId('quick-prompt')[0] as HTMLElement)).toBe('continue')
  })

  // With no conversation to read, the interface language is the only cue left.
  it('falls back to the interface language in an empty chat', async () => {
    const user = userEvent.setup()
    useStore.setState({ lang: 'zh-CN' })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    const chips = screen.getAllByTestId('quick-prompt')
    expect(label(chips[0] as HTMLElement)).toBe('继续')
    await user.click(chips[0] as HTMLElement)
    expect(sendMessage).toHaveBeenCalledWith('继续')
  })
})
