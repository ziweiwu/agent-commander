import { memo, useMemo, useState } from 'react'
import type { Agent, AgentTree } from '../../shared/types.ts'
import { CLAUDE_KIND, hasTranscripts, specOf } from '../../shared/agent-kinds.ts'
import { relative, tildePath, tokens, uptimeParts } from '../lib/format.ts'
import { plainText } from '../lib/chat.ts'
import { claimOf, isStallCandidate, type DelegationClaim } from '../lib/delegation.ts'
import { trailOf } from '../lib/trail.ts'
import { displayName, isRenamed } from '../lib/naming.ts'
import { formatRelative, formatUptime, type Key } from '../lib/i18n.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { DelegationTree } from './DelegationTree.tsx'
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
    /*
     * INV-11 again, and the same compound grammar a third time. This agent's
     * CLI reports nothing about itself, so `idle` here means only "its pane has
     * been quiet", which is a far weaker claim than the `idle` on a Claude card
     * beside it. It reads `idle · quiet` so the two are not mistaken for equals,
     * and it can never say `waiting` — see `tmux-agents.ts`.
     */
    if (agent.statusInferred === true) {
      return `${t(STATUS_KEY[agent.status] ?? 'statusUnknown')} · ${t('statusFromPane')}`
    }
    return t(STATUS_KEY[agent.status] ?? 'statusUnknown')
  }
}

export interface AgentCardProps {
  agent: Agent
  /**
   * This agent's delegates, or `undefined` while the graph has not arrived.
   *
   * Passed as the tree rather than as a summary so the object identity is the
   * server's: the poll replaces it only when the graph actually changed, which
   * is what keeps the memo below intact through the polls where it did not.
   */
  tree?: AgentTree
  selected: boolean
  onSelect: (sessionId: string) => void
}

/**
 * One agent in the list. Memoised because the fleet re-renders on every server
 * broadcast, which is every couple of seconds with nine agents.
 */
export const AgentCard = memo(function AgentCard({
  agent,
  tree,
  selected,
  onSelect,
}: AgentCardProps) {
  const t = useTranslate()
  const lang = useLang()
  const statusText = useStatusText()
  const [showDelegates, setShowDelegates] = useState(false)
  const claim = useMemo(() => claimOf(tree), [tree])
  const stalled = isStallCandidate(agent, claim)
  const rel = formatRelative(lang, relative(agent.lastActivityAt))
  const tok = tokens(agent.tokens)
  // Only for agents that are not the default: with a fleet of nine Claude
  // sessions there is nothing to disambiguate, and a badge on every card is a
  // word to read past on every card.
  const kindLabel = agent.agentKind === CLAUDE_KIND ? '' : (specOf(agent.agentKind)?.label ?? agent.agentKind)
  // Advertised on the card so a selector can ask for one that can hold a
  // conversation, rather than counting positions and hoping — which is what the
  // UX and mobile audits were doing until a Kiro fixture sorted into the slot.
  const transcripts = hasTranscripts(agent.agentKind)
  /*
   * INV-11. `lastActivityAt` means two different things depending on where it
   * came from: a transcript write, or a pane that produced output. The trail
   * draws the first as "it was working until here", which is a claim the second
   * cannot support — a pane goes quiet when a TUI stops repainting, not only
   * when the agent stops. So an agent whose CLI writes no transcript gets no
   * trail rather than a weaker one wearing the same shape.
   */
  const trail = transcripts ? trailOf(agent) : null
  const worked = formatUptime(lang, uptimeParts(agent.startedAt, agent.lastActivityAt))
  const quietFor = formatUptime(lang, uptimeParts(agent.lastActivityAt))

  return (
    <div className={styles.wrap} data-testid="agent-entry" data-session-id={agent.sessionId}>
      <button
        type="button"
        className={styles.card}
        data-testid="agent-card"
        data-status={agent.status}
        data-session-id={agent.sessionId}
        data-agent-kind={agent.agentKind}
        data-transcripts={transcripts}
        data-attached={claim.kind === 'some' && tree !== undefined}
        aria-current={selected}
        onClick={() => onSelect(agent.sessionId)}
      >
        <div className={styles.top}>
          <span className={styles.name} data-testid="agent-name" title={displayName(agent)}>
            {displayName(agent)}
          </span>
          <span
            className={styles.pill}
            data-testid="agent-status"
            data-status={agent.status}
            data-inferred={agent.statusInferred === true}
            title={agent.statusInferred === true ? t('statusInferredTitle') : undefined}
          >
            {statusText(agent)}
          </span>
        </div>

        <div className={styles.meta} data-testid="agent-meta">
          <span className={styles.folder} data-testid="agent-dir" title={agent.cwd}>
            {tildePath(agent.cwd)}
          </span>
          {agent.gitBranch && <span className={styles.branch}>{agent.gitBranch}</span>}
          {rel && <span>{rel}</span>}
          {/* INV-11: labelled for what it is. This counts output tokens only,
              from a transcript tail that is capped, so it is not the session's
              spend and must not be presented as though it were. */}
          {tok && <span title={t('tokensTitle')}>↓ {tok}</span>}
          {isRenamed(agent) && (
            <span className={styles.derived} title={agent.name}>
              {agent.name}
            </span>
          )}
          {kindLabel && (
            <span className={styles.kind} data-testid="agent-kind">
              {kindLabel}
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
            title={transcripts ? t('noPromptsYet') : t('noTranscript')}
          >
            {transcripts ? t('noPromptsYet') : t('noTranscript')}
          </div>
        )}

        {/* How long it was writing, then how long it has been silent — the same
            two numbers the card already prints, as a shape. Absent entirely for an
            agent whose CLI writes no transcript, because there is no last write to
            measure from and a full-width silence would be an assertion. */}
        {trail && (
          <div
            className={styles.trail}
            data-testid="agent-trail"
            role="img"
            aria-label={t('trailLabel', { worked, silent: quietFor })}
          >
            <span className={styles.worked} style={{ flexGrow: trail.worked }} />
            <span className={styles.silent} style={{ flexGrow: trail.silent }} />
          </div>
        )}

        <DelegateLine agent={agent} claim={claim} />

        {/*
          * INV-15. Only with a duration to name: this is a question about how long
          * a family has been silent, and without the number there is no question,
          * only an insinuation.
          */}
        {stalled && quietFor !== '' && (
          <p className={styles.stall} data-testid="stall-candidate" title={t('stallQuestionTitle')}>
            {t('stallQuestion', { t: quietFor })}
          </p>
        )}
      </button>
      {/*
        * Outside the card's own button, because a disclosure inside a button is
        * not a button — nested interactive elements are invalid, and a keyboard
        * lands on whichever one the browser decides to honour.
        */}
      {claim.kind === 'some' && tree && (
        <>
          <button
            type="button"
            className={styles.disclosure}
            data-testid="delegates-toggle"
            aria-expanded={showDelegates}
            onClick={() => setShowDelegates((open) => !open)}
          >
            {showDelegates ? t('delegatesHide') : t('delegatesShow')}
          </button>
          {showDelegates && (
            <div className={styles.panel}>
              <DelegationTree nodes={tree.children} />
            </div>
          )}
        </>
      )}
    </div>
  )
})


