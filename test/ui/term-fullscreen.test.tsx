/**
 * Full screen, offered from the terminal itself.
 *
 * The control existed only as a bare `⤢` in the panel header — two rows above
 * the pane, unlabelled, and on a phone sharing a cramped strip with the `⋯`
 * disclosure. The terminal is the one view that genuinely cannot be made to fit
 * a 390px screen, so the way out of that has to be where the problem is and has
 * to say what it does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Terminal } from '../../src/web/components/Terminal.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendKey: vi.fn(),
  sendText: vi.fn(),
  setAttached: vi.fn(),
}))

const attachable = () => agent({ sessionId: 'agent-a' })

beforeEach(() => {
  resetStore()
  setViewport(() => false)
})

describe('terminal full screen button', () => {
  it('is in the key bar, named, and turns full screen on', async () => {
    const user = userEvent.setup()
    renderApp(<Terminal agent={attachable()} onExit={() => {}} />)

    const button = screen.getByTestId('term-fullscreen')
    // Named, not a lone glyph: the header's ⤢ is what this exists to improve on.
    expect(button.textContent).toContain('Full screen')
    expect(screen.getByTestId('keybar').contains(button)).toBe(true)

    await user.click(button)
    expect(useStore.getState().fullscreen).toBe(true)
  })

  it('is offered on a phone too, where it matters most', () => {
    // Narrow and touch: the viewport the panel header hides its own ⤢ behind.
    setViewport((q) => q.includes('coarse') || q.includes('900px'))
    renderApp(<Terminal agent={attachable()} onExit={() => {}} />)

    expect(screen.getByTestId('term-fullscreen').textContent).toContain('Full screen')
  })

  it('follows the interface language', () => {
    useStore.setState({ lang: 'zh-CN' })
    renderApp(<Terminal agent={attachable()} onExit={() => {}} />)

    expect(screen.getByTestId('term-fullscreen').textContent).toContain('全屏')
  })

  /*
   * In full screen the overlay carries its own way out, and a second control
   * that would do nothing reads as broken rather than as already-applied.
   */
  it('goes away once full screen is on', () => {
    useStore.setState({ fullscreen: true })
    renderApp(<Terminal agent={attachable()} onExit={() => {}} />)

    expect(screen.queryByTestId('term-fullscreen')).toBeNull()
  })

  // No pane, no terminal to expand — the view is a sentence explaining why.
  it('is absent when the agent cannot be attached to', () => {
    renderApp(
      <Terminal
        agent={agent({ sessionId: 'agent-b', paneId: undefined })}
        onExit={() => {}}
      />,
    )

    expect(screen.queryByTestId('term-fullscreen')).toBeNull()
    expect(screen.getByTestId('term-unavailable')).toBeTruthy()
  })
})
