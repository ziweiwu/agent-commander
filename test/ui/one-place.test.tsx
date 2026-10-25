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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
import { App, FleetRoute } from '../../src/web/components/App.tsx'
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
  closeAgentById: vi.fn(),
  fetchTree: vi.fn(() => new Promise(() => {})),
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
  'strip-toggle',
  /*
   * The settings row's own disclosure. It used to render only below 900px, so a
   * desktop sweep never saw it; the row now folds at every width, because at
   * 1440x900 it was a 960x53 band holding one 103x36 button.
   */
  'controls-toggle',
  'composer-input',
  'composer-send',
  'attach-picture',
  /*
   * The file picker behind it. Not a second home for the action — it is the
   * button's mechanism, hidden, out of the tab order and unnamed — but it is
   * an `<input>` under the composer, so the sweep below finds it and the rule
   * that a control is named here rather than drifting in applies to it too.
   */
  'picture-input',
] as const

/**
 * One control rendered once per item, rather than one control drawn twice.
 *
 * The menu's replies are a list of five prompts behind a single affordance —
 * "drawn more than once" is what they are, and the rule this file enforces is
 * about the same *action* having two homes.
 */
const LISTS = ['quick-prompt'] as const

beforeEach(() => {
  resetStore()
  setViewport(() => false)
})

/**
 * Everything the screen folds away, revealed.
 *
 * INV-17 allows a control to sit behind a disclosure that is itself on screen
 * and labelled, and this screen has two — the composer's menu and the agent's
 * settings row. So the sweep opens both, the same way a reader would, rather
 * than counting the screen with them shut.
 */
async function revealEverything(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  for (const disclosure of ['controls-toggle', 'strip-toggle']) {
    const button = screen.queryByTestId(disclosure)
    if (button && button.getAttribute('aria-expanded') === 'false') await user.click(button)
  }
}

/** The agent screen and whatever it has portalled out of itself. */
function surfaces(): HTMLElement[] {
  const panel = screen.queryByTestId('composer-strip')
  return [screen.getByTestId('agent-detail'), ...(panel ? [panel] : [])]
}

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
  it('draws each control exactly once at a desktop width', async () => {
    const user = userEvent.setup()
    open()
    await revealEverything(user)
    const twice = CONTROLS.filter((id) => screen.queryAllByTestId(id).length > 1)
    expect(twice, `drawn more than once: ${twice.join(', ')}`).toEqual([])
    const missing = CONTROLS.filter((id) => screen.queryAllByTestId(id).length === 0)
    expect(missing, `not on the screen: ${missing.join(', ')}`).toEqual([])
  })

  it('offers no control this list does not name', async () => {
    const user = userEvent.setup()
    open()
    await revealEverything(user)
    const known = new Set<string>([...CONTROLS, ...LISTS])
    const unlisted = surfaces()
      .flatMap((root) =>
        Array.from(root.querySelectorAll<HTMLElement>('button, select, textarea, input')),
      )
      .map((el) => el.dataset.testid ?? el.tagName.toLowerCase())
      .filter((id) => !known.has(id))
    expect(unlisted, `a control the list does not account for: ${unlisted.join(', ')}`).toEqual([])
  })
})

/**
 * "✋ 2 ›" is one control with one home per shape, and the home is wherever the
 * list is not: the topbar slot the filters leave in the sheet and with the
 * column collapsed, and the header of full screen, which covers the topbar.
 * Never beside the list, whose waiting group already says it, and never twice.
 */
const WAITING_CHIP = 'waiting-chip'

describe('FR-CTL-12 the waiting chip has one home in each shape', () => {
  const NARROW = (query: string) => query.includes('max-width: 900px')
  const fleet = [
    agent({ sessionId: 'a', status: 'waiting', paneId: '%1', lastActivityAt: Date.now() - 1000 }),
    agent({ sessionId: 'b', status: 'waiting', paneId: '%2', lastActivityAt: Date.now() - 2000 }),
  ]

  function shell(path: string): void {
    useStore.setState({ agents: fleet, selected: path === '/' ? null : 'a' })
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/*" element={<App />}>
            <Route index element={<FleetRoute />} />
            <Route path="agent/:sessionId" element={<FleetRoute />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
  }

  it.each([
    ['the fleet alone', '/', () => {}, 0],
    ['a desktop with the list beside the agent', '/agent/a', () => {}, 0],
    ['a desktop with the column collapsed', '/agent/a', () => useStore.setState({ sidebar: 'collapsed' }), 1],
    ['the sheet', '/agent/a', () => setViewport(NARROW), 1],
    ['full screen', '/agent/a', () => useStore.setState({ fullscreen: true }), 1],
    ['full screen over the sheet', '/agent/a', () => {
      setViewport(NARROW)
      useStore.setState({ fullscreen: true })
    }, 1],
  ])('%s draws it %i time(s)', (_shape, path, arrange, times) => {
    arrange()
    shell(path)
    expect(screen.queryAllByTestId(WAITING_CHIP)).toHaveLength(times)
  })
})
