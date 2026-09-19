import { useEffect, useRef, useState } from 'react'
import type { Agent, PendingPrompt } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { answerPrompt, sendConfirmedKey, sendKey } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { Button } from './ui/Button.tsx'
import { LazyPanePeek } from './LazyTerminal.tsx'
import { shortName } from '../lib/naming.ts'
import styles from './AnswerCard.module.css'

/**
 * The keys that move a picker, for the prompts whose options are not written
 * down. `Space` toggles a multi-select row; `Escape` is destructive and keeps
 * INV-6's confirmation.
 */
const KEYS = ['Up', 'Down', 'Space', 'Enter'] as const

/**
 * The keys a multi-select needs, which are not the ones a single question does.
 *
 * Measured against Claude Code 2.1.277 by driving a real picker in a tmux pane,
 * because nothing writes this down: a digit toggles the row it numbers and the
 * picker stays open; **`Enter` toggles the *highlighted* row rather than
 * submitting**; and the dialog carries a second tab, reached with `→`, whose
 * one row is `Submit answers`.
 *
 * That last fact is why this list exists. The card used to tell the reader to
 * "press Enter when the terminal shows the set you want", which ticks another
 * box instead — so a multi-select could be ticked from the Chat tab and never
 * finished from it.
 */
const MULTI_KEYS = ['Up', 'Down', 'Space', 'Enter', 'Right'] as const

/**
 * How long one row of a multi-select ignores a second press of itself.
 *
 * The synchronous `sendingRef` catches two events in one React batch and
 * nothing slower; a double-tap on a phone is about 100ms apart, which is the
 * gap the quick-prompt guard elsewhere in this app was written for. On a
 * toggle the cost of missing it is specific: the second press unticks what the
 * first ticked, and the card cannot see that it has, because what is selected
 * lives in the terminal (INV-2 — nothing is sent that the user did not ask
 * for, and a tap they did not intend is exactly that).
 *
 * A *different* row is never blocked: choosing several is the whole point.
 */
const REPEAT_MS = 600

/** Whether this press is the same row again, too soon to be deliberate. */
function repeatOf(last: { choice: number; at: number } | null, choice: number): boolean {
  return last !== null && last.choice === choice && Date.now() - last.at < REPEAT_MS
}

/**
 * Answer the question an agent is blocked on, from the conversation.
 *
 * The alternative was the Attach tab, which is a faithful capture of somebody
 * else's terminal — fine for reading, and a poor place to answer a multiple
 * choice on a phone. What makes answering here safe is that nothing about the
 * question is guessed: `PendingPrompt` is read out of the agent's own
 * transcript, which Claude Code flushes *before* the dialog is answered.
 *
 * **INV-16.** A button is labelled from the transcript where it stated a label
 * — `AskUserQuestion` states all of them — and from what Claude Code *draws*
 * where it did not: `ExitPlanMode` states its plan but not its approval
 * choices, and a permission request states neither. A drawn list is a claim
 * about the CLI rather than a reading of the agent, so it arrives flagged
 * (`optionsDrawn`), is captioned as such, and is shown above a live capture of
 * the pane that can contradict it. A release that reorders its dialog would
 * make a label wrong; the capture is what makes that visible rather than
 * silently answered, which is the failure INV-11 exists to prevent.
 *
 * **INV-2.** A digit is an *absolute* choice: `2` picks the second option
 * wherever the highlight sits, so nothing has to assume where the cursor
 * started. And the card disables itself synchronously on the first press,
 * because a second digit would not be a duplicate — it would answer the *next*
 * question in the set.
 *
 * **A null `prompt` is a state this card handles rather than a reason not to
 * draw it.** Only two of the seven things `waitingFor` can say are backed by a
 * `tool_use` record; a trust prompt, a `/goal` proposal, a sandbox or worker
 * request, a model picker and a compaction confirmation are dialogs Claude
 * Code draws without writing anything down. The card used to be withheld
 * entirely for those, which meant the Chat tab offered no pane, no arrows, no
 * Enter and no Esc — for the most common reason an agent stops, the answer was
 * "open the terminal", on a phone.
 *
 * Nothing about the guarantee moves. An *answer* — a digit bound to a prompt
 * id — still needs the transcript and the status to agree, and the server
 * still refuses one that does not; what is offered here with no prompt is the
 * Attach tab's own two capabilities, a read-only capture and the keys already
 * on `ALLOWED_KEYS`, brought to where the reader is. The card says plainly
 * that it could not read the question rather than inventing one, which is the
 * line INV-11 draws and INV-16 was already drawing for the two thinner shapes.
 */
