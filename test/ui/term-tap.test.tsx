/**
 * A tap on the pane opens the phone's keyboard in the composer box (FR-ATT-8,
 * INV-17).
 *
 * A phone raises its keyboard only for a `focus()` made inside a user gesture,
 * so nothing is focused on mount on a touch screen (that would pop the keyboard
 * over the capture unasked) and a tap is the one moment it is. It goes to the
 * box rather than xterm's hidden input, so the line is seen before Enter runs
 * it; this file holds who may focus, and when.
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
  const box = () => screen.getByTestId<HTMLTextAreaElement>('term-compose-input')

  it('focuses the composer box, and only on the tap', async () => {
    setViewport((q) => q.includes('pointer: coarse'))
    open()
    /** Mounting is deferred until the box has a width; give it its attempts. */
    await waitFor(() => expect(document.querySelector('.xterm')).not.toBeNull())
    expect(document.activeElement).not.toBe(box())

    fireEvent.click(screen.getByTestId('term-wrap'))
    expect(document.activeElement).toBe(box())
    /** The box, not xterm's hidden input: that one sends each key unseen. */
    expect(focus).not.toHaveBeenCalled()
  })

  it('leaves a fine pointer to the pane, which mount already focused', async () => {
    setViewport(() => false)
    open()
    await waitFor(() => expect(document.querySelector('.xterm')).not.toBeNull())
    fireEvent.click(screen.getByTestId('term-wrap'))
    expect(document.activeElement).not.toBe(box())
  })

  it('does not focus anything for a pane that has exited', () => {
    setViewport((q) => q.includes('pointer: coarse'))
    useStore.setState({ exited: ['a'] })
    open()
    fireEvent.click(screen.getByTestId('term-wrap'))
    expect(document.activeElement).not.toBe(box())
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
