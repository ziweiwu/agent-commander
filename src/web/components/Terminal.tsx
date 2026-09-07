import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Agent, Frame } from '../../shared/types.ts'
import { DESTRUCTIVE_KEYS } from '../../shared/types.ts'
import { PaneTerm } from '../lib/term.ts'
import { useStore } from '../store/store.ts'
import {
  requestHistory,
  sendConfirmedKey,
  sendKey,
  sendShiftTab,
  sendText,
  setAttached,
} from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useIsCoarse } from '../hooks/useMediaQuery.ts'
import { Button } from './ui/Button.tsx'
import { ShiftTabButton } from './ShiftTabButton.tsx'
import { allowsSlashCommands } from '../../shared/agent-kinds.ts'
import { TermHistory } from './TermHistory.tsx'
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
 * How tall the paste line may grow, in CSS pixels.
 *
 * It grows so that a pasted snippet can be *read back* — seeing what landed
 * before running it is the reason this sends text rather than submitting it —
 * and it stops here so that a hundred pasted lines cannot push the pane
 * itself off a phone. Past this it scrolls. Matches `max-height` in the
 * stylesheet, which is what bounds it once the inline height is set.
 */
const COMPOSE_MAX_HEIGHT = 120

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
export function usePaneExited(agent: Agent): boolean {
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
  /** Whether the earlier-output panel is taking room above the capture. */
  historyOpen: boolean
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

/** The same, plus the way out of a pane that has ended, and the mode chord. */
interface PaneHandlers extends PaneInput {
  onExit: () => void
  onModeChord: () => void
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
 *
 * `onOpen` is what the surface does with a terminal that is now in the DOM —
 * the Attach tab focuses it and asks for a repaint, the Chat tab's peek only
 * attaches. Shared because the wait is the part that was got wrong once.
 */
export function openWhenSized(
  term: PaneTerm,
  wrap: HTMLDivElement,
  scale: HTMLDivElement,
  onOpen: (opened: PaneTerm) => void,
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
    onOpen(term)
  }
  attempt()

  return () => {
    cancelled = true
  }
}

/** What the Attach tab does with a terminal the moment it is in the DOM. */
function openTerminal(term: PaneTerm, viewport: PaneViewport): void {
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
      () => handlers.current.onModeChord(),
    )
    term.onZoomChange(() => forceRender((n) => n + 1))
    host.termRef.current = term

    const cancel = openWhenSized(term, wrap, scale, (opened) =>
      openTerminal(opened, { fullscreen, coarse }),
    )

    return () => {
      cancel()
      term.dispose()
      host.termRef.current = null
    }
    // A different pane, or a different container, is a different terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.sessionId, agent.paneId, fullscreen])
}

/**
 * Feed the terminal the frames that belong to the pane it is drawing, and hand
 * back the one it is showing — null while none has arrived for this pane.
 */
