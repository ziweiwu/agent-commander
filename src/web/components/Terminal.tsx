import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Agent } from '../../shared/types.ts'
import { DESTRUCTIVE_KEYS } from '../../shared/types.ts'
import { PaneTerm } from '../lib/term.ts'
import { useStore } from '../store/store.ts'
import { sendConfirmedKey, sendKey, sendText, setAttached } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useIsCoarse } from '../hooks/useMediaQuery.ts'
import { Button } from './ui/Button.tsx'
import styles from './Terminal.module.css'

/**
 * The largest text the capture is enlarged to in full screen, in CSS pixels.
 *
 * A font size rather than a multiplier: the old ceilings (2.5× and 2×) were
 * picked against 80- and 150-column captures on one machine, and an 80-column
 * pane full screen on a 4K display still left most of it empty. What a reader
 * cares about is how big the text is, and that number does not need a new
 * guess per display. Enlarging re-renders xterm at this size rather than
 * stretching a 13px canvas, so it is crisp at any of them.
 */
const FULLSCREEN_MAX_FONT = 32

/**
 * The same ceiling inside the detail panel.
 *
 * Lower than full screen because the panel shares the window with the fleet
 * list, but not the base size: an 80-column capture pinned at 1:1 rendered
 * ~700px wide in a panel with half again that much room, which reads as the
 * terminal being broken rather than faithful. The height budget in
 * `computeScale` is what keeps this from pushing the key bar out of the panel.
 */
const PANEL_MAX_FONT = 26

/** How many animation frames a zero-width container gets before it is opened anyway. */
const MAX_SIZING_ATTEMPTS = 30


/**
 * Panes the server has reported as ended.
 *
 * Module-level rather than component state because entering or leaving full
 * screen unmounts this component and mounts a fresh one (`AgentDetail` renders
 * two different subtrees), and a pane that has died stays dead across that. Held
 * in React alone, the explanation would vanish on the first full-screen toggle
 * and the terminal would go back to looking live.
 */


/**
 * Whether the pane behind this terminal has ended.
 *
 * INV-1 forbids the pty that would otherwise report an exit, so the only signal
 * is one `{type:'error', message:'pane has exited'}` frame — which `transport.ts`
 * turns into a toast that clears itself after five seconds. The store therefore
 * carries the *news* and not the *fact*, and latching it here is what turns one
 * into the other. A field on the store would be the better home; this component
 * does not own that file.
 *
 * Reading the toast is sound rather than merely convenient: `watchPane` only
 * sends that frame to a viewer whose `focused` session is the pane's own, and a
 * tab is attached to one pane at a time, so a toast carrying this text always
 * refers to the pane on screen.
 */
function usePaneExited(agent: Agent): boolean {
  /*
   * Read as a fact rather than inferred from a notice.
   *
   * This used to latch on seeing the pane-exit toast, which meant matching the
   * server's English prose from a client that ships a second language — the
   * kind of coupling that breaks silently the day someone rewords a string.
   * The wire now carries `kind: 'pane-exited'` and the store remembers which
   * sessions it applied to, so the toast is free to be only how it is said.
   *
   * It is also a fact that has to outlive the notice: the toast is gone in five
   * seconds and the pane is dead for good, and this surface has to keep saying
   * so — including across the unmount that toggling full screen causes.
   */
  const exited = useStore((s) => s.exited)
  return exited.includes(agent.sessionId)
}

/** Everything the terminal for one pane is driven by. */
interface PaneTermOptions {
  agent: Agent
  onExit: () => void
  fullscreen: boolean
  exited: boolean
}

/** The DOM and xterm handles the hooks below share. */
interface PaneHost {
  wrapRef: RefObject<HTMLDivElement | null>
  scaleRef: RefObject<HTMLDivElement | null>
  termRef: RefObject<PaneTerm | null>
}

/** The two ways input leaves this surface. */
interface PaneInput {
  guarded: (key: string) => void
  typed: (text: string) => void
}

/** The same, plus the way out of a pane that has ended. */
interface PaneHandlers extends PaneInput {
  onExit: () => void
}

/** What the browser, rather than the agent, decides about the capture. */
interface PaneViewport {
  fullscreen: boolean
  coarse: boolean
}

/**
 * The guarded paths input takes out of this surface.
 *
 * Nothing reaches a pane that has ended. The key row is disabled, but xterm's
 * own key handler routes through here too, and a capture the user can still
 * click into would otherwise keep sending at nothing.
 */
function usePaneInput(options: PaneTermOptions): PaneInput {
  const t = useTranslate()
  const { exited } = options

  const guarded = (key: string): void => {
    if (exited) return
    // INV-6: keys that can destroy work require a confirmation first, and the
    // server refuses them without one — so the answer is what is sent, not a
    // flag set alongside it.
    if (DESTRUCTIVE_KEYS.has(key)) {
      const message = key === 'Escape' ? t('confirmInterrupt') : t('confirmKey', { key })
      if (!window.confirm(message)) return
      sendConfirmedKey(key)
      return
    }
    sendKey(key)
  }

  const typed = (text: string): void => {
    if (exited) return
    sendText(text)
  }

  return { guarded, typed }
}

