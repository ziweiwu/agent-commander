/**
 * FR-CTL-12: one control, one place.
 *
 * At a desktop width the agent screen used to draw Mode, Clear and Compact
 * twice — once in the detail panel's control row and again in the composer
 * strip — because the row collapses below 900px and does not exist in full
 * screen while the strip is always there. That reasoning was right about
 * which surface survives and wrong about the conclusion: it argues for one
 * home, not two. About twenty controls on the app's central screen is a cost
 * paid on its central task, and three of them being the same control twice is
 * the cheapest part of that to remove.
 *
 * So the screen's controls are enumerated. A control that appears twice fails
 * here, and a control that is added has to be added here, which is the
 * sentence that makes it a decision rather than drift.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  answerPrompt: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
  setAgentModel: vi.fn(),
  setAgentGoal: vi.fn(),
  sendShiftTab: vi.fn(),
  closeAgent: vi.fn(),
}))

/**
 * Every control on the agent screen at a desktop width, on the Chat tab, with
 * the agent idle. Enumerated rather than counted: a count that drifts by one
 * says nothing about which control was added.
 */
const CONTROLS = [
  'back-button',
  'close-button',
  'fullscreen-toggle',
  'model-select',
  'close-agent',
  'tab-chat',
  'tab-attach',
  'send-mode-queue',
  'send-mode-interrupt',
  'shift-tab',
  'goal-toggle',
  'compact-agent',
  'clear-agent',
  'quick-menu',
  'composer-input',
  'composer-send',
] as const

beforeEach(() => {
  resetStore()
  setViewport(() => false)
})

function open(): void {
  useStore.setState({ selected: 'a', tab: 'chat' })
  renderApp(
    <AgentDetail
      agent={agent({ sessionId: 'a', status: 'idle', paneId: '%1', permissionMode: 'default' })}
      tab="chat"
      sheet={false}
      onTab={() => {}}
      onClose={() => {}}
    />,
  )
}

describe('FR-CTL-12 one control, one place', () => {
  it('draws each control exactly once at a desktop width', () => {
    open()
    const twice = CONTROLS.filter((id) => screen.queryAllByTestId(id).length > 1)
    expect(twice, `drawn more than once: ${twice.join(', ')}`).toEqual([])
    const missing = CONTROLS.filter((id) => screen.queryAllByTestId(id).length === 0)
    expect(missing, `not on the screen: ${missing.join(', ')}`).toEqual([])
  })

  it('offers no control this list does not name', () => {
    open()
    const known = new Set<string>(CONTROLS)
    const unlisted = Array.from(
      screen.getByTestId('agent-detail').querySelectorAll<HTMLElement>('button, select, textarea, input'),
    )
      .map((el) => el.dataset.testid ?? el.tagName.toLowerCase())
      .filter((id) => !known.has(id))
    expect(unlisted, `a control the list does not account for: ${unlisted.join(', ')}`).toEqual([])
  })
})
