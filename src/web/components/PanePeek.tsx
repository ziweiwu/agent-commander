import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Agent } from '../../shared/types.ts'
import { PaneTerm } from '../lib/term.ts'
import { useStore } from '../store/store.ts'
import { setAttached } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { openWhenSized, usePaneExited, usePaneFrames } from './Terminal.tsx'
import styles from './Terminal.module.css'

/** How much of the pane's bottom the peek shows: enough for a dialog and its options. */
export const PEEK_ROWS = 12


/**
 * This surface takes no input, and these are the whole of that promise as far
 * as xterm is concerned: it can tell them nothing happened. The DOM below is
 * `inert` and swallows no pointer, so they are never reached in any case.
 */
const noInput = (): void => {}

/**
 * Whether this peek should be the one watching the pane.
 *
 * Two conditions, and both are about ordering rather than preference. The
 * server ignores an attach for a session that is not focused, and focusing is
 * the route's job — so wait for `selected`. And React runs a child's effects
 * before its parent's, so on the way from the Attach tab to Chat this mounts
 * *before* the route's own effect detaches the terminal it is replacing; an
 * attach sent then would be undone a moment later. Waiting for `tab` to read
 * 'chat' puts this after that effect instead of before it.
 */
function usePeekWanted(sessionId: string): boolean {
  const selected = useStore((s) => s.selected)
  const tab = useStore((s) => s.tab)
  return selected === sessionId && tab === 'chat'
}

/** Build one terminal for the pane while it is wanted; attach with it, detach with it. */
interface PeekTerm {
  agent: Agent
  /** Whether this surface is on screen and should be drawing the pane. */
  wanted: boolean
  wrapRef: RefObject<HTMLDivElement | null>
  scaleRef: RefObject<HTMLDivElement | null>
}

function usePeekTerm(
  peek: PeekTerm,
): { termRef: RefObject<PaneTerm | null>; wrapHeight: number } {
  const { agent, wanted } = peek
  const host = peek
  const termRef = useRef<PaneTerm | null>(null)
  const [wrapHeight, setWrapHeight] = useState(0)

  useEffect(() => {
    const wrap = host.wrapRef.current
    const scale = host.scaleRef.current
    if (!wanted || !wrap || !scale) return

    const term = new PaneTerm(noInput, noInput, noInput)
    // Fired after every rescale, which is when the capture's height is known.
    term.onZoomChange(() => setWrapHeight(wrap.offsetHeight))
    termRef.current = term
    let attachedHere = false

    const cancel = openWhenSized(term, wrap, scale, (opened) => {
      // A picture of the pane at whatever width the card has. The ceiling is
      // 1, so the capture only ever shrinks — never a canvas to stretch — and
      // "fit" never pans: the point is to see which option the dialog has
      // highlighted, not to read the whole line.
      opened.setZoom('fit')
      opened.scheduleRescale()
      // Attached only once there is a terminal to draw into, so the server is
      // never reading a pane for a watcher that cannot yet show it (INV-4).
      setAttached(true)
      attachedHere = true
    })

    return () => {
      cancel()
      term.dispose()
      termRef.current = null
      // Only what this peek attached is detached here. `setAttached(false)`
      // is itself a no-op when nothing is attached, so a route change that
      // already dropped the attachment costs no second message.
      if (attachedHere) setAttached(false)
    }
    // A different pane is a different terminal; so is being wanted again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.sessionId, agent.paneId, wanted])

  return { termRef, wrapHeight }
}

/**
 * The visible height: the bottom `rows` of a capture `paneRows` tall and
 * `wrapHeight` high. Nothing until a frame has said how tall the pane is —
 * before that, xterm is drawing its own default geometry and a black box
 * shaped like it would be a claim about a pane nobody has read.
 */
function clipHeight(wrapHeight: number, rows: number, paneRows: number): number {
  if (paneRows <= 0) return 0
  return Math.round(wrapHeight * Math.min(1, rows / paneRows))
}

/**
 * A read-only look at the bottom of an agent's tmux pane, for the Chat tab.
 *
 * The answer card names the options a blocked agent's transcript wrote down
 * (INV-16), but which one the terminal dialog has *highlighted* is drawn by
 * the CLI and written nowhere. This shows that — the `❯ 1. Yes` line — without
 * a trip to the Attach tab.
 *
 * It is a picture and never a terminal. `PaneTerm` is given handlers that do
 * nothing, is never focused, and sits under an `inert` element that takes no
 * pointer, so a tap on a phone cannot type into a live agent (INV-2). The one
 * message it ever sends is `attach`, and the browser's width only ever sets a
 * CSS transform; cols and rows never travel to tmux (INV-1). A pane that has
 * ended is said to have ended rather than left as a frozen frame (INV-11).
 */
export function PanePeek({ agent, rows = PEEK_ROWS }: { agent: Agent; rows?: number }) {
  const t = useTranslate()
  const exited = usePaneExited(agent)
  const wanted = usePeekWanted(agent.sessionId) && !exited && Boolean(agent.paneId)
  const wrapRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef<HTMLDivElement>(null)
  const { termRef, wrapHeight } = usePeekTerm({ agent, wanted, wrapRef, scaleRef })
  const frame = usePaneFrames(agent.sessionId, termRef)

  // The card already explains an agent that cannot be attached to.
  if (!agent.paneId) return null

  if (exited) {
    return (
      <p className={styles.peekGone} role="status" data-testid="pane-peek-exited">
        {t('paneExited')}
      </p>
    )
  }

  /*
   * Three boxes, each with a job `PaneTerm.rescale` relies on. The outer one
   * clips to the bottom `rows`. The anchor is the box `heightBudget` measures,
   * and it is zero high on purpose: a box with a height would have the pane
   * shrunk to fit it, where what is wanted is the pane at the card's width
   * with its top cut off. The root is what `rescale` reads its width from,
   * and is pinned to the bottom so the cut is at the top.
   */
  return (
    <div
      className={styles.peek}
      data-testid="pane-peek"
      role="img"
      // Its own string: the Attach tab's hint says "tap to type", which is the
      // one claim a read-only picture of the terminal must not make.
      aria-label={t('peekLabel')}
      style={{ height: clipHeight(wrapHeight, rows, frame?.rows ?? 0) }}
    >
      <div className={styles.peekAnchor} inert>
        <div className={styles.peekRoot}>
          <div ref={wrapRef} className={styles.wrap}>
            <div ref={scaleRef} className={styles.scale} />
          </div>
        </div>
      </div>
    </div>
  )
}
