import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'

/**
 * How long a control that sends ignores presses after it appears under the
 * reader: a question, a set's next question, or the composer's menu.
 *
 * Opening a blocked agent puts focus (desk) or the finger (phone) on option
 * one, which on a permission dialog is "Yes"; opening the menu focuses its
 * first reply. The tail of the gesture that opened it — a double tap's second
 * tap, 100-400ms behind the first — then landed there and answered a question
 * nobody had read (INV-2). 600ms is the order of browsers' own input delay on
 * permission prompts, and the owner's choice: a contestant saw a second tap
 * land at 900ms, and a longer window delays a deliberate fast answer.
 */
export const ARRIVAL_GUARD_MS = 600

/**
 * Cancel a held key's auto-repeat, so it cannot activate the control that
 * focus moved onto. A browser clicks a button on an Enter keydown that nothing
 * cancelled, so cancelling the keydown is what stops the click; the click
 * itself carries no `repeat` to check.
 */
export function refuseRepeat(event: KeyboardEvent<HTMLElement>): void {
  if (event.repeat) event.preventDefault()
}

/**
 * Whether a press now is still part of the gesture that brought `arrival` on
 * screen. The window restarts whenever `arrival` changes, so a set's next
 * question gets its own; `null` means nothing is showing.
 *
 * A layout effect rather than a passive one, because a passive effect may
 * still be pending when the next click is dispatched, and that click would
 * read the previous arrival's time. A clock stepped backwards reads as
 * settled rather than holding every press until it catches up.
 */
export function useArrival(arrival: string | null): () => boolean {
  const arrivedAt = useRef(0)
  useLayoutEffect(() => {
    arrivedAt.current = Date.now()
  }, [arrival])
  return () => {
    if (arrival === null) return false
    const elapsed = Date.now() - arrivedAt.current
    return elapsed >= 0 && elapsed < ARRIVAL_GUARD_MS
  }
}
