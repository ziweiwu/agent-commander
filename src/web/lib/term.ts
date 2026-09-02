/**
 * xterm.js view of a captured tmux pane.
 *
 * INV-1: the terminal is sized from the pane's own reported geometry and never
 * the other way round. Browser resizes only change a CSS transform, so widening
 * this window can never resize the user's real tmux pane.
 */
import { Terminal } from '@xterm/xterm'
// Imported here rather than in the entry so it ships with the terminal chunk.
import '@xterm/xterm/css/xterm.css'
import type { Frame } from '../../shared/types.ts'

const BASE_FONT = 13

/**
 * Never scale text below this. A 150-column pane squeezed into a 390px phone
 * would otherwise render at ~4.6px, which is unreadable; past this floor the
 * terminal keeps its size and pans horizontally instead.
 */
const MIN_EFFECTIVE_FONT = 9.5

/** Long enough to outlast xterm's own queued viewport callbacks. */
const DISPOSE_DELAY_MS = 250
/** Below this, a scale is 1:1 for every purpose a reader has. */
const SCALE_EPSILON = 0.001

export type ZoomMode = 'readable' | 'fit'

export interface ScaleInput {
  /** Natural pixel width of the rendered pane at BASE_FONT. */
  naturalWidth: number
  /** Pixel width of the container it has to live in. */
  available: number
  /**
   * Natural pixel height of the rendered pane, and of its container.
   *
   * Optional because width alone decided this for as long as the ceiling was 1:
   * a capture could only ever shrink, and shrinking to fit the width always fit
   * the height too. Enlarging breaks that — growing on width alone pushes rows
   * off the bottom and turns "too small to read" into "cut off", which is
   * worse. Given both, the smaller of the two fits wins.
   */
  naturalHeight?: number
  availableHeight?: number
  zoom: ZoomMode
  /**
   * Largest scale allowed. 1 inside the detail panel, where the pane sits
   * beside other content and growing it would just crowd them. Full screen
   * raises it: there the pane is the only thing on screen, and a 150-column
   * capture at 1:1 leaves most of a desktop display empty.
   *
   * This is a CSS transform on the capture, so INV-1 is untouched — the real
   * tmux pane is never resized either way.
   */
  maxScale?: number
}

export interface ScaleResult {
  /** CSS transform scale to apply. */
  scale: number
  /** True when the pane is wider than the container and must be panned. */
  overflowing: boolean
  /** Resulting text size, for reasoning about legibility. */
  effectiveFont: number
}

/**
 * Decide how much to shrink the pane.
 *
 * "fit" always shrinks to the container. "readable" refuses to go below
 * MIN_EFFECTIVE_FONT — a 150-column pane in a 390px phone would otherwise
 * render at about 4.6px — and reports that the result must be panned instead.
 * Neither mode scales up past `maxScale`, which defaults to 1: on that default
 * the pane is a faithful capture rather than a canvas to stretch.
 *
 * This is a CSS transform on the capture either way. INV-1 is untouched: `cols`
 * and `rows` never travel back to tmux, so the real pane is not resized by any
 * of it.
 */
export function computeScale({
  naturalWidth,
  available,
  naturalHeight,
  availableHeight,
  zoom,
  maxScale,
}: ScaleInput): ScaleResult {
  if (naturalWidth <= 0 || available <= 0) {
    return { scale: 1, overflowing: false, effectiveFont: BASE_FONT }
  }
  const ceiling = maxScale ?? 1
  // Only constrains when both are known and real; a caller that measured
  // nothing is left exactly where it was.
  const heightFit =
    naturalHeight !== undefined && availableHeight !== undefined && naturalHeight > 0 && availableHeight > 0
      ? availableHeight / naturalHeight
      : Number.POSITIVE_INFINITY
  const fit = Math.min(ceiling, available / naturalWidth, heightFit)
  const floor = MIN_EFFECTIVE_FONT / BASE_FONT
  const scale = zoom === 'fit' ? fit : Math.min(ceiling, Math.max(fit, floor))
  return {
    scale,
    overflowing: Math.round(naturalWidth * scale) > available + 1,
    effectiveFont: Math.round(BASE_FONT * scale * 10) / 10,
  }
}

