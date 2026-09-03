import { useEffect, useRef, useState, type RefObject } from 'react'

/** Which edges of a scroll container have content past them. */
export type OverflowEdge = 'none' | 'bottom' | 'right' | 'bottom right'

/** The decision on its own, so it can be tested without a layout engine. */
export function edgesOf(box: {
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  scrollWidth: number
  clientHeight: number
  clientWidth: number
}): OverflowEdge {
  // A pixel of slack: fractional layout leaves scrollHeight a hair over
  // clientHeight on a box that does not scroll at all.
  const below = box.scrollHeight - box.clientHeight - box.scrollTop > 1
  const beyond = box.scrollWidth - box.clientWidth - box.scrollLeft > 1
  if (below && beyond) return 'bottom right'
  if (below) return 'bottom'
  if (beyond) return 'right'
  return 'none'
}

/**
 * Say that a container scrolls.
 *
 * macOS overlay scrollbars and every phone hide the scrollbar at rest, so a
 * box that clips its content gives no sign that more exists — the second
 * answer option below the fold of a landscape phone, the tail of a folder
 * listing. Three findings in one audit shared that cause. The hook reports
 * which edge has content past it as a `data-overflow` value; the stylesheet
 * draws a fade on that edge and nothing where the content ends, so the fade
 * is a measurement rather than a permanent suggestion of more.
 */
export function useOverflowEdge<T extends HTMLElement>(): [RefObject<T | null>, OverflowEdge] {
  const ref = useRef<T>(null)
  const [edge, setEdge] = useState<OverflowEdge>('none')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setEdge(edgesOf(el))
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    // Content changes size without the box moving: a reply arriving, a
    // listing loading. ResizeObserver sees the children; the box's own
    // resize comes through it too.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    for (const child of Array.from(el.children)) observer?.observe(child)
    const mutations =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            measure()
            for (const child of Array.from(el.children)) observer?.observe(child)
          })
    mutations?.observe(el, { childList: true })
    return () => {
      el.removeEventListener('scroll', measure)
      observer?.disconnect()
      mutations?.disconnect()
    }
  }, [])

  return [ref, edge]
}
