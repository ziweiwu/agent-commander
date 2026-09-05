/**
 * The Chat tab's peek at the bottom of the pane, and the store plumbing that
 * lets a surface other than the Attach tab draw frames.
 *
 * "Attached" used to be the Attach tab: `setAttached` set the tab, the frame
 * handler dropped frames unless the tab was 'attach', and reconnect and focus
 * both keyed on it. The peek lives on the Chat tab, so those are separate now,
 * and the first group here pins that the old gate no longer drops the peek's
 * frames.
 *
 * The rest is what makes the peek a picture and not a terminal: it sends one
 * `attach` on mount and one on unmount and nothing else (INV-4 — a pane is
 * read only while somebody is watching), it never focuses xterm and typing
 * into it sends nothing (INV-2), a dead pane is said to be dead rather than
 * drawn as if live (INV-11), and no size ever travels to the server (INV-1).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Terminal as XTerm } from '@xterm/xterm'
import type { ClientMessage, Frame } from '../../src/shared/types.ts'
import { PaneTerm } from '../../src/web/lib/term.ts'
import { useStore } from '../../src/web/store/store.ts'
import { connect, focusAgent, setAttached } from '../../src/web/store/transport.ts'
import { LazyPanePeek } from '../../src/web/components/LazyTerminal.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'

/** Everything the client sent down the socket, as the server would parse it. */
const sent: ClientMessage[] = []
const sockets: FakeSocket[] = []

