import { describe, expect, it } from 'vitest'

/**
 * The full-screen crash: xterm queues viewport work that lands after React
 * unmounts the terminal, and reading `dimensions` off a disposed render
 * service throws. The guard has to flip immediately even though the teardown
 * itself is deferred.
 */
describe('PaneTerm disposal', () => {
  it('reports itself disposed at once, before the deferred teardown', async () => {
    const { PaneTerm } = await import('../../src/web/lib/term.ts')
    const term = new PaneTerm(
      () => {},
      () => {},
      () => {},
    )
    expect(term.disposed).toBe(false)
    term.dispose()
    expect(term.disposed).toBe(true)
  })

  it('ignores frames and rescales once disposed', async () => {
    const { PaneTerm } = await import('../../src/web/lib/term.ts')
    const term = new PaneTerm(
      () => {},
      () => {},
      () => {},
    )
    term.dispose()
    // Neither may reach xterm; both would throw against a destroyed renderer.
    expect(() =>
      term.apply({ sessionId: 'a', cols: 80, rows: 24, cursorX: 0, cursorY: 0, lines: ['x'] }),
    ).not.toThrow()
    expect(() => term.rescale()).not.toThrow()
    expect(() => term.scheduleRescale()).not.toThrow()
    expect(() => term.focus()).not.toThrow()
  })

  it('is safe to dispose twice', async () => {
    const { PaneTerm } = await import('../../src/web/lib/term.ts')
    const term = new PaneTerm(
      () => {},
      () => {},
      () => {},
    )
    term.dispose()
    expect(() => term.dispose()).not.toThrow()
  })
})
