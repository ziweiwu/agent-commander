import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Agent } from '../../shared/types.ts'
import { emptyNotice } from '../lib/chat.ts'
import { dayMark } from '../lib/format.ts'
import { formatDay, translate } from '../lib/i18n.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { shortName } from '../lib/naming.ts'
import { conversationLang } from '../lib/promptLang.ts'
import { useIsCoarse } from '../hooks/useMediaQuery.ts'
import { useStore } from '../store/store.ts'
import {
  interruptAndSend,
  sendConfirmedKey,
  sendMessage,
  sendShiftTab,
  uploadPicture,
} from '../store/transport.ts'
import { loadSendMode, saveSendMode, type SendMode } from '../lib/prefs.ts'
import { AnswerCard } from './AnswerCard.tsx'
import { ChatControls } from './ChatControls.tsx'
import { Message, WorkingIndicator } from './Message.tsx'
import { Button } from './ui/Button.tsx'
import styles from './Chat.module.css'
import { ICON_MARK, Icon } from './ui/Icon.tsx'

/** Distance from the bottom within which the view keeps following new messages. */
const PIN_SLACK = 60

/** Within this window, an identical quick prompt is a mis-tap, not a decision. */
const QUICK_REPEAT_MS = 1000

/**
 * The one place the composer says why it will not send, named so the controls
 * it disables can point at it: a caption a sighted user reads beside a greyed
 * Send button is nothing at all to someone who arrives at that button by
 * keyboard.
 */
const OFFLINE_HINT_ID = 'composer-offline-hint'
/**
 * The key hints under the composer, named so the textarea can point at them:
 * Shift+Tab in the box is the mode chord rather than a step backward, and a
 * screen-reader user has to hear that before their next Shift+Tab sends it.
 */
const KEY_HINT_ID = 'composer-key-hint'
/** Named so the disclosure beside Send can say what it opens. */
const STRIP_ID = 'composer-strip'
/** How close to the viewport's edge a floating list may come. */
const VIEWPORT_EDGE_PX = 8
/** The gap between the Replies chip and the list that opens above it. */
const REPLIES_GAP_PX = 6

/**
 * The replies that get typed over and over: unblock it, approve it, make it
 * prove the work, ask why it stopped, ask where it got to.
 *
 * Picking one sends it, exactly as pressing Send would — one deliberate action
 * either way, which is what INV-2 asks for. It is not a macro and it does not
 * queue: nothing is sent that the user did not just click.
 *
 * The chip's label is the message, so the two are always translated together —
 * never showing 继续 and quietly sending "continue".
 *
 * Which language that is comes from the conversation, not the interface. The
 * prompt is not label text: it goes to the agent and lands in its transcript,
 * so it should match what the agent is already being talked to in. Reading an
 * English UI is no reason to send an agent working in Chinese an English
 * instruction.
 */
const QUICK_PROMPTS = [
  'quickContinue',
  'quickGoAhead',
  'quickRunTests',
  'quickBlocked',
  'quickSummarise',
] as const