/** A socket that records rather than connects, and can be spoken to. */
class FakeSocket {
  static readonly OPEN = 1
  readyState = 1
  readonly listeners = new Map<string, Array<(e: unknown) => void>>()
  constructor(readonly url: unknown) {
    sockets.push(this)
  }
  send(raw: string): void {
    sent.push(JSON.parse(raw) as ClientMessage)
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
}

const live = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket

/** What the server would say. */
function arrives(msg: object): void {
  live().fire('message', { data: JSON.stringify(msg) })
}

const frameFor = (sessionId: string, rows = 24): Frame => ({
  sessionId,
  cols: 80,
  rows,
  cursorX: 2,
  cursorY: rows - 1,
  lines: Array.from({ length: rows }, (_, i) => (i === rows - 2 ? '❯ 1. Yes' : '')),
})

const attached = (sessionId: string): ClientMessage => ({ type: 'attach', sessionId, on: true })
const detached = (sessionId: string): ClientMessage => ({ type: 'attach', sessionId, on: false })

const A = agent({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open' })

beforeAll(() => {
  // Stubbed for the file: the transport reads `WebSocket.OPEN` at send time,
  // and the one socket opened here serves every test below.
  vi.stubGlobal('WebSocket', FakeSocket)
  // jsdom lays nothing out, and `openWhenSized` waits on a width. A width on
  // every element opens the terminal on its first attempt, in the same tick
  // as the mount, so a test can read the attach off the wire without waiting
  // thirty animation frames for the fallback.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 400, configurable: true })
  connect()
  live().fire('open')
})

beforeEach(() => {
  resetStore()
  useStore.setState({ selected: 'a', exited: [] })
  sent.length = 0
})

async function peekOpen(): Promise<HTMLElement> {
  const peek = await screen.findByTestId('pane-peek')
  await waitFor(() => expect(sent).toEqual([attached('a')]))
  return peek
}

describe('tab and attachment are separate things', () => {
  it('attaching no longer moves the tab', () => {
    setAttached(true)
    expect(useStore.getState().attached).toBe(true)
    expect(useStore.getState().tab).toBe('chat')
    expect(sent).toEqual([attached('a')])
  })

  it('stores a frame for the selected agent while attached on the Chat tab', () => {
    setAttached(true)
    const frame = frameFor('a')
    arrives({ type: 'frame', frame })
    expect(useStore.getState().frame).toEqual(frame)
  })

  it('drops a frame nobody asked for', () => {
    arrives({ type: 'frame', frame: frameFor('a') })
    expect(useStore.getState().frame).toBeNull()
  })

  it('detaching when nothing is attached sends nothing', () => {
    setAttached(false)
    expect(sent).toEqual([])
  })

  it('INV-4 focusing another agent detaches whichever tab was watching', () => {
    setAttached(true)
    sent.length = 0
    focusAgent('b')
    expect(sent).toEqual([detached('a'), { type: 'focus', sessionId: 'b' }])
    expect(useStore.getState().attached).toBe(false)
  })

  it('re-attaches on reconnect when attached, whatever the tab', () => {
    setAttached(true)
    sent.length = 0
    live().fire('open')
    expect(sent).toEqual([{ type: 'focus', sessionId: 'a' }, attached('a')])
  })
})

describe('the peek', () => {
  it('INV-4 attaches on mount, detaches on unmount, and sends nothing else', async () => {
    const view = renderApp(<LazyPanePeek agent={A} />)
    await peekOpen()

    view.unmount()
    expect(sent).toEqual([attached('a'), detached('a')])
    expect(useStore.getState().attached).toBe(false)
  })

  it('INV-4 an unmount after the route already detached sends nothing more', async () => {
    const view = renderApp(<LazyPanePeek agent={A} />)
    await peekOpen()
    // The route switched something off underneath it.
    setAttached(false)
    sent.length = 0

    view.unmount()
    expect(sent).toEqual([])
  })

  it('draws a frame stored while attached on the Chat tab', async () => {
    renderApp(<LazyPanePeek agent={A} />)
    const peek = await peekOpen()

    arrives({ type: 'frame', frame: frameFor('a') })
    expect(useStore.getState().frame?.sessionId).toBe('a')
    expect(useStore.getState().tab).toBe('chat')
    await waitFor(() => expect(peek.textContent).toContain('❯ 1. Yes'))
  })

  it('INV-1 never sends a size: the only message it ever sends is attach', async () => {
    renderApp(<LazyPanePeek agent={A} />)
    await peekOpen()
    arrives({ type: 'frame', frame: frameFor('a', 40) })
    arrives({ type: 'frame', frame: frameFor('a', 50) })
    expect(sent.map((m) => m.type)).toEqual(['attach'])
  })

  it('INV-2 never focuses the terminal and sends nothing when clicked or typed into', async () => {
    const paneFocus = vi.spyOn(PaneTerm.prototype, 'focus')
    const xtermFocus = vi.spyOn(XTerm.prototype, 'focus')
    renderApp(<LazyPanePeek agent={A} />)
    const peek = await peekOpen()
    arrives({ type: 'frame', frame: frameFor('a') })

    fireEvent.click(peek)
    fireEvent.mouseDown(peek)
    const textarea = peek.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    expect(textarea).not.toBeNull()
    for (const key of ['Enter', 'a', '1', 'ArrowDown', 'Escape']) {
      fireEvent.keyDown(textarea as HTMLTextAreaElement, { key })
    }
    fireEvent.input(textarea as HTMLTextAreaElement, { target: { value: 'y' } })

    expect(paneFocus).not.toHaveBeenCalled()
    expect(xtermFocus).not.toHaveBeenCalled()
    expect(sent).toEqual([attached('a')])
    // The image speaks for the DOM under it; nothing there is reachable.
    expect(peek.getAttribute('role')).toBe('img')
    expect(peek.querySelector('[inert]')).not.toBeNull()
    expect(peek.querySelector('[inert]')?.contains(textarea)).toBe(true)
    paneFocus.mockRestore()
    xtermFocus.mockRestore()
  })

  it('INV-11 an exited pane is said to have exited, and is not watched', () => {
    useStore.setState({ exited: ['a'] })
    renderApp(<LazyPanePeek agent={A} />)
    // Synchronous: the exited branch renders before the lazy chunk is needed
    // only if the chunk is already loaded, so allow for either.
    return waitFor(() => {
      expect(screen.getByTestId('pane-peek-exited').textContent).toBe('pane has exited')
      expect(screen.queryByTestId('pane-peek')).toBeNull()
      expect(document.querySelector('.xterm')).toBeNull()
      expect(sent).toEqual([])
    })
  })

  it('renders nothing without a pane', async () => {
    const { container } = renderApp(<LazyPanePeek agent={agent({ sessionId: 'a', paneId: undefined })} />)
    // Give the lazy chunk a chance to land before asserting on absence.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(container.innerHTML).toBe('')
    expect(sent).toEqual([])
  })

  it('waits for the agent to be the selected one before attaching', async () => {
    useStore.setState({ selected: 'b' })
    renderApp(<LazyPanePeek agent={A} />)
    await screen.findByTestId('pane-peek')
    expect(sent).toEqual([])

    // The route catches up.
    useStore.setState({ selected: 'a' })
    await waitFor(() => expect(sent).toEqual([attached('a')]))
  })

  it('waits for the Chat tab before attaching, so the route cannot undo it', async () => {
    useStore.setState({ tab: 'attach' })
    renderApp(<LazyPanePeek agent={A} />)
    await screen.findByTestId('pane-peek')
    expect(sent).toEqual([])

    useStore.setState({ tab: 'chat' })
    await waitFor(() => expect(sent).toEqual([attached('a')]))
  })
})
