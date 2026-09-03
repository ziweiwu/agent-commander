import { useEffect, useRef, useState } from 'react'
import { MODEL_ALIASES, type Agent } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { setAgentGoal, setAgentModel } from '../store/transport.ts'
import { useHeldChoice } from '../hooks/useHeldChoice.ts'
import { aliasOfModel } from './AgentControls.tsx'
import { allowsSlashCommands } from '../../shared/agent-kinds.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useContextActions } from '../hooks/useContextActions.ts'
import { Button } from './ui/Button.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ShiftTabButton } from './ShiftTabButton.tsx'
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
 * it stays available mid-run — it lives in `ShiftTabButton`, shared with the detail
 * panel, and carries its own guard for that reason. The server enforces both;
 * this mirrors them so a control reads as unavailable rather than failing
 * after the click.
 */
export function ChatControls({ agent }: { agent: Agent }) {
  const t = useTranslate()
  const showToast = useStore((s) => s.showToast)
  const [pending, setPending] = useState<'goal' | 'model' | null>(null)
  const [editing, setEditing] = useState(false)
  // Held until the agent reports it back — see `useHeldChoice`.
  const [modelValue, setPickedModel, clearPickedModel] = useHeldChoice(
    aliasOfModel(agent.model),
    agent.sessionId,
  )
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  /*
   * INV-2's lesson, applied to a control rather than a message: `pending` is
   * React state and does not land until React flushes, so two Enter keydowns
   * in one batch would both read it as null and both send. The ref is cleared
   * synchronously, so the second finds it taken.
   */
  const sendingRef = useRef(false)
  const ctx = useContextActions(agent)
  const slashCommands = allowsSlashCommands(agent.agentKind)
  const busy = agent.status === 'busy'
  // Clear and compact join the rule the goal already follows: nothing may start
  // on top of something already in flight at this session.
  const inFlight = pending !== null || ctx.pending !== null
  const disabled = busy || !agent.paneId || inFlight
  const reason = busy ? t('controlBusy') : undefined

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

  /*
   * INV-8's exception: model types, but through the same `paste` the message
   * box already uses on working agents by design — refusing it forbade
   * through one door what the app permits through the other. So it stays
   * available mid-run, which is when you reach for it: you notice the wrong
   * model *while* it is being used. It waits only for a pane, and for nothing
   * else to be in flight at this session.
   */
  const midRunDisabled = !agent.paneId || inFlight

  const onSetModel = (value: string): void =>
    void run('model', async () => {
      setPickedModel(value)
      const result = await setAgentModel(value)
      if (!result.ok) {
        // It did not land, so stop showing it as though it had.
        clearPickedModel()
        showToast(t('controlFailed', { error: result.error }))
        return
      }
      /*
       * Sent, but not yet observable. The switch is invisible to this app
       * until the session writes it into its transcript, which for a busy
       * agent is when the turn ends — so the toast says so rather than letting
       * a silent, unchanged-looking select imply nothing occurred.
       */
      if (result.detail === 'queued') showToast(t('modelQueued', { model: value }))
    })

  const run = async (kind: 'goal' | 'model', action: () => Promise<void>): Promise<void> => {
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
          {/* Shift+Tab is Claude Code's mode chord; into another CLI it is a
              stray keystroke. The detail row used to carry this gate; now that
              the strip is the chord's only home, the gate lives here (INV-7). */}
          {slashCommands && <ShiftTabButton agent={agent} />}

          {/*
            * The model, beside the mode: both are about the next turn, and
            * both are wanted while typing it. This used to be the one control
            * left in the detail row, which folds behind `⋯` on a phone and
            * does not exist in full screen — so on the two surfaces where a
            * conversation is actually read, the model was not on screen.
            */}
          {slashCommands && (
            <label className={styles.field}>
              <span className={styles.label}>{t('modelLabel')}</span>
              <select
                className={styles.select}
                data-testid="model-select"
                aria-label={t('modelLabel')}
                disabled={midRunDisabled}
                value={modelValue}
                onChange={(e) => onSetModel(e.target.value)}
              >
                {!agent.model && <option value="">—</option>}
                {MODEL_ALIASES.map((model) => (
                  <option key={model} value={model}>
                    {model === 'default' ? t('modelDefault') : model}
                  </option>
                ))}
              </select>
            </label>
          )}

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

          {/*
            * The two actions that act on the agent's memory rather than on its
            * next turn. They exist in the detail panel's row as well, and are
            * repeated here for the reason mode and goal are: that row is above
            * the tabs, collapses behind `⋯` below 900px, and does not exist at
            * all in full screen — which is exactly where a conversation gets
            * long enough to want clearing.
            *
            * Both type a Claude Code slash command into the prompt, so INV-7
            * hides them for a CLI that does not speak them and INV-8 refuses
            * them while the agent is busy. The testids are the panel's copy's:
            * scope by `chat-controls` to reach this one, as `control.spec.ts`
            * already does for `shift-tab`.
            */}
          {slashCommands && (
            <div className={styles.context}>
              <Button
                variant="compact"
                data-testid="compact-agent"
                disabled={disabled}
                title={reason ?? t('compactContextTitle')}
                /* "Compact" beside a Goal toggle does not say compact *what*.
                   The visible label stays short for the strip; the accessible
                   name spells out the object, the same trade the goal toggle
                   makes above. */
                aria-label={t('compactContextTitle')}
                onClick={ctx.runCompact}
              >
                {ctx.pending === 'compact' ? t('compacting') : t('compactContext')}
              </Button>
              <Button
                variant="compact"
                className={styles.clear}
                data-testid="clear-agent"
                disabled={disabled}
                title={reason ?? t('clearContextTitle')}
                aria-label={t('clearContextTitle')}
                onClick={ctx.askClear}
              >
                {ctx.pending === 'clear' ? t('clearing') : t('clearContext')}
              </Button>
            </div>
          )}
        </div>
      )}
      {/*
        Outside the ternary: a dialog raised from the buttons above must not be
        torn down if something re-renders this into the goal branch.
      */}
      <ConfirmDialog {...ctx.confirm} />
    </div>
  )
}
