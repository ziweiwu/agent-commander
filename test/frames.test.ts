import { describe, expect, it } from 'vitest'
import { buildFrame, isNoop } from '../src/server/frames.ts'

const geom = { cols: 80, rows: 3, cursorX: 0, cursorY: 0 }

describe('buildFrame', () => {
  it('sends a full frame on first paint', () => {
    const frame = buildFrame('s', null, ['a', 'b', 'c'], geom)
    expect(frame.lines).toEqual(['a', 'b', 'c'])
    expect(frame.changed).toBeUndefined()
  })

  it('sends only the rows that changed', () => {
    const frame = buildFrame('s', ['a', 'b', 'c'], ['a', 'B', 'c'], geom)
    expect(frame.lines).toBeUndefined()
    expect(frame.changed).toEqual([{ row: 1, text: 'B' }])
  })

  it('falls back to a full frame when the row count changes', () => {
    const frame = buildFrame('s', ['a', 'b'], ['a', 'b', 'c'], geom)
    expect(frame.lines).toEqual(['a', 'b', 'c'])
  })

  it('reports an empty delta when nothing moved', () => {
    const frame = buildFrame('s', ['a', 'b', 'c'], ['a', 'b', 'c'], geom)
    expect(frame.changed).toEqual([])
  })

  it('always carries current geometry and cursor', () => {
    const frame = buildFrame('s', ['a'], ['a'], { cols: 150, rows: 47, cursorX: 2, cursorY: 44 })
    expect(frame).toMatchObject({ cols: 150, rows: 47, cursorX: 2, cursorY: 44 })
  })
})

describe('isNoop', () => {
  // INV-4: an idle pane must not generate WebSocket traffic 7x a second.
  it('INV-4 suppresses a frame with no row or cursor change', () => {
    const frame = buildFrame('s', ['a'], ['a'], geom)
    expect(isNoop(frame, { x: 0, y: 0 })).toBe(true)
  })

  it('sends when only the cursor moved', () => {
    const frame = buildFrame('s', ['a'], ['a'], { ...geom, cursorX: 5 })
    expect(isNoop(frame, { x: 0, y: 0 })).toBe(false)
  })

  it('never suppresses a full frame', () => {
    const frame = buildFrame('s', null, ['a'], geom)
    expect(isNoop(frame, { x: 0, y: 0 })).toBe(false)
  })

  it('never suppresses the very first delta, when no cursor is known yet', () => {
    const frame = buildFrame('s', ['a'], ['a'], geom)
    expect(isNoop(frame, null)).toBe(false)
  })
})
