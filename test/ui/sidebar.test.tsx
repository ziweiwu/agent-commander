/**
 * The fleet column is a preference, and collapsing it is a trade.
 *
 * It was `minmax(340px, 430px)`, which resolves to its maximum on any desktop
 * and left ~415px of content once `scrollbar-gutter` took its share — 21.5% of
 * a 1440x900 viewport spent on the list while reading one agent. It is now
 * 288px, which is Claude Desktop's own `sidebarWidth` default on its 1200x800
 * window: the same kind of column beside the same kind of conversation, so it
 * is a reference rather than a number chosen to look right.
 *
 * Collapsing takes the column away rather than shrinking it to icons. An icon
 * rail keeps presence but loses the names the column exists for, and a 56px
 * strip is a third layout to reason about — so "gone" is the second state, and
 * it is what Claude Desktop's own collapse does.
 *
 * Two things here are contract rather than decoration. The control exists only
 * where it can change something (INV-11), and exactly one thing holds the
 * delegation poll at a time (INV-4) — the list held it, and whatever unmounts
 * the list has to hand it over.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { App, FleetRoute } from '../../src/web/components/App.tsx'
import { fetchTree } from '../../src/web/store/transport.ts'
import { useStore } from '../../src/web/store/store.ts'
import { agent, resetStore } from './helpers.tsx'
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
  setGoal: vi.fn(),
  clearGoal: vi.fn(),
  sendShiftTab: vi.fn(),
  closeAgentById: vi.fn(),
  closeAgent: vi.fn(),
  fetchTree: vi.fn(),
}))

/** A wide, fine-pointer desktop, which is the only shape with a column. */
const DESKTOP = () => false
/** Below the 900px cut, where the sheet already covers the list. */
const NARROW = (query: string) => query.includes('max-width: 900px')

function shell(path: string) {
  return render(
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

/*
 * Idle rather than busy: the collapse is about space, and a busy agent would
 * bring a running-process line into the header that has nothing to do with it.
 */
function openOne(): void {
  useStore.setState({
    agents: [agent({ sessionId: 'a', status: 'idle', paneId: '%1' })],
    selected: 'a',
  })
}

beforeEach(() => {
  resetStore()
  setViewport(DESKTOP)
})

describe('the fleet column', () => {
  it("is 288px, Claude Desktop's own default, rather than the old 430 track", () => {
    openOne()
    shell('/agent/a')
    const layout = document.querySelector<HTMLElement>('main')
    expect(layout?.style.getPropertyValue('--fleet-col')).toBe('288px')
  })

  it('starts expanded and on screen', () => {
    openOne()
    shell('/agent/a')
    expect(screen.getByTestId('fleet-list')).toBeTruthy()
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it('collapses out of the layout and comes back', async () => {
    const user = userEvent.setup()
    openOne()
    shell('/agent/a')

    await user.click(screen.getByTestId('sidebar-toggle'))
    expect(screen.queryByTestId('fleet-list')).toBeNull()
    // Gone from the layout, not merely narrow: a column still holding a track
    // would keep its gap and padding and give the conversation nothing back.
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('false')

    await user.click(screen.getByTestId('sidebar-toggle'))
    expect(screen.getByTestId('fleet-list')).toBeTruthy()
  })

  it('names what a press will do, and never by the glyph alone', async () => {
    const user = userEvent.setup()
    openOne()
    shell('/agent/a')
    const button = screen.getByTestId('sidebar-toggle')
    // 4.1.2: `⇤` is not a name, and the label has to change with the state or
    // it describes the wrong half of the toggle.
    expect(button.getAttribute('aria-label')).toBe('Hide the fleet list')
    await user.click(button)
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe('Show the fleet list')
  })

  it('remembers the choice, because it is a trade and not a gesture', async () => {
    const user = userEvent.setup()
    openOne()
    shell('/agent/a')
    await user.click(screen.getByTestId('sidebar-toggle'))
    expect(useStore.getState().sidebar).toBe('collapsed')
  })

  /*
   * INV-11 applied to a control rather than to a figure: the toggle renders
   * only where pressing it changes what is on screen.
   */
  it('offers no toggle with no agent open, where the list is the whole page', () => {
    useStore.setState({ agents: [agent({ sessionId: 'a' })], selected: null })
    shell('/')
    expect(screen.getByTestId('fleet-list')).toBeTruthy()
    expect(screen.queryByTestId('sidebar-toggle')).toBeNull()
  })

  it('offers no toggle below 900px, where the sheet already covers the list', () => {
    setViewport(NARROW)
    openOne()
    shell('/agent/a')
    expect(screen.queryByTestId('sidebar-toggle')).toBeNull()
  })

  /*
   * A collapsed column keeps the preference but must not act on it into a dead
   * end: with no agent open there would be nothing behind the list to reveal,
   * so the screen would be empty with the only way back being a control that
   * is not drawn there.
   */
  it('ignores a stored collapse while no agent is open', () => {
    useStore.setState({
      agents: [agent({ sessionId: 'a' })],
      selected: null,
      sidebar: 'collapsed',
    })
    shell('/')
    expect(screen.getByTestId('fleet-list')).toBeTruthy()
  })

  /*
   * INV-4: one holder of the delegation poll at a time. The list held it, and
   * the phone sheet handing it to a stand-in was the only case that existed —
   * a collapsed sidebar unmounts the list on a desktop too, so it has to hand
   * over by the same rule rather than leaving the graph unpolled.
   */
  it('hands the delegation poll over when it unmounts the list', async () => {
    const user = userEvent.setup()
    const asMock = vi.mocked(fetchTree)
    asMock.mockClear()
    openOne()
    shell('/agent/a')
    await waitFor(() => expect(asMock).toHaveBeenCalled())
    asMock.mockClear()

    await user.click(screen.getByTestId('sidebar-toggle'))
    expect(screen.queryByTestId('fleet-list')).toBeNull()
    // The list was the holder. Something has to still be asking, or the
    // delegate line under the agent's own tabs quietly stops moving — and
    // INV-13 is explicit that "no tree yet" and "no delegates" are different
    // sentences, so a stalled poll would make the card claim the wrong one.
    await waitFor(() => expect(asMock).toHaveBeenCalled())
  })
})