/**
 * What this card is willing to say about the agent's delegates.
 *
 * Four claims, four renderings, and the two that matter most are the ones a
 * count cannot express. `unknown` says so in words; `none` is a different
 * sentence in the same slot; and `unread` draws nothing at all rather than
 * flashing "delegated nothing" on every card for the first three seconds after
 * a page load, which would be a false claim that happened to be brief.
 */
function DelegateLine({ agent, claim }: { agent: Agent; claim: DelegationClaim }) {
  const t = useTranslate()
  if (claim.kind === 'unread') return null

  return (
    <div className={styles.delegates} data-testid="agent-delegates" data-claim={claim.kind}>
      {claim.kind === 'unknown' && (
        <span className={styles.cannotTell} title={t('delegatesUnknownTitle')}>
          {t('delegatesUnknown')}
        </span>
      )}

      {claim.kind === 'none' && <span>{t('delegatesNone')}</span>}

      {claim.kind === 'some' && (
        <>
          <span className={styles.total}>
            {claim.total === 1 ? t('delegatesOne') : t('delegatesMany', { n: claim.total })}
          </span>
          {claim.active > 0 && (
            <span
              className={styles.count}
              data-testid="delegates-active"
              data-inferred={claim.guesses > 0}
              title={claim.guesses > 0 ? t('delegateGuessTitle') : undefined}
            >
              {claim.active} {t('delegateActive')}
              {claim.guesses > 0 ? ` · ${t('delegateGuess')}` : ''}
            </span>
          )}
          {claim.quiet > 0 && (
            <span className={styles.count} title={t('delegateQuietTitle')}>
              {claim.quiet} {t('delegateQuiet')}
            </span>
          )}
          {claim.done > 0 && (
            <span className={styles.count} title={t('delegateDoneTitle')}>
              {claim.done} {t('delegateDone')}
            </span>
          )}
          {/*
            * The other half of INV-15, and the reason the stall question can be
            * trusted: a family with one delegate still moving is stated to be
            * fine, in the same place the question would otherwise appear.
            */}
          {agent.delegating === true && claim.active > 0 && (
            <span className={styles.moving} data-testid="delegates-moving">
              {t('delegatesMoving', { n: claim.active })}
            </span>
          )}
        </>
      )}
    </div>
  )
}
