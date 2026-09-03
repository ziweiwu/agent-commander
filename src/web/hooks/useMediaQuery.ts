import { useSyncExternalStore } from 'react'

/**
 * Subscribe to a media query.
 *
 * useSyncExternalStore rather than useState+useEffect so the first render
 * already has the right answer — a wrong first paint would flash the desktop
 * two-column layout on a phone.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => matchMedia(query).matches,
    () => false,
  )
}

/*
 * Three layouts, two width cuts.
 *
 * There were eleven width breakpoints between 900px and 380px, each hiding or
 * shrinking one thing, each with a measured comment justifying it. The
 * measurements were right; the accumulation was what a reader could not hold,
 * and INV-17 already said there are three layouts. So the stylesheets now cut
 * at two widths and nowhere else — `test/responsive.test.ts` holds them to
 * it — and the components read the same two through the hooks below.
 *
 * Height is its own axis (`useIsShort`), and so is the pointer: a phone-sized
 * desktop window reports `pointer: fine`, and target size follows the finger,
 * not the width.
 */
/** Above this the fleet list and the detail sit side by side. */
export const NARROW_MAX_PX = 900
/** At or below this the layout is a phone's: one column, labels to glyphs. */
export const PHONE_MAX_PX = 560

export type Layout = 'desktop' | 'tablet' | 'phone'

/** Narrow enough that the detail panel replaces the list rather than sitting beside it. */
export const useIsNarrow = (): boolean => useMediaQuery(`(max-width: ${NARROW_MAX_PX}px)`)

/** Which of the three layouts the viewport is in. */
export function useLayout(): Layout {
  const narrow = useIsNarrow()
  const phone = useMediaQuery(`(max-width: ${PHONE_MAX_PX}px)`)
  if (phone) return 'phone'
  return narrow ? 'tablet' : 'desktop'
}

/** Touch input: used to avoid popping the on-screen keyboard unasked. */
export const useIsCoarse = (): boolean => useMediaQuery('(pointer: coarse)')

/**
 * Too short to spend height on a row of settings — a landscape phone.
 *
 * The composer strip collapses behind a disclosure here rather than being
 * dropped: INV-17 says a shape may re-arrange what it shows and may not take a
 * capability away, and the goal, the send-mode choice and the quick replies
 * live nowhere else.
 */
export const useIsShort = (): boolean => useMediaQuery('(max-height: 420px)')