/**
 * Open the terminal into its container as soon as that container has a width,
 * and hand back the way to call the wait off.
 *
 * xterm must not be opened into a box that has no size yet. Entering or leaving
 * full screen moves the pane into a freshly portalled subtree, and for a frame
 * that container measures zero; opening there leaves xterm's renderer without
 * dimensions, and its own viewport callback then throws `Cannot read properties
 * of undefined (reading 'dimensions')` the moment anything scrolls it.
 *
 * Opening anyway once the attempts run out is the deliberate half of that: a
 * container that never gains a width would otherwise leave the pane blank for
 * good, which is a worse answer than a mis-measured one.
 */
function openWhenSized(
  term: PaneTerm,
  wrap: HTMLDivElement,
  scale: HTMLDivElement,
  viewport: PaneViewport,
): () => void {
  let cancelled = false
  let attempts = 0
  const attempt = (): void => {
    if (cancelled || term.disposed) return
    if (wrap.clientWidth === 0 && attempts < MAX_SIZING_ATTEMPTS) {
      attempts += 1
      requestAnimationFrame(attempt)
      return
    }
    term.mount(wrap, scale)
    term.setMaxFont(viewport.fullscreen ? FULLSCREEN_MAX_FONT : PANEL_MAX_FONT)
    // Always measure after mounting. The usual trigger is the first frame
    // changing geometry, but a frame that arrives before this deferred mount
    // finds no host to measure and is silently skipped — leaving the pane
    // unscaled and clipped, with no later geometry change to recover.
    term.scheduleRescale()
    if (!viewport.coarse) term.focus()
    // Ask the server to re-attach: that resets its frame diff so this new
    // terminal gets a full repaint rather than a delta against rows it never
    // drew.
    setAttached(true)
  }
  attempt()

  return () => {
    cancelled = true
  }
}