/** Repaint a row: home the cursor, reset SGR, clear, then draw. */
function rowSeq(row: number, text: string): string {
  return `\u001b[${row + 1};1H\u001b[0m\u001b[2K${text}`
}

export class PaneTerm {
  readonly term: Terminal
  #zoom: ZoomMode = 'readable'
  #maxScale = 1
  #overflowing = false
  #scale = 1
  #onZoomChange: (() => void) | null = null
  /**
   * xterm throws from its own Viewport if anything touches it after dispose —
   * `Cannot read properties of undefined (reading 'dimensions')`. React can
   * unmount this between a frame arriving and the rAF that measures it, so
   * every entry point checks before doing anything.
   */
  #disposed = false
  #rafs: number[] = []
  #cols = 0
  #rows = 0
  #host: HTMLElement | null = null
  #scaler: HTMLElement | null = null

  constructor(onKey: (key: string) => void, onText: (text: string) => void, onExit: () => void) {
    this.term = new Terminal({
      fontSize: BASE_FONT,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      convertEol: false,
      cursorBlink: true,
      scrollback: 0,
      allowProposedApi: true,
      theme: { background: '#000000' },
    })

    // Keys are intercepted here rather than via onKey because xterm calls
    // stopPropagation on the keys it handles, so a document-level listener never
    // sees Escape — which would strand a keyboard user inside the terminal.
    // Returning false tells xterm not to process the event itself; every path
    // below routes the key through the server instead.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return false

      // One step back out. Plain Escape belongs to the agent.
      //
      // `stopPropagation` matters as much as `preventDefault`: xterm swallows
      // most keys, which is why this handler exists at all, but it does not
      // swallow this one — the event still reached the app's document listener,
      // which took its own step back. Two handlers, one keystroke: from full
      // screen it exited full screen *and* navigated to the list, discarding
      // two levels and leaving focus on <body>.
      if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        onExit()
        return false
      }

      const mapped = mapKey(e)
      if (mapped) {
        e.preventDefault()
        onKey(mapped)
        return false
      }

