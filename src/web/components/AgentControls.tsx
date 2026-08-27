import { useState } from 'react'
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

  const slashCommands = allowsSlashCommands(agent.agentKind)
  const busy = agent.status === 'busy'
  const disabled = busy || !agent.paneId || pending !== null
  const reason = busy ? t('controlBusy') : undefined

  const run = async (kind: 'mode' | 'model', value: string): Promise<void> => {
    setPending(kind)
    const result = kind === 'mode' ? await setAgentMode(value) : await setAgentModel(value)
    setPending(null)
    if (!result.ok) showToast(t('controlFailed', { error: result.error }))
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
          disabled={disabled}
          title={reason}
          value={agent.permissionMode ?? ''}
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
          disabled={disabled}
          title={reason}
          value={aliasOfModel(agent.model)}
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

      <span className={styles.spacer} />

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
