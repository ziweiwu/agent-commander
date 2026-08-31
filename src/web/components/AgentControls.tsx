import { useRef, useState } from 'react'
import { MODEL_ALIASES, type Agent } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { useHeldChoice } from '../hooks/useHeldChoice.ts'
import { allowsSlashCommands } from '../../shared/agent-kinds.ts'
import {
  clearAgentContext,
  closeAgent,
  compactAgentContext,
  setAgentModel,
} from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { Button } from './ui/Button.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ShiftTabButton } from './ShiftTabButton.tsx'
import { displayName } from '../lib/naming.ts'
import { useTokenNavigate } from '../hooks/useTokenNavigate.ts'
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
  const setExpectSession = useStore((s) => s.setExpectSession)
  const navigate = useTokenNavigate()
  /*
   * INV-2's "exactly once". `pending` is React state and does not land until
   * React flushes, so two clicks in one batch would both read it as null. Clear
   * in particular must never go twice: the second would discard the fresh
   * session the first one just created.
   */
  const sendingRef = useRef(false)
  const [pending, setPending] = useState<'model' | 'clear' | 'compact' | 'close' | null>(null)
  // Which destructive action is waiting to be confirmed, if any. The buttons
  // only ask; the runners below are what reach the agent (INV-2).
  const [confirming, setConfirming] = useState<'clear' | 'close' | null>(null)
  // Held until the agent reports it back — see `useHeldChoice`.
  const [modelValue, setPickedModel, clearPickedModel] = useHeldChoice(
    aliasOfModel(agent.model),
    agent.sessionId,
  )

  const slashCommands = allowsSlashCommands(agent.agentKind)
  const busy = agent.status === 'busy'
  const disabled = busy || !agent.paneId || pending !== null
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
  const midRunDisabled = !agent.paneId || pending !== null

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
    setConfirming(null)
    setPending('close')
    const result = await closeAgent()
    setPending(null)
    if (!result.ok) showToast(t('controlFailed', { error: result.error }))
    else showToast(t(result.detail === 'forced' ? 'closedForced' : 'closedGracefully', { name }))
  }

  /*
   * Clear replaces the session rather than editing it, so the id the user is
   * looking at stops existing. Without following it, `focusAgent` points at
   * nothing, the route bails to the fleet, and the agent reappears further down
   * the page as a stranger — from the user's side, the panel closed itself.
   */
  const onClear = async (): Promise<void> => {
    if (sendingRef.current) return
    const name = displayName(agent)
    setConfirming(null)
    sendingRef.current = true
    setPending('clear')
    try {
      const result = await clearAgentContext()
      if (!result.ok) {
        showToast(t('controlFailed', { error: result.error }))
        return
      }
      if (result.detail === undefined || result.detail === 'unverified') {
        // The paste went out and no new session appeared inside the window.
        // Saying it worked would claim something nobody read (INV-11), and
        // navigating on that claim would land on an id that may not exist.
        showToast(t('clearUnverified', { name }))
        return
      }
      showToast(t('cleared', { name }))
      /*
       * Say so before navigating. The registry has not scanned for this id yet
       * — it appeared a moment ago — and the route's "the agent ended while it
       * was open" rule would otherwise fire on arrival and bounce straight back
       * to the fleet.
       */
      setExpectSession(result.detail)
      navigate(`/agent/${encodeURIComponent(result.detail)}`, { replace: true })
    } finally {
      sendingRef.current = false
      setPending(null)
    }
  }

  /*
   * No confirmation: compaction shortens the context rather than discarding it,
   * and Claude Code does it unprompted when the window fills. What it does need
   * is honesty about timing — it runs for minutes, so nothing here waits.
   */
  const onCompact = async (): Promise<void> => {
    if (sendingRef.current) return
    sendingRef.current = true
    setPending('compact')
    try {
      const result = await compactAgentContext()
      if (!result.ok) showToast(t('controlFailed', { error: result.error }))
      else showToast(t('compactRequested', { name: displayName(agent) }))
    } finally {
      sendingRef.current = false
      setPending(null)
    }
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
            onClick={() => void onCompact()}
          >
            {pending === 'compact' ? t('compacting') : t('compactContext')}
          </Button>

          <Button
            variant="compact"
            className={styles.close}
            data-testid="clear-agent"
            disabled={disabled}
            title={reason ?? t('clearContextTitle')}
            onClick={() => setConfirming('clear')}
          >
            {pending === 'clear' ? t('clearing') : t('clearContext')}
          </Button>
        </>
      )}

      <Button
        variant="compact"
        className={styles.close}
        data-testid="close-agent"
        disabled={disabled}
        title={reason}
        onClick={() => setConfirming('close')}
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
      <ConfirmDialog
        open={confirming === 'clear'}
        title={t('clearContext')}
        body={t('clearContextTitle')}
        loss={t('clearConfirm', { name: displayName(agent) })}
        confirmLabel={t('clearContext')}
        cancelLabel={t('clearKeep')}
        onConfirm={() => void onClear()}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming === 'close'}
        title={t('closeAgent')}
        body={t('closeConfirm', { name: displayName(agent) })}
        confirmLabel={t('closeAgent')}
        cancelLabel={t('closeKeep')}
        onConfirm={() => void onClose()}
        onCancel={() => setConfirming(null)}
      />
    </div>
  )
}
