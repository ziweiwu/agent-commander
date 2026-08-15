import { memo } from 'react'
import type { Agent } from '../../shared/types.ts'
import { relative, tildePath, tokens } from '../lib/format.ts'
import { plainText } from '../lib/chat.ts'
import { displayName, isRenamed } from '../lib/naming.ts'
import { formatRelative, type Key } from '../lib/i18n.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import styles from './AgentCard.module.css'

/** Server-side reasons that have a translation. */
export const REASON_KEY: Record<string, Key> = {
  'dialog open': 'waitingDialog',
  'starting up': 'waitingStarting',
}

export const STATUS_KEY: Record<string, Key> = {
  waiting: 'statusWaiting',
  busy: 'statusBusy',
  idle: 'statusIdle',
  unknown: 'statusUnknown',
}

export function useStatusText(): (agent: Agent) => string {
  const t = useTranslate()
  return (agent: Agent) => {
    if (agent.status === 'waiting' && agent.waitingFor) {
      const reason = REASON_KEY[agent.waitingFor]
        ? t(REASON_KEY[agent.waitingFor] as Key)
        : agent.waitingFor
      return `${t('statusWaiting')} · ${reason}`
    }
    // The same compound grammar as `waiting · dialog open`, because this is the
    // other state where "what it is" needs "and why" to be true. Without it a
    // card whose own transcript has been silent for ten minutes says plain
    // "busy" and cannot be told apart from one that has quietly died.
    if (agent.status === 'busy' && agent.delegating === true) {
      return `${t('statusBusy')} · ${t('statusDelegated')}`
    }
    return t(STATUS_KEY[agent.status] ?? 'statusUnknown')
  }
}

export interface AgentCardProps {
  agent: Agent
  selected: boolean
  onSelect: (sessionId: string) => void
}

/**
 * One agent in the list. Memoised because the fleet re-renders on every server
 * broadcast, which is every couple of seconds with nine agents.
 */
export const AgentCard = memo(function AgentCard({ agent, selected, onSelect }: AgentCardProps) {
  const t = useTranslate()
  const lang = useLang()
  const statusText = useStatusText()
  const rel = formatRelative(lang, relative(agent.lastActivityAt))
  const tok = tokens(agent.tokens)

  return (
    <button
      type="button"
      className={styles.card}
      data-testid="agent-card"
      data-status={agent.status}
      data-session-id={agent.sessionId}
      aria-current={selected}
      onClick={() => onSelect(agent.sessionId)}
    >
      <div className={styles.top}>
        <span className={styles.name} data-testid="agent-name" title={displayName(agent)}>
          {displayName(agent)}
        </span>
        <span className={styles.pill} data-testid="agent-status" data-status={agent.status}>
          {statusText(agent)}
        </span>
      </div>

      <div className={styles.meta} data-testid="agent-meta">
        <span className={styles.folder} data-testid="agent-dir" title={agent.cwd}>
          {tildePath(agent.cwd)}
        </span>
        {agent.gitBranch && <span className={styles.branch}>{agent.gitBranch}</span>}
        {rel && <span>{rel}</span>}
        {tok && <span>↓ {tok}</span>}
        {agent.subagents ? (
          <span>
            {agent.subagents} subagent{agent.subagents > 1 ? 's' : ''}
          </span>
        ) : null}
        {isRenamed(agent) && (
          <span className={styles.derived} title={agent.name}>
            {agent.name}
          </span>
        )}
        {!agent.paneId && <span className={styles.warn}>{t('notAttachable')}</span>}
      </div>

      {agent.activity ? (
        <div className={styles.activity} data-testid="agent-activity" title={agent.activity}>
          {plainText(agent.activity)}
        </div>
      ) : (
        <div
          className={`${styles.activity} ${styles.activityMuted}`}
          data-testid="agent-activity"
        >
          {t('noPromptsYet')}
        </div>
      )}
    </button>
  )
})
