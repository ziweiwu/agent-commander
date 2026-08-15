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

const seed = () =>
  buildMessages([
    { id: 'e1', at: Date.now() - 60_000, kind: 'user', text: 'add dark mode' },
    { id: 'e2', at: Date.now() - 50_000, kind: 'assistant', text: 'Getting oriented.' },
    { id: 'e3', at: Date.now() - 40_000, kind: 'tool', tool: 'Read', text: 'src/app.ts' },
  ])

beforeEach(() => {
  resetStore()
  sendMessage.mockClear()
})

describe('Chat', () => {
  it('attributes both speakers', () => {
    useStore.setState({ messages: seed() })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    const authors = screen.getAllByTestId('message-author').map((el) => el.textContent)
    expect(authors).toContain('You')
    expect(authors).toContain('Agent')
    expect(screen.getByText('add dark mode')).toBeDefined()
  })

  it('folds tool calls into the reply that produced them', () => {
    useStore.setState({ messages: seed() })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    expect(screen.getByTestId('tool-call').textContent).toContain('Read')
  })

  it('sends on Enter', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    await user.type(screen.getByTestId('composer-input'), 'hello there')
    await user.keyboard('{Enter}')

    expect(sendMessage).toHaveBeenCalledWith('hello there')
    expect(screen.getByTestId<HTMLTextAreaElement>('composer-input').value).toBe('')
  })

  // Shift+Enter is a newline; sending on it would fire off half-written messages.
  it('does not send on Shift+Enter', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    await user.type(screen.getByTestId('composer-input'), 'first line')
    await user.keyboard('{Shift>}{Enter}{/Shift}')

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('will not send an empty or whitespace-only message', async () => {
    const user = userEvent.setup()
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)

    await user.type(screen.getByTestId('composer-input'), '   ')
    await user.keyboard('{Enter}')

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('disables the composer for an agent that cannot be attached to', () => {
    renderApp(<Chat agent={agent({ sessionId: 'a', paneId: undefined })} />)
    expect(screen.getByTestId<HTMLTextAreaElement>('composer-input').disabled).toBe(true)
  })

  it('shows a working indicator only while the agent is busy', () => {
    useStore.setState({ messages: seed() })
    const { rerender } = renderApp(<Chat agent={agent({ sessionId: 'a', status: 'busy' })} />)
    expect(screen.queryByTestId('working-indicator')).not.toBeNull()

    rerender(<Chat agent={agent({ sessionId: 'a', status: 'idle' })} />)
    expect(screen.queryByTestId('working-indicator')).toBeNull()
  })

  it('renders a pending message as sending', () => {
    useStore.setState({
      messages: [
        {
          id: 'pending-0',
          role: 'you',
          at: Date.now(),
          text: 'just sent',
          tools: [],
          grouped: false,
          pending: true,
        },
      ],
    })
    renderApp(<Chat agent={agent({ sessionId: 'a' })} />)
    expect(screen.getByText('sending…')).toBeDefined()
  })
})
