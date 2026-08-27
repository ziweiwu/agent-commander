import { useEffect, useRef, useState } from 'react'
import type { Agent } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { setAgentGoal, setAgentMode } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import type { Key } from '../lib/i18n.ts'
import { MODES, MODE_KEY } from '../lib/modes.ts'
import { Button } from './ui/Button.tsx'
import styles from './ChatControls.module.css'

/**
 * The two session-level switches that belong next to the message box: which
 * permission mode the agent is in, and what goal it is working towards.
 *
 * Both already exist elsewhere in spirit — mode is in the detail panel's
 * control row — but the panel's row is above the tabs and absent entirely in
 * full screen, which is exactly where a long conversation is read. Deciding
 * "this next instruction should run in plan mode" happens while typing that
 * instruction, not before opening the tab.
 *
 * INV-8 guards them differently, and the difference is what each one sends.
 * A goal is typed into the agent's own prompt, so it is refused while the agent
 * is busy. Mode sends `BTab`, a control key handled wherever the agent is, so
 * it stays available mid-run. The server enforces both; this mirrors them so a
 * control reads as unavailable rather than failing after the click.
 */
export function ChatControls({ agent }: { agent: Agent }) {
  const t = useTranslate()
  const showToast = useStore((s) => s.showToast)
  const [pending, setPending] = useState<'mode' | 'goal' | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  /*
   * INV-2's lesson, applied to a control rather than a message: `pending` is
   * React state and does not land until React flushes, so two Enter keydowns
   * in one batch would both read it as null and both send. The ref is cleared
   * synchronously, so the second finds it taken.
   */
  const sendingRef = useRef(false)

  const busy = agent.status === 'busy'
  const disabled = busy || !agent.paneId || pending !== null
  const reason = busy ? t('controlBusy') : undefined
  /*
   * Mode is the exception, and INV-8 now says so: it is switched by sending
   * `BTab`, a control key the agent handles wherever it is, not by typing into
   * its prompt. Deciding "this next step should run in plan mode" happens while
   * the agent is running, which is precisely when this used to be refused.
   */
  const modeDisabled = !agent.paneId || pending !== null

  const goal = agent.goal
  // A met goal is finished, not running. Only an unmet one is a live goal.
  const active = goal !== undefined && !goal.met

  // Switching agents drops any half-typed goal: it was written for the other one.
  useEffect(() => {
    setEditing(false)
    setDraft('')
  }, [agent.sessionId])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const run = async (kind: 'mode' | 'goal', action: () => Promise<void>): Promise<void> => {
    if (sendingRef.current) return
    sendingRef.current = true
    setPending(kind)
    try {
      await action()
    } finally {
      sendingRef.current = false
      setPending(null)
    }
  }

  const onMode = (mode: string): void =>
    void run('mode', async () => {
      const result = await setAgentMode(mode)
      if (!result.ok) showToast(t('controlFailed', { error: result.error }))
    })

  const onSetGoal = (): void => {
    // Checked here rather than only on the button, because Enter in the field
    // reaches this directly — so a busy agent could be sent a goal from a
    // control the interface was drawing as unavailable, and the only sign of
    // it was the server's refusal arriving as a toast (INV-8).
    if (disabled) return
    const condition = draft.trim()
    if (condition.length === 0) return
    void run('goal', async () => {
      const result = await setAgentGoal(condition)
      if (result.ok) {
        setEditing(false)
        setDraft('')
      } else {
        showToast(t('controlFailed', { error: result.error }))
      }
    })
  }

  const onClearGoal = (): void =>
    void run('goal', async () => {
      const result = await setAgentGoal('')
      if (!result.ok) showToast(t('controlFailed', { error: result.error }))
    })

  /*
   * While the goal field is open it takes the whole strip: on a 390px phone the
   * mode select pushed Set and Cancel off the end of the scroller, so the only
   * way to finish was to scroll sideways to find them. The mode select is back
   * the moment the field closes.
   */
  return (
    <div className={styles.controls} data-testid="chat-controls">
      {editing ? (
        <div className={styles.goalForm} data-testid="goal-form">
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            data-testid="goal-input"
            value={draft}
            maxLength={400}
            placeholder={t('goalPlaceholder')}
            aria-label={t('goalConditionLabel')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onSetGoal()
              } else if (e.key === 'Escape') {
                // Stops here rather than closing the whole agent panel: the
                // field is the innermost thing Escape can dismiss.
                e.stopPropagation()
                setEditing(false)
                setDraft('')
              }
            }}
          />
          <Button
            variant="compact"
            data-testid="goal-apply"
            disabled={disabled || draft.trim().length === 0}
            onClick={onSetGoal}
          >
            {pending === 'goal' ? t('goalSetting') : t('goalApply')}
          </Button>
          <Button
            variant="compact"
            data-testid="goal-cancel"
            onClick={() => {
              setEditing(false)
              setDraft('')
            }}
          >
            {t('goalCancel')}
          </Button>
        </div>
      ) : (
        <div className={styles.goal}>
          <label className={styles.field}>
            <span className={styles.label}>{t('modeLabel')}</span>
            <select
              className={styles.select}
              data-testid="chat-mode-select"
              disabled={modeDisabled}
              value={agent.permissionMode ?? ''}
              onChange={(e) => onMode(e.target.value)}
            >
              {!agent.permissionMode && <option value="">—</option>}
              {MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(MODE_KEY[mode] as Key)}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className={styles.toggle}
            data-testid="goal-toggle"
            aria-pressed={active}
            disabled={disabled}
            title={active ? t('goalActiveTitle', { condition: goal.condition }) : reason}
            /* The visible label is one word, and "Goal" pressed vs unpressed
               does not say what clicking will do. Spell out both halves. */
            aria-label={
              active ? t('goalClearAction', { condition: goal.condition }) : t('goalSetAction')
            }
            onClick={() => {
              if (active) onClearGoal()
              else setEditing(true)
            }}
          >
            <span aria-hidden="true" className={styles.dot} data-on={active} />
            <span className={styles.goalLabel}>{t('goalLabel')}</span>
            {active && <span className={styles.condition}>{goal.condition}</span>}
          </button>
          {/*
            * Spelt out rather than left to the toggle's pressed state, which a
            * sighted user cannot see at a glance and which says nothing about
            * what the goal is doing. A goal that has been evaluated and
            * rejected is the normal case, and reads as "still going".
            */}
          {active && goal.reason !== undefined && (
            <span className={styles.note} data-testid="goal-note" title={goal.reason}>
              {t('goalChecked')}
            </span>
          )}
          {goal?.met === true && (
            <span className={styles.note} data-testid="goal-met" title={goal.reason}>
              {t('goalAchieved')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
