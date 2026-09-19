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

const idle = () => agent({ sessionId: 'a', status: 'idle', paneId: '%1' })

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

  it('says the conversation could not be loaded once the re-asks have run out', () => {
    useStore.setState({
      conn: 'open',
      selected: 'a',
      timelineAt: null,
      timelineStalledAt: 1,
    })
    renderApp(<Chat agent={idle()} />)
    expect(screen.getByTestId('chat-notice').textContent).toMatch(/could not be loaded/)
  })
})
