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
 */
export function AnswerCard({ agent, prompt }: { agent: Agent; prompt: PendingPrompt }) {
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
  const [sent, setSent] = useState(false)

  // A new question is a new decision. Anything else would leave the card dead
  // after the first answer of a multi-question set.
  useEffect(() => {
    sendingRef.current = false
    setSent(false)
    // Keyed on the server's own id: it changes with any field a reader would
    // have read, which content-keying only approximated.
  }, [prompt.id, prompt.question, prompt.tool, prompt.detail])

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

  const options = prompt.options ?? []
  // One digit cannot finish a multi-select, so it must not be offered as if it
  // could. The keys below do that job instead.
  const answerable = options.length > 0 && prompt.multiSelect !== true
  const drawn = prompt.optionsDrawn === true
  const disabled = sent || !agent.paneId || !online
  /*
   * The live pane is shown wherever the buttons are not the transcript's own
   * words: under a drawn list, so the labels can be checked against what the
   * terminal actually numbers, and wherever only keys are offered, so ↑ ↓ and
   * Enter can be aimed at a highlight the user can see. A question the
   * transcript stated in full needs no second opinion.
   */
  const peek = agent.paneId !== undefined && (drawn || !answerable)

  /*
   * Sends the *choice*, not the keystroke. The server holds the prompt's id and
   * refuses an answer whose question has moved on, so a stale card cannot
   * answer whatever the pane happens to be showing — which a bare digit could,
   * and which the guard above only ever covered within this one tab.
   */
  const press = (choice: number): void => {
    if (sendingRef.current || disabled) return
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
    showToast(t('answerSent', { name: shortName(agent) }))
  }

  /* A picker key moves or confirms; it does not commit an answer by itself, so
     it does not spend the one-press guard the labelled options do. */
  const nudge = (key: string): void => {
    if (!agent.paneId || !online) return
    sendKey(key)
  }

  return (
    <div className={styles.card} data-testid="answer-card">
      {prompt.question !== undefined && (
        <p className={styles.question} data-testid="answer-question">
          {prompt.question}
        </p>
      )}

      {prompt.detail !== undefined && (
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

      {answerable ? (
        <div className={styles.options} data-testid="answer-options" data-drawn={drawn || undefined}>
          {options.map((option, index) => (
            <Button
              key={option.label}
              className={`${styles.option} ${drawn ? styles.drawnOption : ''}`}
              data-testid="answer-option"
              disabled={disabled}
              title={option.description ?? option.label}
              aria-label={t('answerOption', { label: option.label })}
              aria-describedby={drawn ? 'answer-drawn-note' : undefined}
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
          {t(prompt.multiSelect === true ? 'answerMultiSelect' : 'answerNoOptions')}
        </p>
      )}

      {prompt.moreQuestions !== undefined && prompt.moreQuestions > 0 && (
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
        {KEYS.map((key) => (
          <Button
            key={key}
            variant="compact"
            data-testid={`answer-key-${key}`}
            disabled={!agent.paneId || !online}
            onClick={() => nudge(key)}
          >
            {key === 'Up' ? '↑' : key === 'Down' ? '↓' : key}
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
