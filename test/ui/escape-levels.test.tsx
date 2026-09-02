/**
 * Escape has to mean different things in different places, and the order the
 * cases are checked in is the whole design.
 *
 * Plain Escape inside the terminal belongs to the agent — it interrupts it, and
 * INV-6 puts a confirmation in front of that. It must not *also* collapse the
 * view, which is what happened while the full-screen case was checked first:
 * answering the interrupt dialog dropped you out of full screen as a side
 * effect you never asked for.
 *
 * Shift+Escape is then the only way out of the terminal, so it steps back one
 * level rather than leaving outright. It used to jump straight to the list from
 * full screen, discarding two levels at once and leaving focus on <body>.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/web/components/App.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, resetStore } from './helpers.tsx'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render } from '@testing-library/react'

const navigate = vi.hoisted(() => vi.fn())
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

beforeEach(() => {
  resetStore()
  navigate.mockClear()
})

function shell(path = '/agent/a') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<App />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Stand-in for the xterm surface, which the real handler detects by testid. */
function terminal(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-testid', 'term-wrap')
  const inner = document.createElement('textarea')
  el.append(inner)
  document.body.append(el)
  inner.focus()
  return el
}

describe('Escape levels', () => {
  it('leaves full screen alone when Escape is pressed inside the terminal', async () => {
    const user = userEvent.setup()
    useStore.setState({ agents: [agent({ sessionId: 'a' })], selected: 'a', fullscreen: true })
    shell()
    const term = terminal()

    await user.keyboard('{Escape}')

    // The agent's interrupt owns this key; the view must not collapse under it.
    expect(useStore.getState().fullscreen).toBe(true)
    term.remove()
  })

  it('exits full screen on Escape when not in the terminal', async () => {
    const user = userEvent.setup()
    useStore.setState({ agents: [agent({ sessionId: 'a' })], selected: 'a', fullscreen: true })
    shell()

    await user.keyboard('{Escape}')
    expect(useStore.getState().fullscreen).toBe(false)
  })

  it('steps Shift+Escape back one level, out of full screen first', async () => {
    const user = userEvent.setup()
    useStore.setState({ agents: [agent({ sessionId: 'a' })], selected: 'a', fullscreen: true })
    shell()

    await user.keyboard('{Shift>}{Escape}{/Shift}')
    expect(useStore.getState().fullscreen).toBe(false)
  })

  // From the terminal this is the only way out, so it has to work there too.
  it('steps back one level from the terminal in full screen', async () => {
    const user = userEvent.setup()
    useStore.setState({ agents: [agent({ sessionId: 'a' })], selected: 'a', fullscreen: true })
    shell()
    const term = terminal()

    await user.keyboard('{Shift>}{Escape}{/Shift}')
    expect(useStore.getState().fullscreen).toBe(false)
    term.remove()
  })

  it('still closes the new-agent dialog before anything else', async () => {
    const user = userEvent.setup()
    useStore.setState({
      agents: [agent({ sessionId: 'a' })],
      selected: 'a',
      fullscreen: true,
      newAgentOpen: true,
    })
    shell()

    await user.keyboard('{Escape}')
    expect(useStore.getState().newAgentOpen).toBe(false)
    expect(useStore.getState().fullscreen).toBe(true)
  })
})

describe('a key event that did not come from an element', () => {
  /*
   * `e.target` is an `EventTarget`, not an element. A keydown dispatched at
   * `document` -- which is what an automated driver or a browser extension
   * produces -- has a target with no `closest`, and the handler asserted its
   * way past that rather than narrowing, so every branch below threw before it
   * could run. Not reachable by typing, since a real keypress targets an
   * element; but the handler is asking "was this typed into a field", and
   * "into something that is not an element" has an answer.
   */
  it('does not throw, and still acts on the key', () => {
    useStore.setState({ agents: [agent({ sessionId: 'a' })], selected: 'a', fullscreen: true })
    shell()

    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }).not.toThrow()
    expect(useStore.getState().fullscreen).toBe(false)
  })
})
