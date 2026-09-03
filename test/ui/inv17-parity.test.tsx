/**
 * INV-17: the three shapes re-arrange the app; they do not subset it.
 *
 * The layout has three states — a desktop with the list beside the detail, a
 * narrow one where the detail covers it, and a short one where there is barely
 * room for the composer — and they are one component tree under three media
 * queries. That makes losing a feature on a phone a one-line change nothing
 * else notices: a control inside a `narrow &&` branch, or a class with
 * `display: none` in a width query, is simply absent, out of the tab order and
 * out of the accessibility tree, while every desktop test goes on passing.
 *
 * `test/responsive.test.ts` holds the stylesheets to that rule. This holds the
 * components to it: every action the desktop offers is asserted present in the
 * other two shapes, opening whatever disclosure that shape puts it behind. A
 * control that moves is fine. A control that disappears fails here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'
import { useStore } from '../../src/web/store/store.ts'

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
  setGoal: vi.fn(),
  clearGoal: vi.fn(),
  sendShiftTab: vi.fn(),
}))

/**
 * The actions the agent view offers, by the test id that reaches each one.
 *
 * Spelled out rather than discovered, because a discovered list would shrink
 * quietly with the thing it is meant to catch: if a control stops rendering
 * everywhere, a "compare the shapes" test that reads both sides from the DOM
 * agrees with itself and says nothing.
 */
const ACTIONS = [
  'tab-chat',
  'tab-attach',
  'fullscreen-toggle',
  // The agent's own settings and the two context actions.
  'model-select',
  'clear-agent',
  'compact-agent',
  // The composer, and everything in the strip above it.
  'composer-input',
  'composer-send',
  'send-mode-queue',
  'send-mode-interrupt',
  'goal-toggle',
  'quick-menu',
  'shift-tab',
] as const

/** A wide, fine-pointer desktop: nothing is behind a disclosure here. */
const DESKTOP = () => false
/** A phone or a tablet in portrait: below the 900px breakpoint. */
const NARROW = (query: string) => query.includes('max-width: 900px')
/** A landscape phone: narrow *and* with no height to spare. */
const SHORT = (query: string) =>
  query.includes('max-width: 900px') || query.includes('max-height: 420px')

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

/** Reveal whatever this shape has folded away. Idempotent by design. */
async function revealEverything(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  for (const disclosure of ['controls-toggle', 'strip-toggle']) {
    const button = screen.queryByTestId(disclosure)
    if (button && button.getAttribute('aria-expanded') === 'false') await user.click(button)
  }
}

beforeEach(() => {
  resetStore()
  setViewport(DESKTOP)
})

describe('INV-17 every shape offers every action', () => {
  it.each([
    ['a desktop', DESKTOP],
    ['a phone or a tablet in portrait', NARROW],
    ['a landscape phone', SHORT],
  ])('offers all of them on %s', async (_shape, matches) => {
    setViewport(matches)
    const user = userEvent.setup()
    open()
    await revealEverything(user)
    const missing = ACTIONS.filter((id) => screen.queryAllByTestId(id).length === 0)
    expect(missing, `unreachable on this shape: ${missing.join(', ')}`).toEqual([])
  })

  /*
   * The disclosures are the mechanism the rule above depends on, so they are
   * asserted directly. A `⋯` that renders but does not open is the same defect
   * as a missing control, and would pass a test that only counted ids.
   */
  it('puts what it folds away behind a labelled disclosure', async () => {
    setViewport(SHORT)
    const user = userEvent.setup()
    open()
    for (const disclosure of ['controls-toggle', 'strip-toggle']) {
      const button = screen.getByTestId(disclosure)
      // 4.1.2: a glyph is not a name.
      expect(button.getAttribute('aria-label')).toBeTruthy()
      expect(button.getAttribute('aria-expanded')).toBe('false')
      await user.click(button)
      expect(button.getAttribute('aria-expanded')).toBe('true')
    }
  })

  /*
   * And the other direction: the desktop must not be carrying a disclosure
   * that exists to buy back space it has. A `⋯` there would hide settings
   * behind a click for no reason, which is the same drift in reverse.
   */
  it('folds nothing away where there is room', () => {
    setViewport(DESKTOP)
    open()
    expect(screen.queryByTestId('controls-toggle')).toBeNull()
    expect(screen.queryByTestId('strip-toggle')).toBeNull()
  })
})