/** Build one terminal per pane, and take it down when the pane changes. */
function usePaneLifecycle(
  options: PaneTermOptions,
  host: PaneHost,
  handlers: RefObject<PaneHandlers>,
): void {
  const { agent, fullscreen } = options
  const coarse = useIsCoarse()
  const [, forceRender] = useState(0)

  useEffect(() => {
    const wrap = host.wrapRef.current
    const scale = host.scaleRef.current
    if (!agent.paneId || !wrap || !scale) return

    const term = new PaneTerm(
      (key) => handlers.current.guarded(key),
      (text) => handlers.current.typed(text),
      () => handlers.current.onExit(),
    )
    term.onZoomChange(() => forceRender((n) => n + 1))
    host.termRef.current = term

    const cancel = openWhenSized(term, wrap, scale, { fullscreen, coarse })

    return () => {
      cancel()
      term.dispose()
      host.termRef.current = null
    }
    // A different pane, or a different container, is a different terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.sessionId, agent.paneId, fullscreen])
}

/** Feed the terminal the frames that belong to the pane it is drawing. */
function usePaneFrames(options: PaneTermOptions, termRef: RefObject<PaneTerm | null>): void {
  const frame = useStore((s) => s.frame)
  const { sessionId } = options.agent

  useEffect(() => {
    if (frame && frame.sessionId === sessionId) termRef.current?.apply(frame)
  }, [frame, sessionId, termRef])
}

/**
 * Take the caret out of a pane that has gone.
 *
 * A caret still blinking inside a pane that has gone is the frozen-frame
 * problem in miniature: it says the capture is taking input. Nothing is sent
 * either way, so this is about what the surface claims.
 */
function useBlurAfterExit(
  options: PaneTermOptions,
  wrapRef: RefObject<HTMLDivElement | null>,
): void {
  const { exited } = options

  useEffect(() => {
    if (!exited) return
    const active = document.activeElement
    if (active instanceof HTMLElement && wrapRef.current?.contains(active)) active.blur()
  }, [exited, wrapRef])
}

/**
 * The notice and caption a dead pane gains sit above the capture, inside the
 * same box, so the room the capture has just shrank — and the box itself did
 * not change size, so the observer that would otherwise notice has nothing to
 * report. Measure again by hand.
 */
function useRefitAfterExit(options: PaneTermOptions, termRef: RefObject<PaneTerm | null>): void {
  const { exited } = options
  useEffect(() => {
    if (exited) termRef.current?.scheduleRescale()
  }, [exited, termRef])
}

/**
 * The one place React meets an imperative library.
 *
 * PaneTerm owns xterm and the scaling maths; this component owns its lifetime
 * and feeds it frames. Keeping the split here is what lets `computeScale` stay
 * unit-tested without a DOM.
 */
function usePaneTerm(options: PaneTermOptions) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<PaneTerm | null>(null)
  const { guarded, typed } = usePaneInput(options)

  /*
   * The terminal is built once per pane, so anything handed to its constructor
   * is frozen at that moment — and `guarded` closes over `t`. Switching
   * language mid-session left the Ctrl-C confirmation, the one dialog here
   * that can discard an agent's work, asking in the language the tab was
   * opened in. Same for `onExit`, which is a prop and gets a new identity on
   * every render, and for the dead-pane guard in `usePaneInput`, which starts
   * false and has to be seen by a terminal built long before the pane died.
   * The ref is read at call time, so all three stay current without rebuilding
   * the terminal.
   */
  const handlers = useRef<PaneHandlers>({ guarded, typed, onExit: options.onExit })
  handlers.current = { guarded, typed, onExit: options.onExit }

  usePaneLifecycle(options, { wrapRef, scaleRef, termRef }, handlers)
  usePaneFrames(options, termRef)
  useBlurAfterExit(options, wrapRef)
  useRefitAfterExit(options, termRef)

  return { wrapRef, scaleRef, term: termRef.current, guarded }
}

export interface TerminalProps {
  agent: Agent
  onExit: () => void
}

export function Terminal({ agent, onExit }: TerminalProps) {
  const t = useTranslate()
  const fullscreen = useStore((s) => s.fullscreen)
  const exited = usePaneExited(agent)
  const { wrapRef, scaleRef, term, guarded } = usePaneTerm({ agent, onExit, fullscreen, exited })

  if (!agent.paneId) {
    return (
      <div className={styles.notice} data-testid="term-unavailable">
        {agent.attachBlockedReason ?? t('termNotAttachable')}
      </div>
    )
  }

  const pane = (
    <div
      ref={wrapRef}
      className={`${styles.wrap} ${term?.overflowing ? styles.pannable : ''}`}
      data-testid="term-wrap"
    >
      <div ref={scaleRef} className={styles.scale} data-testid="term-scale" />
    </div>
  )

  const keybar = (
    <div className={styles.keybar} data-testid="keybar">
      {/*
       * Real `disabled`, not a dimmed enabled button. Sending Enter or Ctrl-C
       * into a pane that no longer exists is meaningless, and a screen reader
       * that announces these as ordinary controls is offering an action that
       * cannot happen.
       */}
      <Button variant="compact" disabled={exited} onClick={() => guarded('Enter')}>
        Enter
      </Button>
      <Button variant="compact" disabled={exited} onClick={() => guarded('Up')}>
        ↑
      </Button>
      <Button variant="compact" disabled={exited} onClick={() => guarded('Down')}>
        ↓
      </Button>
      <Button variant="compact" disabled={exited} onClick={() => guarded('Tab')}>
        Tab
      </Button>
      <Button
        variant="compact"
        disabled={exited}
        onClick={() => guarded('Escape')}
        className={styles.danger}
      >
        Esc
      </Button>
      <Button variant="compact" disabled={exited} onClick={() => guarded('C-c')}>
        Ctrl-C
      </Button>
      <div className={styles.view}>
        {term && (term.overflowing || term.scaled || term.zoom === 'fit') && (
          <Button
            variant="compact"
            data-testid="zoom-toggle"
            onClick={() => {
              term.setZoom(term.zoom === 'fit' ? 'readable' : 'fit')
            }}
          >
            {t(term.zoom === 'fit' ? 'readable' : 'fitWidth')}
          </Button>
        )}
        {/*
         * No full-screen button here. There was one, on the reasoning that the
         * cramped view is where the control belongs — and that made three ⤢
         * buttons on one screen, with this one two rows below the tab row's.
         * The tab row's is the one that survives on a phone, and the header's
         * on a desktop; a third was a second answer to a question the reader
         * had already been given (FR-ATT-7).
         */}
      </div>
      {!exited && <span className={styles.hint}>{t('termHint')}</span>}
    </div>
  )

  /*
   * Four fixed child slots, and the pane stays in the third of them whether or
   * not the notice is showing. React reconciles static children by position, so
   * moving the pane into a wrapper — a <figure> around capture and caption, say
   * — would give it a fresh DOM node while PaneTerm still held the old one, and
   * the last frame this surface exists to preserve would go blank.
   */
  return (
    <div
      className={`${styles.host} ${exited ? styles.exited : ''}`}
      data-testid="terminal"
    >
      {exited ? (
        <div className={styles.gone} data-testid="pane-exited">
          <div role="status" className={styles.goneText}>
            <p className={styles.goneTitle}>{t('paneExited')}</p>
            <p className={styles.goneBody}>{t('agentGone')}</p>
            <p className={styles.goneBody}>{t('messageDisabled')}</p>
          </div>
          {/* A route onward, named for where it actually goes from here. */}
          <Button data-testid="pane-exited-leave" onClick={onExit}>
            {fullscreen ? t('collapse') : t('backLabel')}
          </Button>
        </div>
      ) : null}
      {exited ? (
        <p className={styles.lastFrame} data-testid="pane-exited-caption">
          {t('staleFleetNoTime')}
        </p>
      ) : null}
      {pane}
      {keybar}
    </div>
  )
}
