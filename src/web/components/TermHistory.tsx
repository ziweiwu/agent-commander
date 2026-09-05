import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Frame } from '../../shared/types.ts'
import { PaneTerm } from '../lib/term.ts'
import { useStore, type HistoryView } from '../store/store.ts'
import { HISTORY_DEPTH, requestHistory } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { openWhenSized } from './Terminal.tsx'
import { Button } from './ui/Button.tsx'
import styles from './Terminal.module.css'

/**
 * Lines above the live capture, on request.
 *
 * Its own xterm rather than the live terminal's scrollback. The live pane is a
 * fixed grid with `scrollback: 0` and its viewport locked, and the stylesheet
 * names the crash that unlocking it causes on every full-screen toggle. So
 * this is a second `PaneTerm` handed one synthetic full frame — `n` rows,
 * the pane's own width — inside a plain DOM scroll box, which never involves
 * xterm's viewport at all. `apply()` is reused unchanged, so escapes and
 * colours render exactly as the live capture's do.
 *
 * Read-only in every sense: the handlers are no-ops, the box is `inert`, and
 * `role="img"` speaks for it. Nothing here can send (INV-2).
 */

/** Columns to draw when no live frame has said how wide the pane is. */
const FALLBACK_COLS = 80

/** A colour or cursor escape, which takes no room on screen. */
const ANSI_ESCAPE = /\u001b\[[\d;?]*[A-Za-z]/g

/** The widest a line is once its escapes are set aside. */
function visibleWidth(line: string): number {
  // eslint-disable-next-line no-control-regex
  return line.replace(ANSI_ESCAPE, '').length
}

/** Hide the cursor: history has none, and a blinking caret says "type here". */
const HIDE_CURSOR = '\u001b[?25l'

const noInput = (): void => {}

function frameOf(history: HistoryView, cols: number): Frame {
  const rows = history.lines.length
  return {
    sessionId: history.sessionId,
    cols,
    rows,
    cursorX: 0,
    cursorY: Math.max(0, rows - 1),
    lines: history.lines,
  }
}

interface HistoryHost {
  wrapRef: RefObject<HTMLDivElement | null>
  scaleRef: RefObject<HTMLDivElement | null>
}

/** How the capture is sitting in its box: how tall, and whether it must pan. */
interface HistoryFit {
  wrapHeight: number
  overflowing: boolean
}

/** Draw one frame of history, with no caret: history is not typed into. */
function draw(term: PaneTerm, frame: Frame): void {
  term.apply(frame)
  term.term.write(HIDE_CURSOR)
}

/** One terminal for as long as there are lines to show; re-drawn as pages arrive. */
/** Build the terminal into its box, and take it down again. Returns the undo. */
function openHistoryTerm(
  host: HistoryHost,
  maxFont: number,
  first: Frame,
  onFit: (fit: HistoryFit) => void,
  hold: (term: PaneTerm | null) => void,
): () => void {
  const wrap = host.wrapRef.current
  const scale = host.scaleRef.current
  if (!wrap || !scale) return () => {}
  const term = new PaneTerm(noInput, noInput, noInput)
  // Both halves of how it ended up sitting, from the one callback that fires
  // after every measurement.
  term.onZoomChange(() => onFit({ wrapHeight: wrap.offsetHeight, overflowing: term.overflowing }))
  hold(term)
  const cancel = openWhenSized(term, wrap, scale, (opened) => {
    opened.setMaxFont(maxFont)
    draw(opened, first)
    opened.scheduleRescale()
  })
  return () => {
    cancel()
    term.dispose()
    hold(null)
  }
}

function useHistoryTerm(
  history: HistoryView,
  cols: number,
  maxFont: number,
  host: HistoryHost,
): HistoryFit {
  const termRef = useRef<PaneTerm | null>(null)
  const latest = useRef<Frame>(frameOf(history, cols))
  const [fit, setFit] = useState<HistoryFit>({ wrapHeight: 0, overflowing: false })
  latest.current = frameOf(history, cols)

  useEffect(
    () =>
      openHistoryTerm(host, maxFont, latest.current, setFit, (term) => {
        termRef.current = term
      }),
    // One terminal per pane and per surface; the frame it draws is fed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history.sessionId, maxFont],
  )

  // A new page is a taller frame: `apply` resizes and repaints in full.
  useEffect(() => {
    const term = termRef.current
    if (term) draw(term, latest.current)
  }, [history.lines, cols])

  return fit
}

interface TermHistoryProps {
  history: HistoryView
  maxFont: number
}

export function TermHistory({ history, maxFont }: TermHistoryProps) {
  const t = useTranslate()
  const pending = useStore((s) => s.historyPending)
  const clearHistory = useStore((s) => s.clearHistory)
  const liveCols = useStore((s) => (s.frame?.sessionId === history.sessionId ? s.frame.cols : 0))
  const cols = liveCols || Math.max(FALLBACK_COLS, ...history.lines.map(visibleWidth))
  const wrapRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { wrapHeight, overflowing } = useHistoryTerm(history, cols, maxFont, { wrapRef, scaleRef })
  /*
   * Two ways to run out, and they are different sentences (INV-11): the pane
   * has nothing older, or this is as far back as the app reads. Saying the
   * first when the second is true would claim something about the agent's
   * terminal that nobody checked.
   */
  const atDepth = history.lines.length >= HISTORY_DEPTH
  const drained = history.lines.length >= history.total
  const exhausted = atDepth || drained

  // The first page opens at the bottom — nearest the screen — which is where
  // reading backwards starts. Later pages land above and leave the view put.
  const firstPage = useRef(true)
  useEffect(() => {
    if (!firstPage.current || wrapHeight === 0) return
    firstPage.current = false
    const box = scrollRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [wrapHeight])

  return (
    <div className={styles.history} data-testid="term-history">
      <div className={styles.historyBar}>
        <span className={styles.historyCaption} data-testid="history-caption">
          {t('historyCaption', { n: history.lines.length })}
        </span>
        <Button
          variant="compact"
          data-testid="history-more"
          disabled={pending || exhausted}
          onClick={() => requestHistory()}
        >
          {exhausted ? t(drained ? 'noEarlierOutput' : 'historyDepthReached') : t('earlier')}
        </Button>
        <Button variant="compact" data-testid="history-hide" onClick={clearHistory}>
          {t('hideHistory')}
        </Button>
      </div>
      {/*
        * The scroll box is focusable because it scrolls. Everything inside it
        * is `inert`, so without a tabindex a keyboard user would have no way
        * to reach the scroll at all — WCAG 2.1.1, which `audit:a11y` enforces
        * as `scrollable-region-focusable`. The `role="img"` and its name are
        * what a screen reader is given in place of 200 rows of terminal.
        */}
      {history.lines.length === 0 ? (
        <p className={styles.historyEmpty} data-testid="history-empty">
          {t('noEarlierOutput')}
        </p>
      ) : (
        <div
          ref={scrollRef}
          className={styles.historyScroll}
          role="img"
          aria-label={t('historyLabel')}
          tabIndex={0}
        >
          <div className={styles.historySpacer} style={{ height: wrapHeight || undefined }}>
            <div className={styles.historyBox} inert>
              <div className={styles.historyRoot}>
                {/*
                  * The same panning the live capture gets, for the same reason
                  * (FR-ATT-3): below the legibility floor the geometry is kept
                  * and the pane pans sideways. Without the class the box clips
                  * — measured on a 390px phone, 305px of every line was
                  * unreachable, with no scrollbar and nothing to drag.
                  */}
                <div
                  ref={wrapRef}
                  className={`${styles.wrap} ${overflowing ? styles.pannable : ''}`}
                  data-testid="history-wrap"
                >
                  <div ref={scaleRef} className={styles.scale} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
