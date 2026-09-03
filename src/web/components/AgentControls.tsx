import { useState } from 'react'
import type { Agent } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { closeAgent } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { Button } from './ui/Button.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { displayName } from '../lib/naming.ts'
import styles from './AgentControls.module.css'

/** `claude-opus-5` → `opus`, so a dropdown can show what is selected. */
export function aliasOfModel(model: string | undefined): string {
  if (!model) return ''
  const match = /^claude-(opus|sonnet|haiku|fable)/.exec(model)
  return match ? (match[1] as string) : model
}

/**
 * Close: the one control about the *session* rather than the conversation.
 *
 * Mode, Model, Goal, Clear and Compact all used to be here, and most of them
 * again in the composer strip, on the reasoning that this row collapses below
 * 900px and does not exist in full screen while the strip is always present.
 * That reasoning was right about which surface survives and wrong about the
 * conclusion: it argues for the strip being the one home, not for two homes —
 * and the one control that stayed here alone, the model, was then absent from
 * the two surfaces where a conversation is actually read. So everything about
 * the next turn lives in the strip (FR-CTL-12), and this row keeps what ends
 * the session.
 *
 * Close types `/exit` into the agent's own prompt, so it waits for idle — a
 * keystroke landing mid-tool-call would interleave with work in flight. This
 * mirrors the server's guard rather than replacing it.
 */
export function AgentControls({ agent }: { agent: Agent }) {
  const t = useTranslate()
  const showToast = useStore((s) => s.showToast)
  const [pending, setPending] = useState<'close' | null>(null)
  const [confirmingClose, setConfirmingClose] = useState(false)

  const busy = agent.status === 'busy'
  const disabled = busy || !agent.paneId || pending !== null
  const reason = busy ? t('controlBusy') : undefined

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
      <span className={styles.spacer} />

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
        Close has no loss string and needs none: it ends a session, and the
        transcript it wrote stays on disk to be read afterwards.
      */}
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