export function Chat({ agent }: { agent: Agent }) {
  const t = useTranslate()
  const lang = useLang()
  const coarse = useIsCoarse()
  /*
   * Everything that is not the conversation, the message box or Send lives in
   * one menu above the composer.
   *
   * It used to be a strip: a permanent row holding the send-mode choice, the
   * mode chord, the model, the goal, compact, clear and the quick replies. It
   * cost 50px of every screen at rest — 6% of a phone — and it did not even
   * fit: measured at 500px wide, its children came to 721px in a 450px
   * scroller, so most of what it exposed was already off the end of a sideways
   * scroll. A row that is both the most expensive thing on the screen and
   * unable to show its own contents is a menu that has not been written yet.
   *
   * Nothing became harder to reach. The quick replies were already a popover,
   * so they are still two presses; everything else was one press and is now
   * two, in exchange for the conversation being a row taller everywhere.
   */
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  /*
   * Where the panel goes, in viewport pixels. The composer is inside the
   * detail pane, which clips, so the panel is portalled to the body instead
   * and pinned above the button that opened it.
   */
  const [menuAt, setMenuAt] = useState<{ left: number; bottom: number } | null>(null)
  const toggleMenu = (): void => {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    const rect = menuRef.current?.getBoundingClientRect()
    if (rect) {
      setMenuAt({ left: rect.left, bottom: window.innerHeight - rect.top + REPLIES_GAP_PX })
    }
    setMenuOpen(true)
  }
  /*
   * Keep the list on screen. It is pinned to the chip's left edge, and the
   * chip sits at the right end of the strip, so at a desktop width the list
   * ran 106px past the viewport and clipped its last two replies. Measured
   * once it has rendered, and shifted left by whatever does not fit.
   */
  useLayoutEffect(() => {
    if (!menuOpen) return
    const list = menuPanelRef.current
    if (!list) return
    const { left, width } = list.getBoundingClientRect()
    const overshoot = left + width - (window.innerWidth - VIEWPORT_EDGE_PX)
    if (overshoot > 0) {
      setMenuAt((at) => (at ? { ...at, left: Math.max(VIEWPORT_EDGE_PX, at.left - overshoot) } : at))
    }
    /*
     * Focus moves into the list, as a menu's does. Without this a click left
     * focus on the chip, and the list's own Escape handler — which stops the
     * key reaching the app's "close the panel" handler — never saw the key,
     * because the list is portalled and the chip is not inside it. Escape
     * then closed the whole agent panel, menu and all.
     */
    list.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [menuOpen])

  /** Close the panel and hand focus back to the button that opened it. */
  const closeMenu = (): void => {
    setMenuOpen(false)
    menuRef.current?.querySelector<HTMLElement>('[data-testid="strip-toggle"]')?.focus()
  }
  useEffect(() => {
    if (!menuOpen) return
    const away = (press: MouseEvent): void => {
      const target = press.target as Node
      if (menuRef.current?.contains(target) || menuPanelRef.current?.contains(target)) return
      /*
       * A dialog raised from inside the menu is not "away".
       *
       * Clear asks before it acts, and its confirmation is portalled to the
       * body — so the press on "Clear it" landed outside the panel, closed the
       * menu, and unmounted the controls that owned the dialog. The dialog
       * went with them and the clear never happened: a destructive action that
       * quietly did nothing, which is worse than one that fails loudly.
       */
      if (target instanceof Element && target.closest('[role="dialog"]')) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menuOpen])
  const messages = useStore((s) => s.messages)
  const conn = useStore((s) => s.conn)
  const timelineAt = useStore((s) => s.timelineAt)
  const timelineStalledAt = useStore((s) => s.timelineStalledAt)
  const prompt = useStore((s) => s.prompt)
  /*
   * INV-16, and the two halves it is about are inside the card rather than
   * here. Offering to *answer* still needs both — the transcript holds an open
   * tool call whenever one is merely running, and the registry knows the agent
   * is stopped but not what stopped it — and the card draws labelled options
   * only when `prompt` says so, with the server refusing a digit that does not
   * agree with the pane.
   *
   * What this condition decides is narrower: whether the reader gets a
   * surface at all. Five of the seven things `waitingFor` can say are dialogs
   * Claude Code writes no `tool_use` record for, and requiring a prompt here
   * sent every one of them to the Attach tab — no pane, no arrows, no Enter,
   * no Esc in Chat, which on a phone means no answer. A pane is the floor: an
   * agent with none has nothing to show and nothing to type into.
   *
   * `starting up` is excluded because this app minted it (`pending.rs`) and
   * therefore knows it is not a dialog; drawing "could not read the question"
   * over a CLI that is still booting would be inventing a block.
   */
  const answering =
    agent.status === 'waiting' &&
    (prompt !== null || (Boolean(agent.paneId) && agent.waitingFor !== 'starting up'))
  const showToast = useStore((s) => s.showToast)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const answerRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [draft, setDraft] = useState('')
  /** The synchronous truth about the draft; `draft` is only for rendering. */
  const draftRef = useRef('')
  const lastQuickRef = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  const pictureRef = useRef<HTMLInputElement>(null)
  const [attaching, setAttaching] = useState(false)

  const attachable = Boolean(agent.paneId)
  /*
   * The same fact the Attach tab degrades on, which this surface never learned.
   *
   * The Attach tab replaces itself with a notice and disables its own box when
   * the server says a pane has exited; the composer here was gated only on
   * having a pane id and a socket, so it accepted messages for an agent whose
   * terminal had gone and drew them as sent. INV-5 wants the terminal and the
   * conversation to degrade *separately*, not for one of them to not degrade.
   *
   * Read from the store rather than through `usePaneExited`, which lives in
   * `Terminal.tsx` — that module is code-split behind `LazyTerminal`, and
   * importing a hook out of it would pull xterm into the main bundle.
   */
  const paneExited = useStore((s) => s.exited.includes(agent.sessionId))
  const busy = agent.status === 'busy'
  /*
   * INV-11, on the one screen where the user acts rather than reads.
   *
   * `transport.send()` returns without doing anything when the socket is not
   * open, and it is right to: holding the message and replaying it on reconnect
   * is INV-2's single prohibition. But the composer went on looking exactly as
   * it does when it works — a typed message was accepted, drawn as *sending…*,
   * and only twelve seconds later admitted to as *not delivered*. The fleet
   * list and the tree both caption a disconnected view; this one, where
   * somebody is about to type an instruction to a live agent, said nothing.
   *
   * So the composer refuses instead, and says so beside itself rather than only
   * in the header chip at the other end of the screen.
   */
  const online = conn === 'open'
  /** Whether a message typed here could actually arrive. */
  const sendable = online && !paneExited
  // The interface language is only the fallback, for a chat with nothing in it.
  const promptLang = useMemo(() => conversationLang(messages, lang), [messages, lang])

  /*
   * Per agent, and re-read whenever the open agent changes: this is a judgement
   * about the session in front of you, not a habit. Held in state as well as
   * storage so the toggle repaints, and keyed off `sessionId` so switching
   * agents cannot carry one agent's answer onto another.
   */
  const [sendMode, setSendMode] = useState<SendMode>(() => loadSendMode(agent.sessionId))
  useEffect(() => {
    setSendMode(loadSendMode(agent.sessionId))
  }, [agent.sessionId])

  /*
   * INV-6, paid once. `Escape` destroys work in flight, so it may not reach a
   * live agent unless a human said so — but asking on every send would put a
   * modal in front of every message in this mode, and a modal people dismiss
   * without reading guards nothing. The claim is made here, at the moment the
   * mode is armed, and the Send button then says what it will do.
   */
  /** Send itself stops the agent, so a separate stop would be the same act twice. */
  const interrupting = busy && sendMode === 'interrupt'

  const chooseSendMode = (next: SendMode) => {
    if (next === sendMode) return
    if (next === 'interrupt' && !window.confirm(t('confirmInterruptMode'))) return
    setSendMode(next)
    saveSendMode(agent.sessionId, next)
  }

  /** The standalone stop. Its own confirmation, because it is its own action. */
  const interrupt = () => {
    // Asking first and then dropping the key on the floor is worse than not
    // offering it: the user walks away believing the agent was stopped.
    if (!attachable || !online) return
    if (!window.confirm(t('confirmInterrupt'))) return
    sendConfirmedKey('Escape')
    /*
     * Said out loud because it is the one thing here that cannot be checked.
     * Every neighbouring control reads the transcript back and has its own
     * sentence for "sent, but unconfirmed" — mode, clear, compact, goal. An
     * Escape leaves no record at all, so silence here would be the interface
     * implying a verification it never made (INV-8, INV-11).
     */
    showToast(t('interruptSent'))
  }

  /*
   * Shift+Tab cycles the permission mode, the same chord Claude Code itself
   * uses for it — the point is that the muscle memory carries over.
   *
   * It works at any point in the flow, including while the agent is working —
   * that is INV-8's one exception, and the reason is that this sends `BTab`
   * rather than typing into the prompt. Deciding the next step needs plan mode
   * happens mid-run, which is exactly when this used to be refused.
   *
   * It costs reverse tab-navigation out of the composer, which is a real
   * a11y trade: `Tab` forward and `Escape` both still move focus, so this is
   * not a keyboard trap (WCAG 2.1.2), but it is a binding worth knowing about.
   */
  /*
   * Shift+Tab in the message box is the same act as the button beside it, and
   * sends the same thing: the chord, and nothing else.
   *
   * Two earlier shapes both aimed at a mode — one named it, one waited to be
   * told which one it had reached — and both reported failure at a press that
   * had worked. `send_shift_tab` in `rust/src/control.rs` carries the
   * measurement that settled it.
   */
  const shiftTab = async () => {
    if (!attachable) return
    const result = await sendShiftTab()
    showToast(result.ok ? t('shiftTabSent') : t('controlFailed', { error: result.error }))
  }

  const rows = useMemo(() => {
    const out: Array<{ key: string; day?: string; message?: (typeof messages)[number] }> = []
    let lastDay = ''
    for (const message of messages) {
      const day = formatDay(lang, dayMark(message.at))
      if (day !== lastDay) {
        lastDay = day
        out.push({ key: `day-${day}-${message.id}`, day })
      }
      out.push({ key: message.id, message })
    }
    return out
  }, [messages, lang])

  /*
   * Follow the conversation only while the user is already at the bottom.
   *
   * `busy` is in the deps because the working indicator is drawn *below* the
   * last message and is not one, so it grows the scroller without changing
   * `messages.length`. Keyed on the messages alone, an agent that started
   * working appended a row nobody scrolled to: the indicator was there, one
   * row past the fold, and the only way to see it was to switch to the
   * terminal tab and back — which remounts this component, resets `pinned` and
   * re-runs this effect. It read as the status never arriving.
   *
   * Anything else that renders after the last message has to be listed here
   * for the same reason.
   */
  useLayoutEffect(() => {
    if (pinned && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, busy, pinned])

  /*
   * Stay pinned when the box itself changes height, not only when a message
   * lands. An on-screen keyboard takes half the screen from this scroller,
   * and without this the last message — the one being replied to — went
   * under the composer on every keyboard open.
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (pinned) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [pinned])

  /*
   * Opening an agent should let you reply without another click — but not on a
   * phone, where focusing pops the keyboard over the conversation.
   *
   * A blocked agent is the exception in the other direction. Its answer
   * buttons are what you opened it for, and they sit *before* the composer in
   * the page, where Shift+Tab is the mode chord rather than a step backward —
   * so from the composer the only route to them was forward through every
   * control in the app. They take the focus instead. A question that arrives
   * later takes it too, but only from somewhere idle: the page body, an empty
   * composer, or the previous question's buttons. Mid-sentence, it stays put.
   */
  useEffect(() => {
    if (coarse) return
    /*
     * Only where the card actually offers an answer. `answering` now covers a
     * waiting agent whose dialog this app could not read, and that card's
     * first button is the pane's or the `↑` key — so opening one moved
     * keyboard focus off the composer and onto a control that types into a
     * live agent. Five of the seven `waitingFor` reasons reach that state.
     */
    const option = answering
      ? answerRef.current?.querySelector<HTMLElement>('[data-testid="answer-option"]')
      : null
    if (!option) {
      inputRef.current?.focus()
      return
    }
    const active = document.activeElement
    const idle =
      !active ||
      active === document.body ||
      (active === inputRef.current && draftRef.current === '') ||
      answerRef.current?.contains(active) === true
    if (idle) option.focus()
  }, [agent.sessionId, coarse, answering, prompt?.id])

  // The mis-tap guard is per agent. Sending the same prompt to one agent and
  // then to the next is two deliberate instructions, however fast the switch.
  useEffect(() => {
    lastQuickRef.current = { text: '', at: 0 }
  }, [agent.sessionId])

  /*
   * INV-2 says a message is sent exactly once, and React state alone cannot
   * promise that. `draft` is read from a closure, and `setDraft('')` does not
   * land until React flushes — so three Enter keydowns delivered in one batch
   * (OS key repeat, a double click on Send, or input queued behind a busy main
   * thread) each saw the same uncleared draft and each sent it. Three identical
   * messages went to a live agent.
   *
   * The ref is the authority because clearing it is synchronous: the second
   * call in the same batch finds it already empty and stops.
   */
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const text = draftRef.current
    if (text.trim().length === 0 || !attachable || paneExited) return
    /*
     * Refused *before* the draft is cleared, and never held to send later.
     * Both halves matter. Queuing it would be INV-2's one prohibition; clearing
     * the box on a send that could not go loses four typed sentences to a
     * dropped socket, which is the failure nobody forgives. The text stays
     * where it is, and sending it again stays the user's decision.
     */
    if (!online) return
    draftRef.current = ''
    // Interrupting is only meaningful against an agent that is actually working;
    // on an idle one the two modes are the same act, so the Escape is not sent.
    if (sendMode === 'interrupt' && busy) interruptAndSend(text)
    else sendMessage(text)
    setDraft('')
    setPinned(true)
    inputRef.current?.focus()
  }

  /*
   * A picture becomes a path in the box, and stops there.
   *
   * Uploading is not sending. The agent reads the file by being told where it
   * is, and what to do with it is a sentence only the user can write — "what
   * is wrong with this layout" and "transcribe this" are different
   * instructions about identical bytes. Composing one here would be this app
   * writing prose on somebody's behalf (INV-11); sending it would be input
   * nobody typed (INV-2). So the path lands in the draft, the box takes
   * focus, and Send stays the deliberate act it already is.
   *
   * It is appended rather than assigned for the same reason the quick prompts
   * leave the draft alone: whatever is half-written there is the user's.
   */
  const attachPicture = async (file: File) => {
    setAttaching(true)
    const answer = await uploadPicture(agent.sessionId, file)
    setAttaching(false)
    if (!answer.ok) {
      showToast(t('pictureFailed', { error: answer.error }))
      return
    }
    const before = draftRef.current
    const spaced = before.length === 0 || /\s$/.test(before) ? before : `${before} `
    draftRef.current = `${spaced}${answer.path} `
    setDraft(draftRef.current)
    showToast(t('picturePlaced'))
    inputRef.current?.focus()
  }

  // A quick prompt is its own message: it leaves whatever is half-typed in the
  // composer alone rather than overwriting or appending to it.
  const sendQuick = (text: string) => {
    // A chip is a send like any other, so it goes nowhere with the socket down.
    if (!attachable || !online) return
    // A chip has no draft to clear, so it needs its own guard. A double click
    // is two separate tasks a hundred-odd milliseconds apart, which no
    // same-batch check would catch — but nobody deliberately sends the same
    // one-word prompt twice inside a second, whereas a mis-tap on a phone does
    // exactly that, and the cost is a duplicate instruction to a live agent.
    const now = Date.now()
    const last = lastQuickRef.current
    if (last.text === text && now - last.at < QUICK_REPEAT_MS) return
    lastQuickRef.current = { text, at: now }
    sendMessage(text)
    setPinned(true)
    // Same reasoning as the mount effect: on a phone, focusing here would throw
    // the keyboard over the reply the user just sent.
    if (!coarse) inputRef.current?.focus()
  }

  return (
    <div className={styles.pane} data-testid="chat">
      {answering && (
        <div className={styles.answer} ref={answerRef}>
          <AnswerCard agent={agent} prompt={prompt} />
        </div>
      )}
      <div className={styles.region}>
        <div
          ref={scrollRef}
          className={styles.scroll}
          data-testid="chat-scroll"
          onScroll={(e) => {
            const el = e.currentTarget
            setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK)
          }}
        >
          <div className={styles.list} data-testid="chat-list">
            {messages.length === 0 ? (
              <div className={styles.notice} data-testid="chat-notice">
                {t(emptyNotice({ timelineAt, timelineStalledAt }))}
              </div>
            ) : (
              <>
                {rows.map((row) =>
                  row.day ? (
                    <div key={row.key} className={styles.daySep}>
                      <span>{row.day}</span>
                    </div>
                  ) : (
                    <Message key={row.key} message={row.message!} />
                  ),
                )}
                {agent.status === 'busy' && <WorkingIndicator />}
              </>
            )}
          </div>
        </div>

        {!pinned && (
          <button
            type="button"
            className={styles.jump}
            data-testid="jump-to-latest"
            onClick={() => {
              setPinned(true)
              if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
            }}
          >
            {t('jumpToLatest')}
          </button>
        )}
      </div>

      {/*
        * Outside the form: the goal field takes Enter of its own, and nesting a
        * form inside one is both invalid and a way to send a message by
        * accident.
        *
        * On the same line as the quick prompts, not above them. A row of its
        * own read fine on a desktop and cost 44px of a 568px phone — enough to
        * push the conversation itself under the audit's floor of 30% of the
        * viewport. Sharing the strip costs nothing at any width.
        */}
      {/*
        * The menu, portalled to the body and pinned above the button that
        * opened it. Outside the composer's <form> for the reason the strip
        * was: the goal field takes Enter of its own, and nesting a form
        * inside one is both invalid and a way to send a message by accident.
        */}
      {attachable &&
        menuOpen &&
        createPortal(
          <div
            id={STRIP_ID}
            ref={menuPanelRef}
            className={styles.menuPanel}
            data-testid="composer-strip"
            role="group"
            aria-label={t('moreOptions')}
            style={menuAt ?? undefined}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // The panel is the innermost thing Escape can dismiss; it must
                // not close the whole agent panel with it.
                e.stopPropagation()
                closeMenu()
              }
            }}
          >
            {/*
              The replies first: they are the most frequent thing in here, and
              on a phone the top of a panel that opens upward is the part
              nearest the thumb.
            */}
            <p className={styles.menuHeading}>{t('quickPromptsLabel')}</p>
            <div className={styles.menuGroup} role="menu" aria-label={t('quickPromptsLabel')}>
              {QUICK_PROMPTS.map((key) => {
                const text = translate(promptLang, key)
                return (
                  <button
                    key={key}
                    type="button"
                    role="menuitem"
                    className={styles.quickItem}
                    data-testid="quick-prompt"
                    // Spelt out because an item reads as something that fills
                    // the box in; it sends.
                    title={t('quickPromptSend', { text })}
                    aria-label={t('quickPromptSend', { text })}
                    disabled={!online}
                    onClick={() => {
                      setMenuOpen(false)
                      sendQuick(text)
                    }}
                  >
                    {text}
                  </button>
                )
              })}
            </div>

            {/*
              What Send does to an agent that is already working. It lives with
              the rest rather than in the detail panel's control row: that row
              sits above the tabs and is absent in full screen, which is
              exactly where a long conversation gets read — and deciding "stop
              what you are doing and read this instead" happens while typing
              the instruction, not before opening the tab.
            */}
            <p className={styles.menuHeading}>{t('sendModeLabel')}</p>
            <div className={styles.sendMode} role="group" aria-label={t('sendModeLabel')}>
              {(['queue', 'interrupt'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={styles.sendModeOption}
                  data-testid={`send-mode-${mode}`}
                  aria-pressed={sendMode === mode}
                  title={t(mode === 'queue' ? 'sendModeQueueTitle' : 'sendModeInterruptTitle')}
                  onClick={() => chooseSendMode(mode)}
                >
                  {t(mode === 'queue' ? 'sendModeQueue' : 'sendModeInterrupt')}
                </button>
              ))}
            </div>

            <p className={styles.menuHeading}>{t('menuAgentHeading')}</p>
            <ChatControls agent={agent} />
          </div>,
          document.body,
        )}

      <form className={styles.composer} onSubmit={submit}>
        <div className={styles.composerRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            data-testid="composer-input"
            name="message"
            rows={1}
            value={draft}
            disabled={!attachable}
            // The key a phone keyboard draws in the corner: Enter sends here,
            // so the key says so. Shift+Enter for a newline needs a hardware
            // keyboard; on a phone the composer grows by pasting or by the
            // agent, not by paragraphs.
            enterKeyHint="send"
            /*
             * Still typeable with the socket down. Drafting is not sending, and
             * a disabled box would throw away the half-written reply this whole
             * change exists to keep; what is refused is the send, not the
             * writing. The description says why the send is refused.
             */
            aria-describedby={sendable ? KEY_HINT_ID : OFFLINE_HINT_ID}
            placeholder={
              attachable ? t('messagePlaceholder', { name: shortName(agent) }) : t('messageDisabled')
            }
            onChange={(e) => {
              draftRef.current = e.target.value
              setDraft(e.target.value)
              /*
               * Grow to fit, and let the stylesheet decide the ceiling.
               *
               * This used to clamp to a literal 180 that also appeared as
               * `max-height` in the CSS — one number in two places, and the
               * inline style wins, so the JS copy silently decided the cap and
               * the CSS copy was decoration. The cap now depends on the visible
               * viewport, which this handler has no business recomputing, so
               * the height is set unclamped and `max-height` clips it.
               * `overflow-y: auto` is what makes the excess reachable.
               */
              e.target.style.height = 'auto'
              e.target.style.height = `${e.target.scrollHeight}px`
            }}
            onKeyDown={(e) => {
              /*
               * An IME's Enter belongs to the IME.
               *
               * Typing Chinese or Japanese goes through a composition: you type
               * pinyin or kana, the input method offers candidates, and Enter
               * commits the one you picked. That Enter arrives here as a real
               * keydown with `isComposing` set, and without this guard it sent
               * the half-composed buffer — swallowing the keypress the IME was
               * waiting for, so the message went out as raw pinyin and the
               * candidate never landed. This app already translates itself into
               * Chinese and follows the conversation's language when it offers
               * quick replies, so those are precisely its users.
               */
              if (e.nativeEvent.isComposing) return
              // Slack's convention: Enter sends, Shift+Enter starts a new line.
              if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
                e.preventDefault()
                submit()
                return
              }
              // The chord Claude Code uses for this, so the habit carries over.
              if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault()
                void shiftTab()
              }
            }}
          />
          {/*
            Only while there is something to stop. It sits with Send rather
            than up in the settings strip because it is an act, not a setting —
            and rendering it only when it applies keeps it off the composer row
            on a phone in the common case, where the row is already tight.
          */}
          {/*
            Not while Send already interrupts. With the mode armed the row read
            "Interrupt" next to "Interrupt & send" — two buttons a word apart
            with different blast radii — and the pair squeezed the message box
            to 32px on a small phone, in the one state where reading what you
            typed matters most. Wrapping them instead cost the conversation more
            height than the audit's floor allows, so the redundant one goes.
          */}
          {/*
            The one way to everything that is not typing: the replies, what
            Send does to a working agent, the mode, the model, the goal, and
            the two context actions. Beside Send because the composer row is
            the one row this layout always has, at every width and height.
          */}
          {/*
            The one thing the composer can send that cannot be typed.

            Gated on `attachable` and on nothing of its own: an agent started
            outside tmux has no pane, so the box beside this is already
            disabled, and a picture whose path could never be sent anywhere is
            a button that does nothing (TODO §14, "Watch for"). The file input
            itself is hidden rather than styled, because a browser's own file
            control cannot be made to match anything and the button is the
            part that has to look like the row it sits in.
          */}
          {attachable && (
            <>
              <input
                ref={pictureRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className={styles.hiddenFile}
                data-testid="picture-input"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // Cleared so that choosing the same picture twice is two
                  // events rather than one: a `change` fires on a new value.
                  e.target.value = ''
                  if (file) void attachPicture(file)
                }}
              />
              <Button
                type="button"
                variant="compact"
                data-testid="attach-picture"
                title={t('attachPictureTitle')}
                aria-label={t('attachPicture')}
                disabled={!sendable || attaching}
                aria-describedby={sendable ? undefined : OFFLINE_HINT_ID}
                onClick={() => pictureRef.current?.click()}
              >
                <Icon name="picture" />
              </Button>
            </>
          )}
          {attachable && (
            <div
              className={styles.menu}
              ref={menuRef}
              onKeyDown={(e) => {
                // The button's own Escape, for the moment between the click
                // and focus landing in the panel: the panel is the innermost
                // thing Escape can dismiss, and it must not take the agent
                // panel with it.
                if (e.key === 'Escape' && menuOpen) {
                  e.stopPropagation()
                  closeMenu()
                }
              }}
            >
              <Button
                type="button"
                variant="compact"
                data-testid="strip-toggle"
                aria-haspopup="true"
                aria-expanded={menuOpen}
                aria-controls={STRIP_ID}
                title={t('moreOptions')}
                aria-label={t('moreOptions')}
                onClick={toggleMenu}
              >
                <Icon name="ellipsis" />
              </Button>
            </div>
          )}
          {busy && !interrupting && (
            <Button
              type="button"
              variant="compact"
              className={styles.stop}
              data-testid="chat-interrupt"
              title={t('interruptTitle')}
              aria-label={t('interrupt')}
              disabled={!online}
              aria-describedby={online ? undefined : OFFLINE_HINT_ID}
              onClick={interrupt}
            >
              {/* The glyph carries it where the label will not fit; the label
                  is still the accessible name, so nothing is lost to a screen
                  reader. Spelling it out costs the message box 70px on a small
                  phone, and the box is what the row is for. */}
              <span className={styles.stopGlyph}>
                <Icon name="stop" size={ICON_MARK} />
              </span>
              <span className={styles.stopLabel}>{t('interrupt')}</span>
            </Button>
          )}
          <Button
            type="submit"
            className={styles.send}
            data-testid="composer-send"
            disabled={!attachable || !sendable || draft.trim().length === 0}
            aria-describedby={online ? undefined : OFFLINE_HINT_ID}
          >
            {/* The button says what it will do, which is what makes asking once
                at the toggle enough rather than asking on every send. */}
            {sendMode === 'interrupt' && busy ? t('interruptAndSend') : t('send')}
          </Button>
        </div>
        {sendable ? (
          <div
            className={`${styles.hint} ${styles.keyHint}`}
            id={KEY_HINT_ID}
            data-testid="composer-hint"
          >
            <kbd>Enter</kbd> {t('hintEnterSend')} · <kbd>Shift+Enter</kbd> {t('hintShiftEnter')} ·{' '}
            <kbd>Shift+Tab</kbd> {t('hintShiftTab')}
          </div>
        ) : (
          /*
           * In place of the key hints, not above them. With nothing connected
           * Enter does not send, so leaving that row up is the interface making
           * a claim it cannot keep — and taking the line rather than adding one
           * costs the conversation no height on a phone, which is the budget
           * the whole composer is written against.
           */
          <div
            className={styles.hint}
            id={OFFLINE_HINT_ID}
            data-testid="composer-offline"
            role="status"
          >
            {paneExited
              ? t('messageDisabled')
              : t(conn === 'closed' ? 'connReconnecting' : 'connConnecting')}
          </div>
        )}
      </form>
    </div>
  )
}
