/**
 * `role="dialog" aria-modal="true"` is a promise to assistive technology, not a
 * behaviour. Both dialogs made that promise and neither kept it: Tab walked
 * straight out into the page behind, and in the fullscreen view Enter on a
 * covered agent card switched which agent was open while the header still named
 * the old one. A backdrop that swallows clicks hid it, so only a keyboard found
 * it.
 *
 * `inert` on everything else at body level is what a native `<dialog>` does —
 * it blocks focus, clicks and the screen reader's virtual cursor at once. These
 * tests hold the two halves that are observable without a real browser: the
 * rest of the page is inert while the dialog is open, and focus goes back where
 * it came from when it closes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewAgentDialog } from '../../src/web/components/NewAgentDialog.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  startAgent: vi.fn(),
  loadEnv: vi.fn(),
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
}))

const env = { tailscale: null, tmux: true, port: 4317, platform: 'darwin', version: '0.0.0-test' }

beforeEach(() => {
  resetStore()
})

describe('modal chrome', () => {
  it('leaves the page alone while the dialog is closed', () => {
    const { container } = renderApp(<NewAgentDialog />)
    expect(container.inert).toBeFalsy()
  })

  it('makes the rest of the page inert while the dialog is open', () => {
    useStore.setState({ newAgentOpen: true, env })
    const { container } = renderApp(<NewAgentDialog />)

    expect(screen.getByTestId('new-agent-dialog')).toBeTruthy()
    // The dialog is portalled to the body, so the app's own tree is a sibling
    // and can be taken out of the tab order wholesale.
    expect(container.inert).toBe(true)
  })

  it('gives the page back when the dialog closes', () => {
    useStore.setState({ newAgentOpen: true, env })
    const { container } = renderApp(<NewAgentDialog />)
    expect(container.inert).toBe(true)

    act(() => {
      useStore.setState({ newAgentOpen: false })
    })
    expect(container.inert).toBe(false)
  })

  // Deferred by a microtask, because closing a dialog remounts what it covered
  // and those mount effects would otherwise claim focus first.
  it('returns focus to whatever opened it', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '+ New agent'
    document.body.append(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    useStore.setState({ newAgentOpen: true, env })
    renderApp(<NewAgentDialog />)
    // The dialog takes focus for itself on open.
    expect(document.activeElement).not.toBe(trigger)

    await act(async () => {
      useStore.setState({ newAgentOpen: false })
    })
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  // A dialog that only wraps one direction steps out to <body> on the other,
  // which reads as a silent stop even though `inert` keeps the page unreachable.
  it('wraps Tab in both directions', async () => {
    const user = userEvent.setup()
    useStore.setState({ newAgentOpen: true, env })
    const { baseElement } = renderApp(<NewAgentDialog />)
    const dialog = screen.getByTestId('new-agent-dialog')
    const stops = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea')].filter(
      (el) => !el.hasAttribute('disabled'),
    )
    const first = stops[0] as HTMLElement
    const last = stops.at(-1) as HTMLElement

    last.focus()
    await user.tab()
    expect(document.activeElement).toBe(first)
    expect(document.activeElement).not.toBe(baseElement)

    first.focus()
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(last)
  })

  /*
   * Going full screen replaces the whole detail panel, so React destroys the
   * button that was clicked and builds a new one on the way back. Restoring to
   * the captured node alone silently did nothing there, and the remounted chat
   * kept focus.
   */
  it('finds the opener again when it has been rebuilt as a new element', async () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'rebuilt-trigger')
    document.body.append(trigger)
    trigger.focus()

    useStore.setState({ newAgentOpen: true, env })
    renderApp(<NewAgentDialog />)

    // The control is torn down and rebuilt while the dialog covers it.
    trigger.remove()
    const rebuilt = document.createElement('button')
    rebuilt.setAttribute('data-testid', 'rebuilt-trigger')
    document.body.append(rebuilt)

    await act(async () => {
      useStore.setState({ newAgentOpen: false })
    })
    expect(document.activeElement).toBe(rebuilt)
    rebuilt.remove()
  })

  // Closing one dialog must not revive the page for a dialog still open over
  // it, so a nested modal only ever undoes the inerting it did itself.
  it('does not revive a sibling that was already inert', () => {
    const other = document.createElement('div')
    other.inert = true
    document.body.append(other)

    useStore.setState({ newAgentOpen: true, env })
    renderApp(<NewAgentDialog />)
    act(() => {
      useStore.setState({ newAgentOpen: false })
    })

    expect(other.inert).toBe(true)
    other.remove()
  })
})
