import type { Agent } from '../../shared/types.ts'
import { tildePath, uptimeParts } from '../lib/format.ts'
import { formatUptime } from '../lib/i18n.ts'
import { useState } from 'react'
import { useIsNarrow } from '../hooks/useMediaQuery.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { REASON_KEY, STATUS_KEY, useStatusText } from './AgentCard.tsx'
import { displayName, isRenamed } from '../lib/naming.ts'
import { useStore } from '../store/store.ts'
import { AgentControls } from './AgentControls.tsx'
import { FullscreenView } from './FullscreenView.tsx'
import { Chat } from './Chat.tsx'
import { LazyTerminal } from './LazyTerminal.tsx'

import { Button } from './ui/Button.tsx'
import styles from './AgentDetail.module.css'

export interface AgentDetailProps {
  agent: Agent
  tab: 'chat' | 'attach'
  /** True when the detail owns the whole screen rather than sitting beside the list. */
  sheet: boolean
  onTab: (tab: 'chat' | 'attach') => void
  onClose: () => void
}

/** Just the status word, for when there is no room for the reason. */
function useShortStatus(): (agent: Agent) => string {
  const t = useTranslate()
  return (agent) => t(STATUS_KEY[agent.status] ?? 'statusUnknown')
}

export function AgentDetail({ agent, tab, sheet, onTab, onClose }: AgentDetailProps) {
  const t = useTranslate()
  const lang = useLang()
  const statusText = useStatusText()
  const shortStatus = useShortStatus()
  const fullscreen = useStore((s) => s.fullscreen)
  const setFullscreen = useStore((s) => s.setFullscreen)
  const narrow = useIsNarrow()
  // On a phone this row wrapped to three lines and took 111px of a 568px
  // screen, so it collapses behind a disclosure there and stays inline on a
  // desktop, where there is room for it.
  const [controlsOpen, setControlsOpen] = useState(false)
  const showControls = !narrow || controlsOpen

  // Full screen replaces the panel entirely rather than rendering both, so the
  // conversation is not mounted twice and scrolled in two places.
  if (fullscreen) {
    return (
      <FullscreenView agent={agent} tab={tab} onTab={onTab} onExit={() => setFullscreen(false)} />
    )
  }

  const up = formatUptime(lang, uptimeParts(agent.startedAt))
  const subtitle = [
    isRenamed(agent) ? agent.name : '',
    tildePath(agent.cwd),
    agent.gitBranch,
    up ? `${t('uptimePrefix')} ${up}` : '',
    `pid ${agent.pid}`,
  ]
    .filter(Boolean)
    .join('  ·  ')

  return (
    <section
      className={`${styles.detail} ${sheet ? styles.sheet : ''}`}
      data-testid="agent-detail"
      aria-label={agent.name}
    >
      <div className={styles.head} data-testid="detail-head">
        <Button
          variant="compact"
          className={styles.back}
          data-testid="back-button"
          aria-label={t('back')}
          title={t('back')}
          onClick={onClose}
        >
          <span aria-hidden="true">‹</span>
          <span className={styles.backLabel}> {t('backLabel')}</span>
        </Button>
        <h2 data-testid="detail-name" title={`${displayName(agent)} · ${agent.cwd}`}>
          {displayName(agent)}
        </h2>
        <span
          className={styles.pill}
          data-testid="detail-status"
          data-status={agent.status}
          title={statusText(agent)}
        >
          {/* Rendered, not CSS-hidden: two copies would be read out twice. On a
              narrow sheet the reason is spelled out in the banner below anyway,
              and dropping it gives the agent's name back its space. */}
          {sheet ? shortStatus(agent) : statusText(agent)}
        </span>
        <span className={styles.path}>{subtitle}</span>
        {!narrow && (
          <Button
            variant="compact"
            data-testid="fullscreen-toggle"
            title={t('expand')}
            aria-label={t('expand')}
            onClick={() => setFullscreen(true)}
          >
            ⤢
          </Button>
        )}
        <Button variant="compact" className={styles.close} data-testid="close-button" onClick={onClose}>
          {t('close')}
        </Button>
      </div>

      {showControls && <AgentControls agent={agent} />}

      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-testid="tab-chat"
          aria-selected={tab === 'chat'}
          onClick={() => onTab('chat')}
        >
          {t('tabChat')}
        </button>
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-testid="tab-attach"
          aria-selected={tab === 'attach'}
          disabled={!agent.paneId}
          onClick={() => onTab('attach')}
        >
          {t('tabAttach')}
        </button>

        {narrow && (
          <div className={styles.tabActions}>
            <Button
              variant="compact"
              data-testid="controls-toggle"
              aria-expanded={controlsOpen}
              title={t('agentSettings')}
              aria-label={t('agentSettings')}
              onClick={() => setControlsOpen((v) => !v)}
            >
              ⋯
            </Button>
            <Button
              variant="compact"
              data-testid="fullscreen-toggle"
              title={t('expand')}
              aria-label={t('expand')}
              onClick={() => setFullscreen(true)}
            >
              ⤢
            </Button>
          </div>
        )}
      </div>

      <div className={styles.pane}>
        {agent.status === 'waiting' && (
          <BlockedBanner agent={agent} tab={tab} onOpenTerminal={() => onTab('attach')} />
        )}
        {tab === 'chat' ? (
          <Chat agent={agent} />
        ) : (
          <LazyTerminal agent={agent} onExit={onClose} />
        )}
      </div>
    </section>
  )
}

/**
 * A blocked agent is the whole reason to look at this app, so say plainly what
 * is wrong and put the action that fixes it one click away.
 */
function BlockedBanner({
  agent,
  tab,
  onOpenTerminal,
}: {
  agent: Agent
  tab: 'chat' | 'attach'
  onOpenTerminal: () => void
}) {
  const t = useTranslate()
  const key = agent.waitingFor ? REASON_KEY[agent.waitingFor] : undefined
  const reason = key ? t(key) : (agent.waitingFor ?? t('blockedReasonFallback'))

  return (
    <div className={styles.blocked} data-testid="blocked-banner">
      <div className={styles.blockedText}>
        <strong>{t('blockedTitle', { reason })}</strong>
        {t(agent.paneId ? 'blockedBodyAttachable' : 'blockedBodyNotAttachable')}
      </div>
      {agent.paneId && (
        <Button
          className={styles.cta}
          data-testid="unblock-button"
          onClick={() => {
            if (tab === 'attach') {
              document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
            } else {
              onOpenTerminal()
            }
          }}
        >
          {t(tab === 'attach' ? 'focusTerminal' : 'openTerminal')}
        </Button>
      )}
    </div>
  )
}