      // A single printable character goes through as literal text.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        onText(e.key)
      }
      return false
    })
  }

  onZoomChange(fn: () => void): void {
    this.#onZoomChange = fn
  }

  mount(host: HTMLElement, scaler: HTMLElement): void {
    if (this.#disposed) return
    this.#host = host
    this.#scaler = scaler
    this.term.open(scaler)
  }

  focus(): void {
    if (this.#disposed) return
    this.term.focus()
  }

  /**
   * Tear down, but not immediately.
   *
   * xterm queues its own viewport work (`Viewport.syncScrollArea`) that can run
   * a frame or two after React unmounts us — every full-screen enter and exit
   * does this. If the terminal is already disposed when that callback lands, it
   * reads `dimensions` off a destroyed render service and throws.
   *
   * So the guard flag flips at once, which stops *our* code touching it, and
   * the actual teardown is deferred past those pending callbacks. The element
   * is detached from the DOM by React in the meantime, so nothing is visible;
   * this only keeps the object alive long enough to be safely torn down.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const handle of this.#rafs) cancelAnimationFrame(handle)
    this.#rafs = []
    const term = this.term
    setTimeout(() => {
      try {
        term.dispose()
      } catch {
        // Already gone; nothing left to release.
      }
    }, DISPOSE_DELAY_MS)
  }

  get disposed(): boolean {
    return this.#disposed
  }

  apply(frame: Frame): void {
    if (this.#disposed) return
    if (frame.cols !== this.#cols || frame.rows !== this.#rows) {
      this.#cols = frame.cols
      this.#rows = frame.rows
      this.term.resize(frame.cols, frame.rows)
      // Autowrap off: a full-width write on the last row would otherwise
      // scroll the viewport and desync every subsequent row update.
      // (rescale is deferred below: xterm has not laid out the new geometry yet.)
      this.term.write('\u001b[?7l')
      this.scheduleRescale()
    }

    let out = ''
    if (frame.lines) {
      out += '\u001b[H'
      frame.lines.forEach((line, i) => {
        out += rowSeq(i, line)
      })
    } else if (frame.changed) {
      for (const { row, text } of frame.changed) out += rowSeq(row, text)
    }
    out += `\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H`
    this.term.write(out)
  }

  /**
   * Measure on the next frame. xterm sizes its DOM asynchronously after a
   * resize, so measuring in the same tick reads a stale or zero width and the
   * terminal would keep its default box forever.
   */
  scheduleRescale(): void {
    if (this.#disposed) return
    // Handles are tracked so dispose can cancel them; otherwise a queued
    // measurement runs against a terminal that no longer exists.
    this.#rafs.push(
      requestAnimationFrame(() => {
        this.rescale()
        // A web font landing late can change the cell size once more.
        this.#rafs.push(requestAnimationFrame(() => this.rescale()))
      }),
    )
  }

  /**
   * Scale the rendered terminal to fit its container, without changing
   * cols/rows (INV-1). Two modes: "fit" always shrinks to the container, while
   * "readable" refuses to go below MIN_EFFECTIVE_FONT and lets the pane scroll
   * sideways instead — the only usable option on a phone.
   */
  rescale(): void {
    if (this.#disposed) return
    const host = this.#host
    const scaler = this.#scaler
    if (!host || !scaler) return
    // Measure .xterm-screen, not the .terminal wrapper: the wrapper is a block
    // element that stretches to its container, so it reports the container's
    // width rather than the width of `cols` characters.
    const screen = scaler.querySelector<HTMLElement>('.xterm-screen')
    const width = screen?.offsetWidth ?? 0
    const height = screen?.offsetHeight ?? 0
    if (!width || !height) return

    // Measure the container, not the box itself — the box is resized below.
    const available = host.parentElement?.clientWidth ?? host.clientWidth
    if (!available) return
    const availableHeight = host.parentElement?.clientHeight ?? 0

    const { scale: k, overflowing } = computeScale({
      naturalWidth: width,
      available,
      naturalHeight: height,
      availableHeight,
      zoom: this.#zoom,
      maxScale: this.#maxScale,
    })

    scaler.style.transform = `scale(${k})`
    const scaledWidth = Math.round(width * k)
    host.style.width = overflowing ? '100%' : `${scaledWidth}px`
    host.style.height = `${Math.round(height * k)}px`
    host.classList.toggle('pannable', overflowing)
    this.#overflowing = overflowing
    this.#scale = k
    this.#onZoomChange?.()
  }

  /** True when the pane is wider than its container and must be panned. */
  get overflowing(): boolean {
    return this.#overflowing
  }

  /**
   * True when what is on screen is not the capture at its own size.
   *
   * Shrunk or enlarged both count. The control that offers 1:1 back was shown
   * only while the pane was too *big*, so an enlarged one had no way back to a
   * crisp capture — scaled-up canvas text is slightly soft, and which of the
   * two to live with is the reader's call, not this component's.
   */
  get scaled(): boolean {
    return Math.abs(this.#scale - 1) > SCALE_EPSILON
  }

  get zoom(): ZoomMode {
    return this.#zoom
  }

  setZoom(mode: ZoomMode): void {
    this.#zoom = mode
    this.rescale()
  }

  /** Raised in full screen, where the pane is the only thing on the display. */
  setMaxScale(max: number): void {
    if (this.#maxScale === max) return
    this.#maxScale = max
    this.rescale()
  }
}

/** Map a keydown to a tmux key name from ALLOWED_KEYS, or null for plain text. */
export function mapKey(e: KeyboardEvent): string | null {
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    const lower = e.key.toLowerCase()
    if (['c', 'd', 'o', 'r', 'u'].includes(lower)) return `C-${lower}`
  }
  switch (e.key) {
    case 'Enter':
      return 'Enter'
    case 'Escape':
      return 'Escape'
    case 'Tab':
      return 'Tab'
    case 'Backspace':
      return 'BSpace'
    case 'ArrowUp':
      return 'Up'
    case 'ArrowDown':
      return 'Down'
    case 'ArrowLeft':
      return 'Left'
    case 'ArrowRight':
      return 'Right'
    case 'Home':
      return 'Home'
    case 'End':
      return 'End'
    case 'PageUp':
      return 'PageUp'
    case 'PageDown':
      return 'PageDown'
    default:
      return null
  }
}
