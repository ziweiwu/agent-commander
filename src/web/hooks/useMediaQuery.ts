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

/** Narrow enough that the detail panel replaces the list rather than sitting beside it. */
export const useIsNarrow = (): boolean => useMediaQuery('(max-width: 900px)')

/** Touch input: used to avoid popping the on-screen keyboard unasked. */
export const useIsCoarse = (): boolean => useMediaQuery('(pointer: coarse)')
