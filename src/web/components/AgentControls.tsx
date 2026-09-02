import { useState } from 'react'
import { MODEL_ALIASES, type Agent } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { useHeldChoice } from '../hooks/useHeldChoice.ts'
import { allowsSlashCommands } from '../../shared/agent-kinds.ts'
import { closeAgent, setAgentModel } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { Button } from './ui/Button.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ShiftTabButton } from './ShiftTabButton.tsx'
import { displayName } from '../lib/naming.ts'
import { useContextActions } from '../hooks/useContextActions.ts'
import styles from './AgentControls.module.css'

/** The server's list, not a copy of it — see `shared/types.ts`. */
const MODELS = MODEL_ALIASES

/** `claude-opus-5` → `opus`, so the dropdown can show what is selected. */
export function aliasOfModel(model: string | undefined): string {
  if (!model) return ''
  const match = /^claude-(opus|sonnet|haiku|fable)/.exec(model)
  return match ? (match[1] as string) : model
}

/**
 * Mode, model and close.
 *
 * All three type into the agent's own prompt, so they are disabled while it is
 * busy — a keystroke landing mid-tool-call would interleave with work in
 * flight. This mirrors the server's guard rather than replacing it.
 */
export function AgentControls({ agent }: { agent: Agent }) {
  const t = useTranslate()
  const showToast = useStore((s) => s.showToast)
  /*
   * Clear and compact live in a hook because the composer strip offers them
   * too, and the clear path — navigate, in this order, never twice — is a
   * sequence rather than a widget. See `useContextActions`.
   */
  const ctx = useContextActions(agent)
  const [pending, setPending] = useState<'model' | 'close' | null>(null)
  // Close only. Clear's confirmation is the hook's, so both surfaces ask with
  // the same words.
  const [confirmingClose, setConfirmingClose] = useState(false)
  // Held until the agent reports it back — see `useHeldChoice`.
  const [modelValue, setPickedModel, clearPickedModel] = useHeldChoice(
    aliasOfModel(agent.model),
    agent.sessionId,
  )

  const slashCommands = allowsSlashCommands(agent.agentKind)
  const busy = agent.status === 'busy'
  /*
   * Clear and compact moved out of this component's `pending` but not out of
   * this rule: a model change must still not start on top of a clear.
   */
  const inFlight = pending !== null || ctx.pending !== null
  const disabled = busy || !agent.paneId || inFlight
  const reason = busy ? t('controlBusy') : undefined
  /*
   * INV-8's exceptions. Mode sends a control key rather than typing at all;
   * model types, but through the same `paste` the message composer already
   * uses on working agents by design — refusing it forbade through one door
   * what the app permits through the other. Both stay available mid-run, which
   * is when you reach for them: you notice the wrong model *while* it is being
   * used. Goal and Close still wait for idle. Mode carries its own copy of this
   * rule inside `ShiftTabButton`, which is shared with the composer strip.
   */
  const midRunDisabled = !agent.paneId || inFlight

  const setModel = async (value: string): Promise<void> => {
    setPending('model')
    setPickedModel(value)
    const result = await setAgentModel(value)
    setPending(null)
    if (!result.ok) {
      // It did not land, so stop showing it as though it had.
      clearPickedModel()
      showToast(t('controlFailed', { error: result.error }))
      return
    }
    /*
     * Sent, but not yet observable. The switch is invisible to this app until
     * the session writes it into its transcript, which for a busy agent is when
     * the turn ends — so the toast says so rather than letting a silent,
     * unchanged-looking select imply nothing occurred.
     */
    if (result.detail === 'queued') showToast(t('modelQueued', { model: value }))
  }

  const onClose = async (): Promise<void> => {
    const name = displayName(agent)
    setConfirmingClose(false)
    setPending('close')
    const result = await closeAgent()
    setPending(null)
    if (!result.ok) showToast(t('controlFailed', { error: result.error }))
    else showToast(t(result.detail === 'forced' ? 'closedForced' : 'closedGracefully', { name }))
  }

  return (
    <div className={styles.controls} data-testid="agent-controls">
      {/*
        Mode and model are Claude Code slash commands typed into the prompt, so
        for another CLI they are not a disabled feature but a wrong one — the
        server refuses them (INV-7) and offering them here would only promise
        something that comes back as an error. Close survives: for those agents
        it closes the tmux session instead.
      */}
      {slashCommands && (
        <>
      <div className={styles.field}>
        <span className={styles.label}>{t('modeLabel')}</span>
        <ShiftTabButton agent={agent} size="compact" />
      </div>

      <label className={styles.field}>
        <span className={styles.label}>{t('modelLabel')}</span>
        <select
          className={styles.select}
          data-testid="model-select"
          disabled={midRunDisabled}
          value={modelValue}
          onChange={(e) => void setModel(e.target.value)}
        >
          {!agent.model && <option value="">—</option>}
          {MODELS.map((model) => (
            <option key={model} value={model}>
              {model === 'default' ? t('modelDefault') : model}
            </option>
          ))}
        </select>
      </label>
        </>
      )}

      {slashCommands && <span className={styles.spacer} />}

      {/*
        Both type into the prompt and submit, so both wait for idle — the same
        rule that governs Close and Goal, and for the same reason.
      */}
      {slashCommands && (
        <>
          <Button
            variant="compact"
            data-testid="compact-agent"
            disabled={disabled}
            title={reason ?? t('compactContextTitle')}
            onClick={ctx.runCompact}
          >
            {ctx.pending === 'compact' ? t('compacting') : t('compactContext')}
          </Button>

          <Button
            variant="compact"
            className={styles.close}
            data-testid="clear-agent"
            disabled={disabled}
            title={reason ?? t('clearContextTitle')}
            onClick={ctx.askClear}
          >
            {ctx.pending === 'clear' ? t('clearing') : t('clearContext')}
          </Button>
        </>
      )}

      <Button
        variant="compact"
        className={styles.close}
        data-testid="close-agent"
        disabled={disabled}
        title={reason}
        onClick={() => setConfirmingClose(true)}
      >
        {pending === 'close' ? t('closing') : t('closeAgent')}
      </Button>

      {/*
        The copy is the dictionary's, not this component's. `clearConfirm` is
        the one string that names the half nothing can get back — "There is no
        undo" — so it is what goes in the loss block. Close has no such string
        and needs none: it ends a session, and the transcript it wrote stays on
        disk to be read afterwards.
      */}
      <ConfirmDialog {...ctx.confirm} />
      <ConfirmDialog
        open={confirmingClose}
        title={t('closeAgent')}
        body={t('closeConfirm', { name: displayName(agent) })}
        confirmLabel={t('closeAgent')}
        cancelLabel={t('closeKeep')}
        onConfirm={() => void onClose()}
        onCancel={() => setConfirmingClose(false)}
      />
    </div>
  )
}
