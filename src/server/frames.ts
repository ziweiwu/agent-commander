import type { Frame } from '../shared/types.ts'

/**
 * Build the smallest frame that turns `prev` into `next`.
 *
 * The Attach view repaints a captured pane ~7x/second. Rewriting all 47 rows
 * each time makes xterm.js flicker and wastes bandwidth, so we send only the
 * rows that actually changed. A null `prev` (first paint, or a geometry change)
 * forces a full frame.
 */
export function buildFrame(
  sessionId: string,
  prev: string[] | null,
  next: string[],
  geom: { cols: number; rows: number; cursorX: number; cursorY: number },
): Frame {
  const base: Frame = {
    sessionId,
    cols: geom.cols,
    rows: geom.rows,
    cursorX: geom.cursorX,
    cursorY: geom.cursorY,
  }
  if (!prev || prev.length !== next.length) {
    return { ...base, lines: next }
  }
  const changed: Array<{ row: number; text: string }> = []
  for (let i = 0; i < next.length; i += 1) {
    if (prev[i] !== next[i]) changed.push({ row: i, text: next[i] ?? '' })
  }
  return { ...base, changed }
}

/** True when a frame carries no visual change and need not be sent at all. */
export function isNoop(frame: Frame, prevCursor: { x: number; y: number } | null): boolean {
  if (frame.lines) return false
  if ((frame.changed?.length ?? 0) > 0) return false
  return prevCursor !== null && prevCursor.x === frame.cursorX && prevCursor.y === frame.cursorY
}
