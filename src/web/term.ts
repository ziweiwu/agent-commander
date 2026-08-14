/**
 * xterm.js view of a captured tmux pane.
 *
 * INV-1: the terminal is sized from the pane's own reported geometry and never
 * the other way round. Browser resizes only change a CSS transform, so widening
 * this window can never resize the user's real tmux pane.
 */
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Frame } from '../shared/types.ts'

const BASE_FONT = 13

/** Repaint a row: home the cursor, reset SGR, clear, then draw. */
function rowSeq(row: number, text: string): string {
  return `\u001b[${row + 1};1H\u001b[0m\u001b[2K${text}`
}

export class PaneTerm {
  readonly term: Terminal
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

      // The way back to the list. Plain Escape belongs to the agent.
      if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault()
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

  mount(host: HTMLElement, scaler: HTMLElement): void {
    this.#host = host
    this.#scaler = scaler
    this.term.open(scaler)
  }

  focus(): void {
    this.term.focus()
  }

  dispose(): void {
    this.term.dispose()
  }

  apply(frame: Frame): void {
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
    requestAnimationFrame(() => {
      this.rescale()
      // A web font landing late can change the cell size once more.
      requestAnimationFrame(() => this.rescale())
    })
  }

  /** Scale the rendered terminal to fit its container, without changing cols/rows. */
  rescale(): void {
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
    const k = Math.min(1, available / width)
    scaler.style.transform = `scale(${k})`
    // Shrink the box to the scaled content so the pane has no dead margin.
    host.style.width = `${Math.round(width * k)}px`
    host.style.height = `${Math.round(height * k)}px`
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
