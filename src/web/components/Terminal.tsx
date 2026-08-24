import { useEffect, useRef, useState } from 'react'
import type { Agent } from '../../shared/types.ts'
import { DESTRUCTIVE_KEYS } from '../../shared/types.ts'
import { PaneTerm } from '../lib/term.ts'
import { useStore } from '../store/store.ts'
import { sendConfirmedKey, sendKey, sendText, setAttached } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useIsCoarse } from '../hooks/useMediaQuery.ts'
import { Button } from './ui/Button.tsx'
import styles from './Terminal.module.css'

/** How far the capture may be enlarged in full screen. */
const FULLSCREEN_MAX_SCALE = 2.5

/**
 * The one place React meets an imperative library.
 *
 * PaneTerm owns xterm and the scaling maths; this component owns its lifetime
 * and feeds it frames. Keeping the split here is what lets `computeScale` stay
 * unit-tested without a DOM.
 */
function usePaneTerm(agent: Agent, onExit: () => void, fullscreen: boolean) {
  const t = useTranslate()
  const coarse = useIsCoarse()
  const wrapRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<PaneTerm | null>(null)
  const [, forceRender] = useState(0)
  const frame = useStore((s) => s.frame)

  const guarded = (key: string): void => {
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

  /*
   * The terminal is built once per pane, so anything handed to its constructor
   * is frozen at that moment — and `guarded` closes over `t`. Switching
   * language mid-session left the Ctrl-C confirmation, the one dialog here
   * that can discard an agent's work, asking in the language the tab was
   * opened in. Same for `onExit`, which is a prop and gets a new identity on
   * every render. The ref is read at call time, so both stay current without
   * rebuilding the terminal.
   */
  const handlers = useRef({ guarded, onExit })
  handlers.current = { guarded, onExit }

  useEffect(() => {
    const wrap = wrapRef.current
    const scale = scaleRef.current
    if (!agent.paneId || !wrap || !scale) return

    const term = new PaneTerm(
      (key) => handlers.current.guarded(key),
      sendText,
      () => handlers.current.onExit(),
    )
    term.onZoomChange(() => forceRender((n) => n + 1))
    termRef.current = term

    // xterm must not be opened into a box that has no size yet. Entering or
    // leaving full screen moves the pane into a freshly portalled subtree, and
    // for a frame that container measures zero; opening there leaves xterm's
    // renderer without dimensions, and its own viewport callback then throws
    // `Cannot read properties of undefined (reading 'dimensions')` the moment
    // anything scrolls it.
    let cancelled = false
    let attempts = 0
    const openWhenSized = (): void => {
      if (cancelled || term.disposed) return
      if (wrap.clientWidth === 0 && attempts < 30) {
        attempts += 1
        requestAnimationFrame(openWhenSized)
        return
      }
      term.mount(wrap, scale)
      // Full screen is the only place the capture may be enlarged; in the panel
      // it sits beside other content and growing it would just crowd them.
      term.setMaxScale(fullscreen ? FULLSCREEN_MAX_SCALE : 1)
      // Always measure after mounting. The usual trigger is the first frame
      // changing geometry, but a frame that arrives before this deferred mount
      // finds no host to measure and is silently skipped — leaving the pane
      // unscaled and clipped, with no later geometry change to recover.
      term.scheduleRescale()
      if (!coarse) term.focus()
      // Ask the server to re-attach: that resets its frame diff so this new
      // terminal gets a full repaint rather than a delta against rows it never
      // drew.
      setAttached(true)
    }
    openWhenSized()

    return () => {
      cancelled = true
      term.dispose()
      termRef.current = null
    }
    // A different pane, or a different container, is a different terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.sessionId, agent.paneId, fullscreen])

  useEffect(() => {
    if (frame && frame.sessionId === agent.sessionId) termRef.current?.apply(frame)
  }, [frame, agent.sessionId])

  return { wrapRef, scaleRef, term: termRef.current, guarded }
}

export interface TerminalProps {
  agent: Agent
  onExit: () => void
}

export function Terminal({ agent, onExit }: TerminalProps) {
  const t = useTranslate()
  const fullscreen = useStore((s) => s.fullscreen)
  const setFullscreen = useStore((s) => s.setFullscreen)
  const { wrapRef, scaleRef, term, guarded } = usePaneTerm(agent, onExit, fullscreen)

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
      <Button variant="compact" onClick={() => guarded('Enter')}>
        Enter
      </Button>
      <Button variant="compact" onClick={() => guarded('Up')}>
        ↑
      </Button>
      <Button variant="compact" onClick={() => guarded('Down')}>
        ↓
      </Button>
      <Button variant="compact" onClick={() => guarded('Tab')}>
        Tab
      </Button>
      <Button variant="compact" onClick={() => guarded('Escape')} className={styles.danger}>
        Esc
      </Button>
      <Button variant="compact" onClick={() => guarded('C-c')}>
        Ctrl-C
      </Button>
      <div className={styles.view}>
        {term && (term.overflowing || term.zoom === 'fit') && (
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
         * Full screen, offered where the cramped view is rather than only from
         * the panel header. On a phone the terminal is the one view that cannot
         * be made to fit, so the control that fixes it should not be a bare ⤢
         * two rows above it. Hidden once full screen is on: the overlay carries
         * its own way out, and a button that does nothing reads as broken.
         */}
        {!fullscreen && (
          <Button
            variant="compact"
            data-testid="term-fullscreen"
            title={t('expand')}
            onClick={() => setFullscreen(true)}
          >
            ⤢ {t('expand')}
          </Button>
        )}
      </div>
      <span className={styles.hint}>{t('termHint')}</span>
    </div>
  )

  return (
    <div className={styles.host} data-testid="terminal">
      {pane}
      {keybar}
    </div>
  )
}
