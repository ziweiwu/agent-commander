/**
 * Text that never arrives as a keystroke still reaches the pane (FR-UI-19).
 *
 * The terminal takes keys through xterm's custom key handler, and on a
 * desktop that is every character. On Android Chrome a software keyboard
 * delivers characters through input and composition events with an
 * `Unidentified` keydown, and Chinese input on every platform is a
 * composition committed at the end — so with only the key handler, typing
 * into the pane on a phone sent nothing. xterm's data stream is the second
 * door, and the two must not both deliver one character.
 */
import { describe, expect, it, vi } from 'vitest'

async function wired() {
  const { Terminal } = await import('@xterm/xterm')
  const keys = vi.spyOn(Terminal.prototype, 'attachCustomKeyEventHandler')
  // `onData` is a getter on the prototype at runtime; the types call it a
  // property, so the spy needs to be told what it is spying on.
  const proto = Terminal.prototype as unknown as { onData: object }
  const dataSpy = vi.spyOn(proto, 'onData', 'get')
  const listeners: Array<(text: string) => void> = []
  dataSpy.mockReturnValue(((fn: (text: string) => void) => {
    listeners.push(fn)
    return { dispose: () => {} }
  }) as never)
  const { PaneTerm } = await import('../../src/web/lib/term.ts')
  const onText = vi.fn()
  const term = new PaneTerm(() => {}, onText, () => {})
  const handler = keys.mock.calls[0]?.[0] as (e: KeyboardEvent) => boolean
  keys.mockRestore()
  dataSpy.mockRestore()
  return { term, onText, handler, emit: (text: string) => listeners.forEach((l) => l(text)) }
}

describe('terminal input from a software keyboard', () => {
  it('delivers composed text through the data stream', async () => {
    const { term, onText, emit } = await wired()
    emit('继续')
    expect(onText).toHaveBeenCalledExactlyOnceWith('继续')
    term.dispose()
  })

  it('does not deliver a key the handler already took', async () => {
    const { term, onText, handler } = await wired()
    const e = new KeyboardEvent('keydown', { key: 'a', cancelable: true })
    handler(e)
    // Taken, and prevented: the textarea never changes, so no data follows.
    expect(e.defaultPrevented).toBe(true)
    expect(onText).toHaveBeenCalledExactlyOnceWith('a')
    term.dispose()
  })

  it('lets an unidentified keydown through to the data stream instead', async () => {
    const { term, onText, handler, emit } = await wired()
    // Android Chrome, Gboard: the keydown says nothing, the input event does.
    const e = new KeyboardEvent('keydown', { key: 'Unidentified', cancelable: true })
    handler(e)
    expect(onText).not.toHaveBeenCalled()
    emit('a')
    expect(onText).toHaveBeenCalledExactlyOnceWith('a')
    term.dispose()
  })
})
