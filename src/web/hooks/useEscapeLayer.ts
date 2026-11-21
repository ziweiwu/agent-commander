import { useEffect, useRef } from 'react'

/** The open layers' close functions, the most recently opened last. */
const layers: Array<() => void> = []

/**
 * Register an open popover or disclosure as a layer Escape closes first:
 * `close` while it is open, null while it is shut.
 *
 * The app's Escape ladder lives on the document, and a layer's own key
 * handler only sees the key while focus is inside it. A click in WebKit
 * leaves focus on <body>, and a disclosure such as the agent's settings row
 * holds no focus of its own, so Escape went past the open layer and took the
 * agent away instead. The ladder asks `closeInnermostLayer` before any step of
 * its own, which is the WAI-ARIA APG rule: the innermost open thing closes
 * first, and the next Escape takes the next step.
 */
export function useEscapeLayer(close: (() => void) | null): void {
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  })
  const open = close !== null
  useEffect(() => {
    if (!open) return
    const layer = (): void => closeRef.current?.()
    layers.push(layer)
    return () => {
      const at = layers.indexOf(layer)
      if (at >= 0) layers.splice(at, 1)
    }
  }, [open])
}

/** Close the innermost open layer; false when none is open. */
export function closeInnermostLayer(): boolean {
  const innermost = layers.at(-1)
  if (!innermost) return false
  innermost()
  return true
}
