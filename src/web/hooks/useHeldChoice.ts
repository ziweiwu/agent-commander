import { useEffect, useState } from 'react'

/**
 * What the user just chose, held until the agent reports it back.
 *
 * Mode and model are both read out of the agent's transcript, which a busy
 * session writes only when its turn ends. A control bound straight to the
 * reported value therefore repaints the old one on the very next fleet
 * broadcast — a second later — and the click reads as though it did nothing,
 * whether or not it worked. That was most of what "switching does not work"
 * looked like from outside.
 *
 * Shared rather than written twice on purpose: it existed in the detail panel
 * and not in the chat strip, so the same select was fixed in one place and
 * broken in the other, two clicks apart. A second copy is how those drift.
 */
export function useHeldChoice(
  reported: string | undefined,
  sessionId: string,
): [string, (value: string) => void, () => void] {
  const [picked, setPicked] = useState<string | undefined>(undefined)

  // The agent caught up, so stop overriding it.
  useEffect(() => {
    if (picked !== undefined && reported === picked) setPicked(undefined)
  }, [reported, picked])

  // Another agent's choice is not this one's.
  useEffect(() => {
    setPicked(undefined)
  }, [sessionId])

  return [picked ?? reported ?? '', setPicked, () => setPicked(undefined)]
}
