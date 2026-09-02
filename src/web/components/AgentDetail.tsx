import type { Agent } from '../../shared/types.ts'
import { tildePath, uptimeParts } from '../lib/format.ts'
import { formatUptime } from '../lib/i18n.ts'
import { useState } from 'react'
import { useIsNarrow } from '../hooks/useMediaQuery.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { REASON_KEY, STATUS_KEY, useStatusText } from './AgentCard.tsx'
import { displayName, isRenamed } from '../lib/naming.ts'
import { useStore } from '../store/store.ts'
import { hasTranscripts } from '../../shared/agent-kinds.ts'
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
  const transcripts = hasTranscripts(agent.agentKind)

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

  /** The server's own sentence where there is one; a generic one otherwise. */
  const reasonNotAttachable = agent.attachBlockedReason ?? t('termNotAttachable')

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
        {/* One group, so the two buttons wrap together onto the same line.
            Left as separate children, the wider labelled ⤢ pushed `close` onto
            a row of its own and grew the header by a whole line. */}
        <div className={styles.headActions}>
          {!narrow && (
            <Button
              variant="compact"
              data-testid="fullscreen-toggle"
              title={t('expand')}
              onClick={() => setFullscreen(true)}
            >
              {/* Named rather than a lone ⤢: the glyph is not a word anyone
                  knows, and the header has the room that the tab row does not. */}
              ⤢ {t('expand')}
            </Button>
          )}
          {/* Keeps `.close`: the sheet hides this button, where `‹ Agents` is
              the way back and a second one would be two answers to one question. */}
          <Button variant="compact" className={styles.close} data-testid="close-button" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </div>

      {showControls && <AgentControls agent={agent} />}

      <div className={styles.tabs} role="tablist">
        {/*
          Hidden rather than empty. This agent's CLI keeps no transcript this
          app can read, so the conversation would be blank forever — and a blank
          Chat tab beside a working Attach tab reads as this app being broken
          rather than as the agent having nothing to show.
        */}
        {transcripts && (
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
        )}
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
        {/*
          * Why the tab is greyed out, next to the tab.
          *
          * INV-5 says a degraded capability "renders a reason", and this one
          * had the reason and no way to read it: `attachBlockedReason` was only
          * shown inside the Attach view, which is precisely the view a
          * non-attachable agent cannot open. A disabled control cannot carry a
          * tooltip either — a browser fires no mouse events over it — so the
          * only place the sentence can live is beside it. Elided rather than
          * wrapped, so it can never add a row to the tab strip on a phone.
          */}
        {!agent.paneId && (
          <span className={styles.tabNote} data-testid="attach-blocked-note" title={reasonNotAttachable}>
            {reasonNotAttachable}
          </span>
        )}

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
              onClick={() => setFullscreen(true)}
            >
              ⤢ <span className={styles.actionLabel}>{t('expand')}</span>
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
  /*
   * The Chat tab can now answer some of these itself (INV-16), and when it is
   * about to, "answer it in the terminal below" is the app contradicting itself
   * two inches above the buttons that do the job.
   */
  const answerable = useStore((s) => s.prompt) !== null

  return (
    <div className={styles.blocked} data-testid="blocked-banner">
      <div className={styles.blockedText}>
        <strong>{t('blockedTitle', { reason })}</strong>
        {t(
          !agent.paneId
            ? 'blockedBodyNotAttachable'
            : answerable && tab === 'chat'
              ? 'blockedBodyAnswerable'
              : 'blockedBodyAttachable',
        )}
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
