/**
 * INV-17: putting text into the terminal from a shape with no keyboard.
 *
 * xterm reads typing and pastes through a hidden 1px textarea behind the
 * capture, so both need a hardware keyboard. A phone has no Cmd+V and nothing
 * on that surface it can long-press for its own Paste menu, which left the
 * Attach tab unable to accept a paste at all on the shape this app exists for
 * — a phone over Tailscale — while every desktop test went on passing, because
 * the desktop path was never broken.
 *
 * The first attempt at this read the clipboard for the user. Measured on
 * WebKit, the engine behind every browser on iOS, `readText()` is refused
 * outright (`NotAllowedError`) even from inside a tap: the button reported a
 * failure on the one platform it was added for. So the surface carries a real
 * input instead and the paste is the operating system's, which needs no
 * permission, no secure context and no clipboard API. These tests hold that
 * line — including that nothing here touches `navigator.clipboard` again.
 *
 * What is sent is text and not a submission (INV-2): Enter is the key beside
 * it, so a reader can see what landed before running it.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Terminal } from '../../src/web/components/Terminal.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

const sendText = vi.hoisted(() => vi.fn())
vi.mock('../../src/web/store/transport.ts', () => ({
  sendText,
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendShiftTab: vi.fn(),
  setAttached: vi.fn(),
  requestHistory: vi.fn(),
}))

const noop = (): void => {}
const open = (over = {}) =>
  renderApp(<Terminal agent={agent({ sessionId: 'a', paneId: '%1', ...over })} onExit={noop} />)

const input = () => screen.getByTestId('term-compose-input') as HTMLTextAreaElement
const send = () => screen.getByTestId('term-compose-send') as HTMLButtonElement

beforeEach(() => {
  resetStore()
  sendText.mockClear()
})

describe('the terminal takes text without a keyboard shortcut', () => {
  it('puts what was pasted at the prompt, unsubmitted', async () => {
    const user = userEvent.setup()
    open()

    await user.type(input(), 'npm run build')
    await user.click(send())

    await waitFor(() => expect(sendText).toHaveBeenCalledWith('npm run build'))
    // Text only. Running it is the Enter key beside this, on purpose.
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  it('clears the line once it has gone', async () => {
    const user = userEvent.setup()
    open()

    await user.type(input(), 'ls -la')
    await user.click(send())

    await waitFor(() => expect(input().value).toBe(''))
  })

  /*
   * INV-2's "exactly once". `draft` is read from a closure and `setDraft('')`
   * does not land until React flushes, so two presses in one batch would each
   * read the same uncleared draft and each send it into a live agent.
   */
  it('sends once from a double-tapped Send', async () => {
    const user = userEvent.setup()
    open()

    await user.type(input(), 'deploy')
    await user.dblClick(send())

    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1))
  })

  it('sends once when the keyboard return key repeats', async () => {
    const user = userEvent.setup()
    open()

    await user.type(input(), 'deploy')
    await user.keyboard('{Enter}{Enter}{Enter}')

    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1))
    expect(sendText).toHaveBeenCalledWith('deploy')
  })

  /*
   * The payload this whole control exists for. An `<input>` runs the value
   * sanitisation algorithm and strips CR and LF, so a three-line snippet
   * pasted into one arrived at a live agent as a single run-together command
   * — text quietly altered on its way there, which is the worst way this could
   * fail. The field is a textarea for that reason alone.
   */
  it('keeps the newlines in a multi-line paste', async () => {
    const user = userEvent.setup()
    open()

    const snippet = 'cd /tmp\nnpm ci\nnpm test'
    await user.click(input())
    await user.paste(snippet)
    await user.click(send())

    await waitFor(() => expect(sendText).toHaveBeenCalledWith(snippet))
  })

  /*
   * Growing is not decoration: sending text rather than submitting it is what
   * gives the reader a chance to check what landed, and a three-line paste in
   * a one-line box cannot be checked. It goes back to one line afterwards,
   * because the inline height would otherwise outlive the text it measured.
   */
  it('grows to show a pasted snippet, and shrinks back once it has gone', async () => {
    const user = userEvent.setup()
    open()
    const box = input()
    // jsdom lays nothing out, so `scrollHeight` is 0 and the real number
    // cannot be asserted; that a height was written for the text, and unset
    // with it, is the part that is logic rather than layout.
    Object.defineProperty(box, 'scrollHeight', { value: 90, configurable: true })

    await user.click(box)
    await user.paste('one\ntwo\nthree')
    expect(box.style.height).toBe('90px')

    await user.click(send())
    await waitFor(() => expect(box.style.height).toBe(''))
  })

  /* Typed by hand, a newline is Shift+Enter — Enter is the send (as in chat). */
  it('takes a hand-typed newline without sending', async () => {
    const user = userEvent.setup()
    open()

    await user.click(input())
    await user.keyboard('one{Shift>}{Enter}{/Shift}two')

    expect(sendText).not.toHaveBeenCalled()
    expect(input().value).toBe('one\ntwo')
  })

  it('offers nothing to send from an empty line', () => {
    open()
    expect(send().disabled).toBe(true)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('is closed once the pane has exited', async () => {
    open()
    useStore.setState({ exited: ['a'] })

    await waitFor(() => expect(input().disabled).toBe(true))
    expect(send().disabled).toBe(true)
    expect(sendText).not.toHaveBeenCalled()
  })

  /* A field a screen reader can announce, not a bare box beside a button. */
  it('names itself', () => {
    open()
    expect(screen.getByLabelText(/prompt/i)).toBe(input())
  })

  /*
   * The regression that sent this back for a second attempt.
   *
   * Read off the source rather than by stubbing `navigator.clipboard`: the
   * test library installs a clipboard of its own for `userEvent`, so a stub
   * here fights it, and what needs holding down is that the component never
   * reaches for the API at all — which is a property of the file, the way
   * INV-1's "no size ever reaches tmux" is.
   */
  it('never reads the clipboard, on any platform', () => {
    const source = readFileSync('src/web/components/Terminal.tsx', 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/navigator\.clipboard/)
  })
})
