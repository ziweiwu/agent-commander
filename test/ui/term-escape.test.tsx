import { describe, expect, it, vi } from 'vitest'

/**
 * Shift+Escape is the only way out of the terminal, because plain Escape
 * belongs to the agent it is attached to.
 *
 * The terminal has to intercept it itself: xterm swallows most keys, so the
 * app's document listener never sees them. But it was only calling
 * `preventDefault`, and this particular key was one xterm did *not* swallow —
 * so the event still reached the document listener, which took its own step
 * back. Two handlers for one keystroke: from full screen it left full screen
 * *and* navigated to the list, discarding two levels at once and dropping focus
 * onto <body>.
 */
async function handlerFor(onExit: () => void) {
  const { Terminal } = await import('@xterm/xterm')
  // Installed before PaneTerm is constructed, because it attaches in its
  // constructor. This is the handler xterm would be calling for real.
  const spy = vi.spyOn(Terminal.prototype, 'attachCustomKeyEventHandler')
  const { PaneTerm } = await import('../../src/web/lib/term.ts')
  const term = new PaneTerm(
    () => {},
    () => {},
    onExit,
  )
  const captured = spy.mock.calls[0]?.[0] as ((e: KeyboardEvent) => boolean) | undefined
  spy.mockRestore()
  return { term, captured: captured ?? null }
}

const key = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })

describe('terminal Shift+Escape', () => {
  it('steps back exactly once and stops the event travelling further', async () => {
    const onExit = vi.fn()
    const { term, captured } = await handlerFor(onExit)
    expect(captured).not.toBeNull()

    const event = key({ shiftKey: true })
    const stop = vi.spyOn(event, 'stopPropagation')
    const prevent = vi.spyOn(event, 'preventDefault')
    captured?.(event)

    expect(onExit).toHaveBeenCalledTimes(1)
    // Without this the app's own handler runs too and takes a second step.
    expect(stop).toHaveBeenCalled()
    expect(prevent).toHaveBeenCalled()
    term.dispose()
  })

  // Plain Escape interrupts the agent; it must not step back at all.
  it('leaves plain Escape to the agent', async () => {
    const onExit = vi.fn()
    const { term, captured } = await handlerFor(onExit)

    captured?.(key({ shiftKey: false }))

    expect(onExit).not.toHaveBeenCalled()
    term.dispose()
  })
})
