/**
 * INV-11 on the conversation: an empty chat is three different claims.
 *
 * `messages` is empty before the transcript has arrived, when it cannot be
 * got at, and when the agent really has said nothing — and the app used to
 * discriminate on `conn`, which answers none of those. The socket is open for
 * the whole of the window in which the server finds the transcript, backfills
 * up to 256 KiB of it and sends it; over Tailscale from a phone that window is
 * seconds, and `onOpen` sets `conn: 'open'` *before* it even sends the
 * `focus` that asks. So the chat asserted "Nothing said yet. Send this agent a
 * message below…" at agents that were mid-sentence, every single reconnect.
 *
 * The fleet has had the right shape since INV-11's first-frame rule: it gates
 * on `fleetAt`, a timestamp only a server frame can write. This is its twin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { Chat } from '../../src/web/components/Chat.tsx'
import { emptyNotice } from '../../src/web/lib/chat.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendConfirmedKey: vi.fn(),
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

// Prompted once, so it has a conversation to load: the cases below are about
// one that exists and has not arrived, not one that has not begun.
const idle = () => agent({ sessionId: 'a', status: 'idle', paneId: '%1', lastPrompt: 'hi' })
const unprompted = () => agent({ sessionId: 'a', status: 'idle', paneId: '%1', name: 'scratch', cwd: '/tmp/scratch' })

beforeEach(() => {
  resetStore()
})

describe('emptyNotice', () => {
  it('waits while no frame has arrived, whatever the socket is doing', () => {
    expect(emptyNotice({ timelineAt: null, timelineStalledAt: null })).toBe('chatLoading')
  })

  it('claims emptiness only once a frame has said so', () => {
    expect(emptyNotice({ timelineAt: 1, timelineStalledAt: null })).toBe('chatEmpty')
  })

  it('stops saying "loading" about something that is not coming', () => {
    expect(emptyNotice({ timelineAt: null, timelineStalledAt: 1 })).toBe('chatUnreachable')
  })

  /*
   * The ordering that matters: a conversation that arrived and *then* stalled
   * — the re-asks ran out against a later reconnect — is still a conversation
   * this app has read. It is empty, and saying "could not be loaded" about it
   * would be the same over-claim in the other direction.
   */
  it('prefers what it has read over what it failed to re-read', () => {
    expect(emptyNotice({ timelineAt: 1, timelineStalledAt: 1 })).toBe('chatEmpty')
  })

  it('says a conversation has not begun rather than that it is loading', () => {
    for (const timelineStalledAt of [null, 1]) {
      expect(emptyNotice({ timelineAt: null, timelineStalledAt, fresh: 'unprompted' })).toBe('chatFirstPrompt')
      expect(emptyNotice({ timelineAt: null, timelineStalledAt, fresh: 'starting' })).toBe('chatStarting')
    }
  })

  /**
   * F5: the task is quoted only while the agent is still starting. Once it
   * has registered, the transcript is the record of what it was given.
   */
  it('quotes a first task only while the agent is starting', () => {
    const task = 'fix the login bug'
    const unread = { timelineAt: null, timelineStalledAt: null }
    expect(emptyNotice({ ...unread, fresh: 'starting', task })).toBe('chatStartingTask')
    expect(emptyNotice({ ...unread, fresh: 'starting', task: '' })).toBe('chatStarting')
    expect(emptyNotice({ ...unread, fresh: 'unprompted', task })).toBe('chatFirstPrompt')
    expect(emptyNotice({ timelineAt: 1, timelineStalledAt: null, task })).toBe('chatEmpty')
  })
})

