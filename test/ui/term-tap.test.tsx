/**
 * A tap on the pane opens the phone's keyboard (FR-ATT-8, INV-17).
 *
 * xterm takes typing through a hidden textarea, and a phone raises its
 * keyboard only for a `focus()` made inside a user gesture. So the pane is not
 * focused on mount on a touch screen (that would pop the keyboard over the
 * capture unasked) and a tap is the one moment it is. Typed keys then take the
 * desktop path, which `term-ime.test.tsx` and the e2e spec hold; this file
 * holds who may focus, and when.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Terminal } from '../../src/web/components/Terminal.tsx'
import { PaneTerm } from '../../src/web/lib/term.ts'
import { useStore } from '../../src/web/store/store.ts'
import { setViewport } from './setup.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendText: vi.fn(),
  runText: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendShiftTab: vi.fn(),
  setAttached: vi.fn(),
  requestHistory: vi.fn(),
}))

const open = () =>
  renderApp(<Terminal agent={agent({ sessionId: 'a', paneId: '%1' })} onExit={() => {}} />)

let focus: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetStore()
  useStore.setState({ exited: [] })
  focus = vi.spyOn(PaneTerm.prototype, 'focus').mockImplementation(() => {})
  focus.mockClear()
})

describe('tapping the terminal on a touch screen', () => {
  it('focuses the terminal input, and only on the tap', async () => {
    setViewport((q) => q.includes('pointer: coarse'))
    open()
    // Mounting is deferred until the box has a width; give it its attempts.
    await waitFor(() => expect(document.querySelector('.xterm')).not.toBeNull())
    expect(focus).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('term-wrap'))
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('does not focus on a fine pointer, where mount already did', async () => {
    setViewport(() => false)
    open()
    fireEvent.click(screen.getByTestId('term-wrap'))
    expect(focus).not.toHaveBeenCalledTimes(2)
    await waitFor(() => expect(document.querySelector('.xterm')).not.toBeNull())
    // Mount focuses once on desktop; a click adds nothing of its own.
    const afterMount = focus.mock.calls.length
    fireEvent.click(screen.getByTestId('term-wrap'))
    expect(focus.mock.calls.length).toBe(afterMount)
  })

  it('does not focus a pane that has exited', () => {
    setViewport((q) => q.includes('pointer: coarse'))
    useStore.setState({ exited: ['a'] })
    open()
    fireEvent.click(screen.getByTestId('term-wrap'))
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('the terminal input on a phone', () => {
  it('is 16px so iOS does not zoom the page, with the autocorrect family off', () => {
    const term = new PaneTerm(() => {}, () => {}, () => {})
    const host = document.createElement('div')
    const scaler = document.createElement('div')
    host.appendChild(scaler)
    document.body.appendChild(host)
    term.mount(host, scaler)
    const ta = scaler.querySelector('textarea')
    expect(ta?.style.fontSize).toBe('16px')
    expect(ta?.getAttribute('autocapitalize')).toBe('off')
    expect(ta?.getAttribute('autocorrect')).toBe('off')
    term.dispose()
  })
})
