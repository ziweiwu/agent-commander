/**
 * C2: the first run says tmux, and the server's reason for an agent this page
 * cannot type into reaches the reader in the reader's language.
 *
 * A bare `claude` started outside tmux makes a card that can be read and never
 * answered, and README says tmux is required while the app said nothing. The
 * two reasons the server sends (`registry.rs`, `why_it_cannot_be_attached`)
 * are English on the wire and stay English there; the browser maps them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { FleetList } from '../../src/web/components/FleetList.tsx'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import { Chat } from '../../src/web/components/Chat.tsx'
import { Help } from '../../src/web/components/Help.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { blockedReasonKey } from '../../src/web/lib/status.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

const NOT_IN_TMUX = 'session is not running inside tmux'
const UNPARSED = 'tmux pane id could not be parsed'
const ENGLISH_REASONS = [NOT_IN_TMUX, UNPARSED]

const noop = () => {}
const outside = (reason = NOT_IN_TMUX) =>
  agent({ sessionId: 'nt', name: 'headless-import', paneId: undefined, attachBlockedReason: reason })

beforeEach(resetStore)

describe('C2 the first run says tmux', () => {
  it('tells a newcomer to start the agent inside tmux, in English', () => {
    renderApp(<FleetList tiled selected={null} onSelect={noop} />)
    const text = screen.getByTestId('empty-state').textContent ?? ''
    expect(text).toContain('tmux')
    expect(screen.getAllByTestId('empty-command-line').map((line) => line.textContent)).toEqual(['tmux new -s work', 'claude'])
  })

  it('and in Chinese', () => {
    useStore.setState({ lang: 'zh-CN' })
    renderApp(<FleetList tiled selected={null} onSelect={noop} />)
    const text = screen.getByTestId('empty-state').textContent ?? ''
    expect(text).toContain('要放在 tmux 里')
    expect(screen.getByTestId('empty-command').textContent).toContain('tmux new -s work')
  })

  it('says before you start, in Help', () => {
    renderApp(<Help onClose={noop} />)
    const section = screen.getByTestId('help-before')
    expect(section.textContent).toContain('Before you start')
    expect(section.textContent).toContain('tmux new -s work')
  })
})

describe('C2 the server reason is said in the reader language', () => {
  it('maps both server reasons and lets an unknown one through', () => {
    expect(blockedReasonKey(NOT_IN_TMUX)).toBe('reasonNotInTmux')
    expect(blockedReasonKey(UNPARSED)).toBe('reasonPaneUnparsed')
    expect(blockedReasonKey('something new')).toBeUndefined()
  })

  for (const reason of ENGLISH_REASONS) {
    it(`a detail view in Chinese carries no English for "${reason}"`, () => {
      useStore.setState({ lang: 'zh-CN' })
      renderApp(<AgentDetail agent={outside(reason)} tab="chat" sheet={false} onTab={noop} onClose={noop} />)
      const text = screen.getByTestId('agent-detail').textContent ?? ''
      for (const english of ENGLISH_REASONS) expect(text).not.toContain(english)
      expect(text).toMatch(/tmux/)
    })
  }

  it('the card reach line in Chinese is not the English sentence', () => {
    useStore.setState({ lang: 'zh-CN' })
    renderApp(<AgentCard agent={outside()} selected={false} onSelect={noop} />)
    const reach = screen.getByTestId('agent-reach')
    expect(reach.textContent).not.toContain(NOT_IN_TMUX)
    expect(reach.getAttribute('title')).not.toContain(NOT_IN_TMUX)
    expect(reach.textContent).toContain('不在 tmux 中')
  })

  it('the composer says how to restart it inside tmux', () => {
    renderApp(<Chat agent={outside()} />)
    const box = screen.getByTestId('composer-input')
    expect(box.getAttribute('placeholder')).toContain('tmux new -s work')
  })

  it('an unknown server sentence is shown as it came', () => {
    renderApp(<AgentCard agent={outside('pane went somewhere')} selected={false} onSelect={noop} />)
    expect(screen.getByTestId('agent-reach').textContent).toContain('pane went somewhere')
  })
})