describe('the Chat tab', () => {
  it('does not claim the agent has said nothing while the socket is open and unanswered', () => {
    useStore.setState({ conn: 'open', selected: 'a', timelineAt: null, timelineStalledAt: null })
    renderApp(<Chat agent={idle()} />)
    expect(screen.getByTestId('chat-notice').textContent).toMatch(/Loading the conversation/)
  })

  it('claims it once a timeline frame has said zero', () => {
    useStore.setState({ conn: 'open', selected: 'a', timelineAt: Date.now() })
    renderApp(<Chat agent={idle()} />)
    expect(screen.getByTestId('chat-notice').textContent).toMatch(/Nothing said yet/)
  })

  /*
   * It may not say the agent has ended. `tail_once_it_exists` waits for a
   * transcript a freshly started agent has not written yet, so no frame
   * arrives for an agent that is plainly alive — and asserting it "may have
   * ended" about one that is sitting there working is the over-claim INV-11
   * exists to prevent, arrived at from the other direction.
   */
  it('says nothing has arrived yet, without claiming the agent has ended', () => {
    useStore.setState({
      conn: 'open',
      selected: 'a',
      timelineAt: null,
      timelineStalledAt: 1,
    })
    renderApp(<Chat agent={idle()} />)
    const notice = screen.getByTestId('chat-notice').textContent ?? ''
    expect(notice).toMatch(/Nothing has arrived/)
    expect(notice).toMatch(/only just started/)
    expect(notice).not.toMatch(/may have ended/)
  })

  /*
   * A session started and never prompted keeps no transcript, so the loading
   * notice never ended and then turned into "the server may have restarted".
   * The card already says why; the chat says the same, by name and folder.
   */
  it('names an unprompted session and asks for its first instruction', () => {
    useStore.setState({ conn: 'open', selected: 'a', timelineAt: null, timelineStalledAt: 1 })
    renderApp(<Chat agent={unprompted()} />)
    const notice = screen.getByTestId('chat-notice').textContent ?? ''
    expect(notice).toMatch(/scratch is ready in \/tmp\/scratch/)
    expect(notice).toMatch(/first instruction/)
    expect(notice).not.toMatch(/server may have restarted/)
  })

  it('points a session still starting at the Attach tab', () => {
    useStore.setState({ conn: 'open', selected: 'pending:claude-1', timelineAt: null, timelineStalledAt: null })
    renderApp(<Chat agent={agent({ sessionId: 'pending:claude-1', status: 'waiting', paneId: '%2' })} />)
    expect(screen.getByTestId('chat-notice').textContent).toMatch(/is starting in .*Attach tab/)
  })

  /**
   * F5: a session started with a first task says which task, so the reader
   * knows it will begin without them — and that a trust prompt in a new
   * folder still stands in front of it.
   */
  it('quotes the first task of a session this tab started', () => {
    const text = 'fix the login bug\nthen open a pull request'
    useStore.setState({
      conn: 'open',
      selected: 'pending:claude-1',
      timelineAt: null,
      timelineStalledAt: null,
      startingTask: { sessionId: 'pending:claude-1', text },
    })
    renderApp(<Chat agent={agent({ sessionId: 'pending:claude-1', status: 'waiting', paneId: '%2', cwd: '/tmp/x' })} />)
    const notice = screen.getByTestId('chat-notice').textContent ?? ''
    expect(notice).toMatch(/is starting in \/tmp\/x with your task:/)
    expect(notice).toMatch(/Attach tab/)
    expect(screen.getByTestId('chat-starting-task').textContent).toBe(text)
  })

  it('quotes nothing for a placeholder this tab did not start with that task', () => {
    useStore.setState({
      conn: 'open',
      selected: 'pending:claude-2',
      timelineAt: null,
      timelineStalledAt: null,
      startingTask: { sessionId: 'pending:claude-1', text: 'fix the login bug' },
    })
    renderApp(<Chat agent={agent({ sessionId: 'pending:claude-2', status: 'waiting', paneId: '%2' })} />)
    expect(screen.queryByTestId('chat-starting-task')).toBeNull()
    expect(screen.getByTestId('chat-notice').textContent).not.toMatch(/your task/)
  })
})
