import { useEffect, useState } from 'react'
import { MODEL_ALIASES, type Agent } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { allowsSlashCommands } from '../../shared/agent-kinds.ts'
import { closeAgent, setAgentMode, setAgentModel } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import type { Key } from '../lib/i18n.ts'
import { MODES, MODE_KEY } from '../lib/modes.ts'
import { Button } from './ui/Button.tsx'
import { displayName } from '../lib/naming.ts'
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
  const [pending, setPending] = useState<'mode' | 'model' | 'close' | null>(null)
  /*
   * What the user just chose, held until the agent reports it back.
   *
   * Both selects are controlled by the agent's *reported* value, and neither
   * mode nor model is observable until the session writes it into its
   * transcript. So picking one repainted the old value on the very next fleet
   * broadcast — a second or so later — and the control snapped back as though
   * the click had done nothing. That is the whole of what "switching does not
   * work" looked like from outside, whether or not the switch had landed.
   */
  const [picked, setPicked] = useState<{ mode?: string; model?: string }>({})

  const slashCommands = allowsSlashCommands(agent.agentKind)
  useEffect(() => {
    setPicked((prev) => {
      const next = { ...prev }
      if (prev.mode !== undefined && agent.permissionMode === prev.mode) delete next.mode
      if (prev.model !== undefined && aliasOfModel(agent.model) === prev.model) delete next.model
      return next
    })
  }, [agent.permissionMode, agent.model])

  // A different agent's choice is not this one's.
  useEffect(() => {
    setPicked({})
  }, [agent.sessionId])

  const busy = agent.status === 'busy'
  const disabled = busy || !agent.paneId || pending !== null
  const reason = busy ? t('controlBusy') : undefined
  /*
   * INV-8's exceptions. Mode sends a control key rather than typing at all;
   * model types, but through the same `paste` the message composer already
   * uses on working agents by design — refusing it forbade through one door
   * what the app permits through the other. Both stay available mid-run, which
   * is when you reach for them: you notice the wrong model *while* it is being
   * used. Goal and Close still wait for idle.
   */
  const midRunDisabled = !agent.paneId || pending !== null

  const run = async (kind: 'mode' | 'model', value: string): Promise<void> => {
    setPending(kind)
    setPicked((prev) => ({ ...prev, [kind]: value }))
    const result = kind === 'mode' ? await setAgentMode(value) : await setAgentModel(value)
    setPending(null)
    if (!result.ok) {
      // It did not land, so stop showing it as though it had.
      setPicked((prev) => ({ ...prev, [kind]: undefined }))
      showToast(t('controlFailed', { error: result.error }))
      return
    }
    /*
     * Sent, but not yet observable. Neither switch is visible to this app until
     * the session writes it into its transcript, which for a busy agent is when
     * the turn ends — so the toast says which of the two happened rather than
     * letting a silent, unchanged-looking select imply nothing occurred.
     */
    if (result.detail === 'queued') showToast(t('modelQueued', { model: value }))
    else if (result.detail === 'unverified') showToast(t('modeUnverified'))
  }

  const onClose = async (): Promise<void> => {
    const name = displayName(agent)
    if (!window.confirm(t('closeConfirm', { name }))) return
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
      <label className={styles.field}>
        <span className={styles.label}>{t('modeLabel')}</span>
        <select
          className={styles.select}
          data-testid="mode-select"
          disabled={midRunDisabled}
          value={picked.mode ?? agent.permissionMode ?? ''}
          onChange={(e) => void run('mode', e.target.value)}
        >
          {!agent.permissionMode && <option value="">—</option>}
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(MODE_KEY[mode] as Key)}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>{t('modelLabel')}</span>
        <select
          className={styles.select}
          data-testid="model-select"
          disabled={midRunDisabled}
          value={picked.model ?? aliasOfModel(agent.model)}
          onChange={(e) => void run('model', e.target.value)}
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

      <Button
        variant="compact"
        className={styles.close}
        data-testid="close-agent"
        disabled={disabled}
        title={reason}
        onClick={() => void onClose()}
      >
        {pending === 'close' ? t('closing') : t('closeAgent')}
      </Button>
    </div>
  )
}
