import { useEffect } from 'react'
import { keyboardState } from '../lib/viewport.ts'

/** The CSS variable the sheet and the full-screen overlay size themselves from. */
export const VIEWPORT_HEIGHT_VAR = '--vvh'
/** Where the visible region starts, in layout-viewport pixels; iOS pans it. */
export const VIEWPORT_TOP_VAR = '--vvt'

/**
 * Write the visible rectangle onto the root, and say whether a keyboard is up.
 *
 * Returns what it decided so the caller can act on the transition.
 */
function applyViewport(root: HTMLElement, viewport: VisualViewport): boolean {
  const { height, keyboardOpen } = keyboardState({
    visualHeight: viewport.height,
    layoutHeight: window.innerHeight,
  })
  root.style.setProperty(VIEWPORT_HEIGHT_VAR, `${height}px`)
  root.style.setProperty(VIEWPORT_TOP_VAR, `${Math.round(viewport.offsetTop)}px`)
  if (keyboardOpen) root.dataset.keyboard = 'true'
  else delete root.dataset.keyboard
  return keyboardOpen
}

/**
 * Bring the focused field back inside the sheet's own scrollers, once the
 * layout has taken the keyboard's height.
 *
 * The composer sits at the bottom of a box that now fits, so this is a no-op
 * there; the terminal's textarea rides its cursor, which may be on a row the
 * shrunken pane has scrolled under the keyboard — this is what scrolls it
 * back. Only a real field: with nothing focused the active element is the
 * body, which has nothing to be scrolled to.
 */
function revealFocusedField(): void {
  requestAnimationFrame(() => {
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement) || focused === document.body) return
    if (typeof focused.scrollIntoView !== 'function') return
    focused.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * Keep `--vvh`, `--vvt` and `data-keyboard` on the root in step with the
 * visual viewport, so the mobile sheet and the full-screen overlay lay out
 * above an on-screen keyboard rather than under it.
 *
 * On iOS Safari the layout viewport does not shrink for the keyboard; the
 * visual one does, and Safari *pans* it — the visible region slides down the
 * layout viewport by `offsetTop` to keep the focused field on screen. A sheet
 * that only shrank was then sitting at the top of a layout viewport whose top
 * was no longer visible: the reader saw the sheet's lower half and the empty
 * document below it, which reads as nothing having adjusted at all. So the
 * sheet follows the pan too: its top is `--vvt`, and its height `--vvh`,
 * which together are exactly the visible rectangle. Android Chrome resizes
 * the layout viewport itself, so there both are 0 and the height agrees, and
 * this changes nothing.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    if (!viewport) return
    let wasOpen = false
    const apply = (): void => {
      const open = applyViewport(root, viewport)
      // Once per opening, not per pan, or it fights a finger.
      if (open && !wasOpen) revealFocusedField()
      wasOpen = open
    }
    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      root.style.removeProperty(VIEWPORT_HEIGHT_VAR)
      root.style.removeProperty(VIEWPORT_TOP_VAR)
      delete root.dataset.keyboard
    }
  }, [])
}