export function usePaneFrames(
  sessionId: string,
  termRef: RefObject<PaneTerm | null>,
): Frame | null {
  const frame = useStore((s) => s.frame)
  const own = frame && frame.sessionId === sessionId ? frame : null

  useEffect(() => {
    if (own) termRef.current?.apply(own)
  }, [own, termRef])

  return own
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
 * Measure again when something above the capture changes the room it has.
 *
 * A dead pane's notice and the earlier-output panel both sit above the capture
 * *inside the same box*, so the room it has just changed while the box itself
 * did not — and the container observer, which watches the box, has nothing to
 * report. Nothing else would ask for a measurement.
 *
 * Both directions, unlike the dead pane, which only ever happens once: closing
 * the panel hands the room back and the capture should take it.
 *
 * What this cannot do is make room that is not there. A capture already at the
 * legibility floor (FR-ATT-3) does not shrink further whatever the room, and
 * the panel scrolls instead — which is what a 40-row pane in an 844px window
 * does here, with or without the history open.
 */
function useRefitWhenTheRoomChanges(
  options: PaneTermOptions,
  termRef: RefObject<PaneTerm | null>,
): void {
  const { exited, historyOpen } = options
  useEffect(() => {
    termRef.current?.scheduleRescale()
  }, [exited, historyOpen, termRef])
}

/**
 * Send the mode chord, exactly once per press.
 *
 * The same action the key bar's button runs, so a hardware Shift+Tab and a tap
 * do the same thing — and the same INV-2 guard, because key repeat on a held
 * chord is precisely the burst the ref exists for. A CLI that does not speak
 * Claude Code's slash commands gets nothing (INV-7).
 */
function useModeChord(agent: Agent): () => void {
  const sending = useRef(false)
  return (): void => {
    if (sending.current || !agent.paneId || !allowsSlashCommands(agent.agentKind)) return
    sending.current = true
    void (async () => {
      try {
        await sendShiftTab()
      } finally {
        sending.current = false
      }
    })()
  }
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
  const modeChord = useModeChord(options.agent)
  const handlers = useRef<PaneHandlers>({
    guarded,
    typed,
    onExit: options.onExit,
    onModeChord: modeChord,
  })
  handlers.current = { guarded, typed, onExit: options.onExit, onModeChord: modeChord }

  usePaneLifecycle(options, { wrapRef, scaleRef, termRef }, handlers)
  usePaneFrames(options.agent.sessionId, termRef)
  useBlurAfterExit(options, wrapRef)
  useRefitWhenTheRoomChanges(options, termRef)

  return { wrapRef, scaleRef, term: termRef.current, guarded, typed }
}

export interface TerminalProps {
  agent: Agent
  onExit: () => void
}

export function Terminal({ agent, onExit }: TerminalProps) {
  const t = useTranslate()
  const fullscreen = useStore((s) => s.fullscreen)
  const exited = usePaneExited(agent)
  const history = useStore((s) => (s.history?.sessionId === agent.sessionId ? s.history : null))
  const historyPending = useStore((s) => s.historyPending)
  const [draft, setDraft] = useState('')
  /*
   * INV-2's "exactly once", which React state cannot hold on its own: `draft`
   * is read from a closure and `setDraft('')` does not land until React
   * flushes, so a double-tapped Send — or a key repeat on a return key — reads
   * the same uncleared draft twice and sends the text twice into a live agent.
   * The ref is the authority and is cleared synchronously, which is the same
   * shape the message composer uses for the same reason.
   */
  const draftRef = useRef('')
  /* Held only to put the box back to one line once its text has gone. */
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const { wrapRef, scaleRef, term, guarded, typed } = usePaneTerm({
    agent,
    onExit,
    fullscreen,
    exited,
    historyOpen: history !== null,
  })

  const submitDraft = (): void => {
    const text = draftRef.current
    if (text.length === 0) return
    draftRef.current = ''
    setDraft('')
    // The inline height `onChange` wrote outlives the text it was measured
    // for, so an emptied box would keep the depth of the paste it just sent.
    if (boxRef.current) boxRef.current.style.height = ''
    typed(text)
  }

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
      {/*
        * The mode chord, on the surface that is the terminal.
        *
        * Shift+Tab is how Claude Code's own keyboard cycles the permission
        * mode, and deciding "this next step should run in plan mode" happens
        * while watching the agent work — which is this tab. It was reachable
        * only from the Chat tab's composer, and a phone has no hardware
        * keyboard to send the chord with either, so from here the mode could
        * not be changed at all.
        *
        * It sends through the same control action the composer's button uses
        * rather than as a key: `BTab` is not on `ALLOWED_KEYS`, deliberately,
        * because the server composes this one (INV-8).
        */}
      {allowsSlashCommands(agent.agentKind) && <ShiftTabButton agent={agent} size="compact" />}
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
         * The pane's scrollback, on request. Not disabled for a pane that has
         * exited: its last output is exactly what a reader then wants, and
         * tmux keeps it (INV-4: one read per press, never polled).
         *
         * It opens and does not close (FR-CTL-12). Relabelling it to "Hide
         * earlier output" put a second button with those exact words, and that
         * exact action, two inches from the panel's own — the "two Clear
         * buttons for one action" shape the rule was written for. The panel
         * owns hiding the panel.
         */}
        {history === null && (
          <Button
            variant="compact"
            data-testid="history-toggle"
            disabled={historyPending}
            onClick={() => requestHistory()}
          >
            {t('earlierOutput')}
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
   * A line to paste into, because the capture is not one.
   *
   * xterm reads typing and pastes through a hidden 1px textarea behind the
   * pane, which is fine for a hardware keyboard and useless without one: a
   * phone has no Cmd+V, and there is nothing on this surface it can long-press
   * to get its own Paste menu. Measured on WebKit — the engine behind every
   * browser on iOS — `navigator.clipboard.readText()` is refused outright
   * (`NotAllowedError`) even from inside a tap, so reading the clipboard for
   * the user is not an option either; a button doing that reported a failure
   * on the one platform it existed for.
   *
   * A real field has none of those problems, because the paste is the
   * operating system's rather than ours: long-press and Paste on iOS, the same
   * on Android, Cmd+V or Ctrl+V on a desktop. It needs no permission, no
   * secure context and no clipboard API, and it works the same in all three of
   * INV-17's shapes because nothing about it is conditional on the viewport.
   *
   * It sends through `typed`, the same door xterm's own paste event uses, so
   * the text is ordered and coalesced with anything else on its way to the
   * pane (INV-2) — and it stops there. Submitting is the Enter key beside it,
   * deliberately: a paste puts text at a prompt, and what the reader gets from
   * this arrangement is the chance to see what actually landed before running
   * it, which on a phone typing into a live agent is the whole point.
   */
  const composer = (
    <form
      className={styles.compose}
      data-testid="term-compose"
      onSubmit={(e) => {
        e.preventDefault()
        submitDraft()
      }}
    >
      {/*
       * A textarea rather than an input, and the reason is the payload this
       * exists for. `<input>` runs the value sanitisation algorithm, which
       * strips CR and LF — so pasting the three lines of a shell snippet into
       * one silently delivered them run together as a single command. A
       * terminal is precisely the place multi-line text gets pasted, and text
       * quietly altered on its way to a live agent is the worst shape this
       * could fail in.
       *
       * Enter still sends, because a paste carries its newlines through the
       * clipboard rather than through keystrokes, so the two do not compete:
       * Shift+Enter is the way to type a newline by hand, which is the same
       * convention the message composer uses.
       */}
      <textarea
        className={styles.composeInput}
        data-testid="term-compose-input"
        rows={1}
        value={draft}
        disabled={exited}
        ref={boxRef}
        onChange={(e) => {
          draftRef.current = e.target.value
          setDraft(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = `${Math.min(e.target.scrollHeight, COMPOSE_MAX_HEIGHT)}px`
        }}
        onKeyDown={(e) => {
          /*
           * An IME's Enter commits its candidate; taken as a send it would
           * swallow that keypress and deliver raw pinyin instead. This app
           * ships a Chinese translation, so those are its users.
           */
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
            e.preventDefault()
            submitDraft()
          }
        }}
        aria-label={t('termComposeLabel')}
        placeholder={t('termComposePlaceholder')}
        /*
         * The four a phone would otherwise apply to a command: a capitalised
         * first letter, a "corrected" flag, a completion, a spelling mark.
         * `enterkeyhint` names the key the keyboard draws, which sends the
         * text to the prompt and does not run it.
         */
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
      />
      <Button
        variant="compact"
        type="submit"
        data-testid="term-compose-send"
        disabled={exited || draft.length === 0}
      >
        {t('termComposeSend')}
      </Button>
    </form>
  )

  /*
   * Six fixed child slots, and the pane stays in the fourth of them whether or
   * not the notice or the history is showing. React reconciles static children by position, so
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
      {history ? (
        <TermHistory history={history} maxFont={fullscreen ? FULLSCREEN_MAX_FONT : PANEL_MAX_FONT} />
      ) : null}
      {pane}
      {keybar}
      {composer}
    </div>
  )
}
