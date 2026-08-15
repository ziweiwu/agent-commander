import { useEffect, type RefObject } from 'react'

/**
 * Make an open dialog behave like a modal for the keyboard and a screen reader.
 *
 * `role="dialog" aria-modal="true"` is a promise to assistive technology, not a
 * behaviour: on its own it does nothing to stop Tab walking straight out of the
 * dialog and into the page underneath. A backdrop that swallows *clicks* hides
 * that, which is why this survived a click-driven fuzzer — the escape is
 * keyboard-only. In the fullscreen view it was worse than untidy: Tab reached
 * the covered fleet list and Enter on a card there switched which agent was
 * open, while the header still named the old one.
 *
 * The fix is `inert` on everything else at body level, which is what a native
 * `<dialog>.showModal()` does. It blocks focus, clicks and the screen reader's
 * virtual cursor in one move, so Tab can only cycle within the dialog and the
 * fleet list behind is no longer browsable.
 *
 * This requires the dialog to be portalled to `document.body`, so that "the
 * rest of the app" is a set of siblings rather than an ancestor we cannot
 * exclude.
 *
 * Focus is restored to whatever opened the dialog when it closes, so Escape
 * leaves the keyboard where it started rather than at the top of the document.
 * Placing initial focus stays with the caller — only it knows which control is
 * the useful one to land on.
 */
export function useModalChrome(ref: RefObject<HTMLElement | null>, active: boolean): void {
  startTracking()

  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    // Not `document.activeElement`: by the time this runs, the control that
    // opened the dialog may already be gone. Going full screen replaces the
    // detail panel with the overlay, so React removes the very button that was
    // clicked during that same commit and the browser drops focus to <body> —
    // which is what this used to capture, and then dutifully restore to.
    const opener = openerFor(container)
    // The node often does not survive either, so remember how to find the
    // control again: on the way back it is a new element with the same testid,
    // and the original reference is detached.
    const openerTestId = opener?.getAttribute('data-testid') ?? null

    const inerted: HTMLElement[] = []
    for (const sibling of Array.from(document.body.children)) {
      if (!(sibling instanceof HTMLElement)) continue
      if (sibling === container || sibling.contains(container)) continue
      // Already inert because a second dialog is stacked over this one; leave
      // it to whichever dialog set it, or closing this one would revive it.
      if (sibling.inert) continue
      sibling.inert = true
      inerted.push(sibling)
    }

    // `inert` keeps focus out of the page behind, but it does not make Tab
    // cycle: from the last control it steps to the browser chrome by way of
    // <body>, which reads as a silent stop. Wrapping both directions is the
    // rest of the APG dialog pattern.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const stops = tabStops(container)
      const first = stops[0]
      const last = stops.at(-1)
      if (first === undefined || last === undefined) return

      // Not named `active`: that is the hook's own parameter.
      const focused = document.activeElement
      if (event.shiftKey && (focused === first || focused === container)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && focused === last) {
        event.preventDefault()
        first.focus()
      }
    }
    container.addEventListener('keydown', onKeyDown)

    return () => {
      container.removeEventListener('keydown', onKeyDown)
      for (const sibling of inerted) sibling.inert = false
      // Deferred by one microtask so the restore wins. Closing a dialog often
      // remounts what it covered, and those mount effects run in the same
      // commit as this cleanup — the fullscreen view's Chat grabs the composer
      // on mount, which beat a synchronous restore every time.
      queueMicrotask(() => {
        if (opener?.isConnected) {
          opener.focus()
          return
        }
        // Same control, new element. Nothing to go back to at all is also a
        // real case — an agent card whose agent ended — and then we leave focus
        // where it is rather than guessing.
        if (openerTestId === null) return
        const replacement = document.querySelector<HTMLElement>(
          `[data-testid="${openerTestId}"]`,
        )
        replacement?.focus()
      })
    }
  }, [ref, active])
}

/**
 * A short history of what the user has focused, most recent last.
 *
 * `document.activeElement` cannot answer "what opened this dialog?", for two
 * independent reasons, and both bit this hook in turn:
 *
 * 1. The control is often unmounted by the state change it triggered — going
 *    full screen replaces the whole detail panel — so focus has already fallen
 *    back to <body> before any effect runs.
 * 2. React runs child effects before parent ones, so by the time the dialog's
 *    own hook runs, something *inside* the dialog has already taken focus. The
 *    fullscreen view mounts a chat that focuses its composer, and that is what
 *    `activeElement` reports.
 *
 * `focusin` sees every one of these in order, so walking back to the most
 * recent entry outside the dialog finds the real opener.
 */
const HISTORY_MAX = 10
const history: HTMLElement[] = []
let tracking = false

/** The most recently focused element that is not inside `container`. */
function openerFor(container: HTMLElement): HTMLElement | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const candidate = history[i] as HTMLElement
    if (!container.contains(candidate)) return candidate
  }
  return null
}

function startTracking(): void {
  if (tracking || typeof document === 'undefined') return
  tracking = true
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target === document.body) return
      if (history.at(-1) === target) return
      history.push(target)
      if (history.length > HISTORY_MAX) history.shift()
    },
    true,
  )
}

const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * The dialog's own tab stops, in document order.
 *
 * Visibility is read from computed style rather than `offsetParent`, which is
 * the usual idiom but reports null for everything in a layout-less DOM — under
 * jsdom that silently emptied this list and turned the wrap into a no-op that
 * still passed its own test.
 */
function tabStops(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.hasAttribute('disabled') || el.tabIndex < 0) return false
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}