export function AnswerCard({ agent, prompt }: { agent: Agent; prompt: PendingPrompt | null }) {
  const t = useTranslate()
  const showToast = useStore((s) => s.showToast)
  /*
   * With the socket down `answerPrompt` sends nothing, and this card used to
   * disable itself and announce "Answer sent" anyway — then stay dead through
   * the reconnect, because `sent` only resets on a new question. The composer
   * already refuses offline and says so (INV-11); the card holds the same line.
   * This flag is the visible half; `press` below reads what the socket
   * actually did, because `conn` lags a socket that is already closing.
   */
  const online = useStore((s) => s.conn === 'open')
  /*
   * INV-2's "exactly once", and the reason it is a ref: `sent` is React state
   * and does not land until React flushes, so two presses in one batch — key
   * repeat, a double tap on a phone — would both read it as false. Answering
   * twice does not send the same answer twice; it answers the question behind
   * this one.
   */
  const sendingRef = useRef(false)
  /** The last multi-select row pressed, for the double-tap guard above. */
  const lastPressRef = useRef<{ choice: number; at: number } | null>(null)
  const [sent, setSent] = useState(false)

  // A new question is a new decision. Anything else would leave the card dead
  // after the first answer of a multi-question set.
  useEffect(() => {
    sendingRef.current = false
    lastPressRef.current = null
    setSent(false)
    // Keyed on the server's own id: it changes with any field a reader would
    // have read, which content-keying only approximated.
  }, [prompt?.id, prompt?.question, prompt?.tool, prompt?.detail])

  /*
   * A refusal releases the latch. The server declines to type when the pane is
   * not drawing that choice, the agent is not waiting, or the question has
   * moved on — and says so with a kind, because from here an untyped error is
   * indistinguishable from any other. Without this the card sat disabled
   * saying "Answer sent" about an answer that never went (INV-11). Releasing
   * is safe for the same reason it is needed: nothing reached the agent, so a
   * second press is not a second digit (INV-2).
   */
  const refused = useStore((s) => s.answerRefused)
  useEffect(() => {
    if (!refused || refused.sessionId !== agent.sessionId) return
    sendingRef.current = false
    setSent(false)
  }, [refused, agent.sessionId])

  const options = prompt?.options ?? []
  /*
   * A picker that takes several answers. The distinction runs through
   * everything below, and it is one distinction rather than two states: the
   * *labels* are the transcript's own words either way — `AskUserQuestion`
   * writes every option down before the dialog is drawn, `multiSelect`
   * included — so there was never a reason to withhold them. What differs is
   * what a press *means*.
   *
   * A single-select digit commits, so the card latches after one: a second
   * press would not repeat the answer, it would answer the *next* question in
   * the set. A multi-select digit toggles a row and commits nothing, so
   * latching after one would strand the user needing a second choice — which
   * is what this card did, by discarding the labels and saying "chosen in the
   * terminal". `Enter` below is what commits, and the live pane under it is
   * what shows which rows are ticked (INV-16).
   */
  const multi = prompt?.multiSelect === true
  const answerable = options.length > 0
  const drawn = prompt?.optionsDrawn === true
  const disabled = !agent.paneId || !online || (sent && !multi)
  /*
   * The live pane is shown wherever the buttons are not the whole story: under
   * a drawn list, so the labels can be checked against what the terminal
   * actually numbers; wherever only keys are offered, so ↑ ↓ and Enter can be
   * aimed at a highlight the user can see; and under a multi-select, where it
   * is the only thing that says which rows are ticked so far — this card sends
   * toggles and cannot know their state. A single question the transcript
   * stated in full needs no second opinion.
   */
  const peek = agent.paneId !== undefined && (drawn || multi || !answerable)

  /*
   * Sends the *choice*, not the keystroke. The server holds the prompt's id and
   * refuses an answer whose question has moved on, so a stale card cannot
   * answer whatever the pane happens to be showing — which a bare digit could,
   * and which the guard above only ever covered within this one tab.
   */
  const press = (choice: number): void => {
    if (sendingRef.current || disabled) return
    // Above the latch, not below it. Unreachable today — an option button only
    // renders when the prompt named options — but this file's whole argument
    // is that a latch left set is the failure being designed against, and a
    // guard on the wrong side of one is how that happens.
    if (prompt === null) return
    if (multi && repeatOf(lastPressRef.current, choice)) return
    sendingRef.current = true
    /*
     * The latch is spent only by a frame that was written. `send` drops one
     * silently when the socket has begun closing and `conn` has not yet
     * caught up; a card that latched anyway said "Answer sent" about nothing
     * and stayed dead for this question through the reconnect (INV-11).
     */
    if (!answerPrompt(agent.sessionId, prompt.id ?? '', choice)) {
      sendingRef.current = false
      showToast(t('answerNotSent', { name: shortName(agent) }))
      return
    }
    setSent(true)
    showToast(t(multi ? 'answerToggled' : 'answerSent', { name: shortName(agent) }))
    /*
     * A toggle does not spend the card, so the synchronous guard is released
     * for the next row — but not instantly, or the same-batch check it exists
     * to be would be gone with it. `REPEAT_MS` below is what covers the case
     * the ref cannot: a double-tap on *one* row, which is ~100ms apart and
     * would silently untick what the user just ticked.
     */
    if (multi) {
      lastPressRef.current = { choice, at: Date.now() }
      sendingRef.current = false
    }
  }

  /* A picker key moves or confirms; it does not commit an answer by itself, so
     it does not spend the one-press guard the labelled options do. */
  const nudge = (key: string): void => {
    if (!agent.paneId || !online) return
    sendKey(key)
  }

  return (
    <div className={styles.card} data-testid="answer-card">
      {/*
        * The CLI's own one-word title for this dialog, which every real
        * question carries and which the terminal puts on the dialog's tab. It
        * is the heading the two surfaces can share rather than each inventing
        * one, and on a phone it is what tells you which decision this is
        * before the question itself has been read.
        */}
      {prompt?.header !== undefined && (
        <p className={styles.header} data-testid="answer-header">
          {prompt.header}
        </p>
      )}

      {prompt?.question !== undefined && (
        <p className={styles.question} data-testid="answer-question">
          {prompt.question}
        </p>
      )}

      {prompt?.detail !== undefined && (
        <>
          <p className={styles.label}>
            {t(prompt.tool === 'ExitPlanMode' ? 'answerPlan' : 'answerAbout')}
          </p>
          <pre className={styles.detail} data-testid="answer-detail">
            {prompt.detail}
          </pre>
        </>
      )}

      {answerable && drawn && (
        <p className={styles.drawnNote} id="answer-drawn-note" data-testid="answer-drawn">
          {t('answerDrawn')}
        </p>
      )}

      {/*
        * What a press does here is not what it does anywhere else in this card,
        * so it is said before the buttons rather than discovered by pressing
        * one: each ticks a row and nothing is submitted until Enter.
        */}
      {answerable && multi && (
        <p className={styles.drawnNote} id="answer-multi-note" data-testid="answer-multi">
          {t('answerMultiSelect')}
        </p>
      )}

      {answerable ? (
        <div className={styles.options} data-testid="answer-options" data-drawn={drawn || undefined}>
          {options.map((option, index) => (
            <Button
              key={option.label}
              className={`${styles.option} ${drawn ? styles.drawnOption : ''}`}
              data-testid="answer-option"
              disabled={disabled}
              title={option.description ?? option.label}
              aria-label={t(multi ? 'answerToggle' : 'answerOption', { label: option.label })}
              aria-describedby={
                drawn ? 'answer-drawn-note' : multi ? 'answer-multi-note' : undefined
              }
              /*
               * The number is what is sent, and showing it is not decoration:
               * it is the same key the terminal is offering, so the two
               * surfaces cannot disagree about which option is which.
               */
              onClick={() => press(index)}
            >
              <span aria-hidden="true" className={styles.digit}>
                {index + 1}
              </span>
              <span className={styles.optionLabel}>{option.label}</span>
              {option.description !== undefined && (
                <span className={styles.description}>{option.description}</span>
              )}
              {/*
                * The option's worked example — a folder tree, a rendered
                * changelog, an ASCII mock of the thing being decided. Dropped
                * by this app until now, and on the questions that carry one it
                * is frequently what the choice is actually about: the
                * description alone reads as an argument with the evidence
                * taken out. Pre-formatted, because every one of them is laid
                * out in columns or lines that mean something.
                */}
              {option.preview !== undefined && (
                <pre className={styles.preview} data-testid="answer-preview">
                  {option.preview}
                </pre>
              )}
            </Button>
          ))}
        </div>
      ) : (
        /*
         * Said out loud rather than left as an absence. "No buttons here" reads
         * as a broken card; "nothing wrote these choices down" is the actual
         * state, and it tells the user why the terminal is the answer.
         */
        <p className={styles.note} data-testid="answer-no-options">
          {t(
            prompt === null
              ? 'answerUnread'
              : prompt.multiSelect === true
                ? 'answerMultiSelect'
                : 'answerNoOptions',
          )}
        </p>
      )}

      {prompt?.moreQuestions !== undefined && prompt.moreQuestions > 0 && (
        <p className={styles.note} data-testid="answer-more">
          {t('answerMore', { count: prompt.moreQuestions })}
        </p>
      )}

      {peek && (
        <figure className={styles.peek} data-testid="answer-peek">
          <figcaption className={styles.label}>{t('answerPeek')}</figcaption>
          <LazyPanePeek agent={agent} />
        </figure>
      )}

      {/*
        * Where the transcript named the options, the labelled buttons above
        * are the verified answer and these keys are the escape hatch: `Enter`
        * commits whatever the real pane has highlighted, which is not
        * necessarily the option the user just read. Drawn at equal weight the
        * two invited exactly that slip, so with labels present the keys drop
        * below a rule, shrink, and say what they are for. Without labels they
        * are the only way to answer and stay primary (INV-16).
        */}
      {answerable && (
        <p className={styles.fallback} data-testid="answer-keys-fallback">
          {t('answerKeysFallback')}
        </p>
      )}
      <div
        className={`${styles.keys} ${answerable ? styles.secondary : ''}`}
        role="group"
        aria-label={t('answerKeysLabel')}
        data-secondary={answerable ? 'true' : undefined}
      >
        {(multi ? MULTI_KEYS : KEYS).map((key) => (
          <Button
            key={key}
            variant="compact"
            data-testid={`answer-key-${key}`}
            disabled={!agent.paneId || !online}
            onClick={() => nudge(key)}
          >
            {key === 'Up' ? '↑' : key === 'Down' ? '↓' : key === 'Right' ? '→' : key}
          </Button>
        ))}
        {/* INV-6: `Escape` can destroy work in flight, so it asks first — the
            same rule the terminal's own keybar follows. */}
        <Button
          variant="compact"
          data-testid="answer-key-Escape"
          disabled={!agent.paneId || !online}
          onClick={() => {
            if (!window.confirm(t('confirmInterrupt'))) return
            sendConfirmedKey('Escape')
          }}
        >
          Esc
        </Button>
      </div>
    </div>
  )
}
