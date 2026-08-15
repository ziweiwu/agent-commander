/**
 * A delegated agent has to be legible as "working" rather than "dead".
 *
 * It stays `busy` — the user's response is the same as for any working agent,
 * which is to leave it alone — so this rides in the status pill as a modifier,
 * using the same `state · reason` grammar as `waiting · dialog open`. That is
 * the one place on the card people already read for "what state is this in",
 * and it costs no new group, chip or icon.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
}))

const card = (over: Parameters<typeof agent>[0]) =>
  renderApp(<AgentCard agent={agent(over)} selected={false} onSelect={() => {}} />)

const pill = (): string => screen.getByTestId('agent-status').textContent ?? ''

beforeEach(() => {
  resetStore()
})

describe('delegated status pill', () => {
  it('says so when a subagent is running', () => {
    card({ sessionId: 'a', status: 'busy', delegating: true })
    expect(pill()).toBe('busy · delegated')
  })

  it('stays plain busy when the agent is working itself', () => {
    card({ sessionId: 'a', status: 'busy' })
    expect(pill()).toBe('busy')
  })

  // It must not be promoted out of the Working group: the user's action is
  // identical, and a fourth bucket would split "leave it alone" in two.
  it('remains a busy agent, not a new status', () => {
    card({ sessionId: 'a', status: 'busy', delegating: true })
    expect(screen.getByTestId('agent-card').getAttribute('data-status')).toBe('busy')
  })

  // "Needs you" outranks everything; a delegated agent must never dilute it.
  it('never overrides a waiting agent needing the user', () => {
    card({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', delegating: true })
    expect(pill()).toBe('waiting · dialog open')
  })

  it('does not mark an idle agent as delegated', () => {
    card({ sessionId: 'a', status: 'idle', delegating: true })
    expect(pill()).toBe('idle')
  })

  it('reads naturally in Chinese rather than as a gloss', () => {
    useStore.setState({ lang: 'zh-CN' })
    card({ sessionId: 'a', status: 'busy', delegating: true })
    expect(pill()).toBe('运行中 · 已委派子代理')
  })

  // The distinction is carried in text, so it survives without colour.
  it('carries the state in text, not colour alone', () => {
    card({ sessionId: 'a', status: 'busy', delegating: true })
    expect(pill()).toContain('delegated')
  })
})
