import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Agent } from '../../shared/types.ts'
import { dayMark } from '../lib/format.ts'
import { formatDay, translate } from '../lib/i18n.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { shortName } from '../lib/naming.ts'
import { conversationLang } from '../lib/promptLang.ts'
import { useIsCoarse } from '../hooks/useMediaQuery.ts'
import { useStore } from '../store/store.ts'
import { interruptAndSend, sendConfirmedKey, sendMessage, setAgentMode } from '../store/transport.ts'
import { loadSendMode, saveSendMode, type SendMode } from '../lib/prefs.ts'
import { MODES, MODE_KEY } from '../lib/modes.ts'
import { ChatControls } from './ChatControls.tsx'
import { Message, WorkingIndicator } from './Message.tsx'
import { Button, Chip } from './ui/Button.tsx'
import styles from './Chat.module.css'

/** Distance from the bottom within which the view keeps following new messages. */
const PIN_SLACK = 60

/** Within this window, an identical quick prompt is a mis-tap, not a decision. */
const QUICK_REPEAT_MS = 1000

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
  const messages = useStore((s) => s.messages)
  const conn = useStore((s) => s.conn)
  const events = useStore((s) => s.events)
  const showToast = useStore((s) => s.showToast)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [pinned, setPinned] = useState(true)
  const [draft, setDraft] = useState('')
  /** The synchronous truth about the draft; `draft` is only for rendering. */
  const draftRef = useRef('')
  const lastQuickRef = useRef<{ text: string; at: number }>({ text: '', at: 0 })

  const attachable = Boolean(agent.paneId)
  const busy = agent.status === 'busy'
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
  const chooseSendMode = (next: SendMode) => {
    if (next === sendMode) return
    if (next === 'interrupt' && !window.confirm(t('confirmInterruptMode'))) return
    setSendMode(next)
    saveSendMode(agent.sessionId, next)
  }

  /** The standalone stop. Its own confirmation, because it is its own action. */
  const interrupt = () => {
    if (!attachable) return
    if (!window.confirm(t('confirmInterrupt'))) return
    sendConfirmedKey('Escape')
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
  const cycleMode = async () => {
    if (!attachable) return
    const at = MODES.indexOf((agent.permissionMode ?? MODES[0]) as (typeof MODES)[number])
    const next = MODES[(at + 1) % MODES.length] as string
    const result = await setAgentMode(next)
    showToast(result.ok ? t('modeSwitched', { mode: t(MODE_KEY[next] ?? 'modeDefault') }) : t('controlFailed', { error: result.error }))
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

  // Follow the conversation only while the user is already at the bottom.
  useLayoutEffect(() => {
    if (pinned && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, pinned])

  // Opening an agent should let you reply without another click — but not on a
  // phone, where focusing pops the keyboard over the conversation.
  useEffect(() => {
    if (!coarse) inputRef.current?.focus()
  }, [agent.sessionId, coarse])

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
    if (text.trim().length === 0 || !attachable) return
    draftRef.current = ''
    // Interrupting is only meaningful against an agent that is actually working;
    // on an idle one the two modes are the same act, so the Escape is not sent.
    if (sendMode === 'interrupt' && busy) interruptAndSend(text)
    else sendMessage(text)
    setDraft('')
    setPinned(true)
    inputRef.current?.focus()
  }

  // A quick prompt is its own message: it leaves whatever is half-typed in the
  // composer alone rather than overwriting or appending to it.
  const sendQuick = (text: string) => {
    if (!attachable) return
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
              <div className={styles.notice}>
                {t(events.length === 0 && conn !== 'open' ? 'chatLoading' : 'chatEmpty')}
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
      {attachable && (
        <div className={styles.strip} data-testid="composer-strip">
          <ChatControls agent={agent} />

          {/*
            What Send does to an agent that is already working, and the stop
            itself. Both live here rather than in the detail panel's control
            row: that row sits above the tabs and is absent in full screen,
            which is exactly where a long conversation gets read — and deciding
            "stop what you are doing and read this instead" happens while
            typing the instruction, not before opening the tab.
          */}
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

          <div className={styles.quick} role="group" aria-label={t('quickPromptsLabel')}>
            {QUICK_PROMPTS.map((key) => {
              const text = translate(promptLang, key)
              return (
                <Chip
                  key={key}
                  className={styles.quickChip}
                  data-testid="quick-prompt"
                  // Spelt out because the chip reads as something that fills the
                  // box in; it sends.
                  title={t('quickPromptSend', { text })}
                  aria-label={t('quickPromptSend', { text })}
                  onClick={() => sendQuick(text)}
                >
                  {/* The chip shape is used elsewhere in the app to mean "fill
                      a field in, safe to reconsider". This one commits, and on
                      touch there is no hover to reveal the title that says so,
                      so the glyph carries it. Hidden from the a11y tree — the
                      accessible name already spells it out. */}
                  <span aria-hidden="true" className={styles.quickGlyph}>
                    ➤
                  </span>
                  {text}
                </Chip>
              )
            })}
          </div>
        </div>
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
            placeholder={
              attachable ? t('messagePlaceholder', { name: shortName(agent) }) : t('messageDisabled')
            }
            onChange={(e) => {
              draftRef.current = e.target.value
              setDraft(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`
            }}
            onKeyDown={(e) => {
              // Slack's convention: Enter sends, Shift+Enter starts a new line.
              if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
                e.preventDefault()
                submit()
                return
              }
              // The chord Claude Code uses for this, so the habit carries over.
              if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault()
                void cycleMode()
              }
            }}
          />
          {/*
            Only while there is something to stop. It sits with Send rather
            than up in the settings strip because it is an act, not a setting —
            and rendering it only when it applies keeps it off the composer row
            on a phone in the common case, where the row is already tight.
          */}
          {busy && (
            <Button
              type="button"
              variant="compact"
              className={styles.stop}
              data-testid="chat-interrupt"
              title={t('interruptTitle')}
              onClick={interrupt}
            >
              {t('interrupt')}
            </Button>
          )}
          <Button
            type="submit"
            className={styles.send}
            data-testid="composer-send"
            disabled={!attachable || draft.trim().length === 0}
          >
            {/* The button says what it will do, which is what makes asking once
                at the toggle enough rather than asking on every send. */}
            {sendMode === 'interrupt' && busy ? t('interruptAndSend') : t('send')}
          </Button>
        </div>
        <div className={styles.hint} data-testid="composer-hint">
          <kbd>Enter</kbd> {t('hintEnterSend')} · <kbd>Shift+Enter</kbd> {t('hintShiftEnter')} ·{' '}
          <kbd>Shift+Tab</kbd> {t('hintShiftTab')}
        </div>
      </form>
    </div>
  )
}
