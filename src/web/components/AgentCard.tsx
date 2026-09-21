import { memo, useMemo, useState } from 'react'
import type { Agent, AgentTree } from '../../shared/types.ts'
import { CLAUDE_KIND, hasTranscripts, specOf } from '../../shared/agent-kinds.ts'
import { CONTEXT_WARN_PCT, relative, tildePath, tokens, uptimeParts, usd } from '../lib/format.ts'
import { plainText } from '../lib/chat.ts'
import { claimOf, isStallCandidate, type DelegationClaim } from '../lib/delegation.ts'
import { trailOf } from '../lib/trail.ts'
import { displayName, isRenamed } from '../lib/naming.ts'
import { formatRelative, formatUptime, type Key } from '../lib/i18n.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { useStore } from '../store/store.ts'
import { DelegationTree } from './DelegationTree.tsx'
import { ICON_BUTTON, ICON_MARK, Icon } from './ui/Icon.tsx'
import type { IconName } from './ui/Icon.tsx'
import { ageFrom, ageIsTimeInState, railOf, reachOf, type RailState } from '../lib/status.ts'
import styles from './AgentCard.module.css'

/**
 * One shape per rail state. `hand` is the only one that is not a ring, and
 * deliberately so: it is the single state that asks the reader to get up, and
 * it must not be something you look at twice to tell from an idle session.
 */
const RAIL_ICON: Record<RailState, IconName> = {
  working: 'arc',
  waiting: 'hand',
  idle: 'ring',
  gone: 'ring-off',
}

/** Server-side reasons that have a translation. */
/**
 * Claude Code's own words for why a session is blocked, in the reader's.
 *
 * The set is closed — the CLI picks from a fixed table and falls back to
 * `permission prompt` — but only two of them were ever mapped, so the other
 * four reached a Chinese reader as raw English.
 */
export const REASON_KEY: Record<string, Key> = {
  'dialog open': 'waitingDialog',
  'starting up': 'waitingStarting',
  'permission prompt': 'waitingPermission',
  'input needed': 'waitingInput',
  'sandbox request': 'waitingSandbox',
  'goal proposal': 'waitingGoal',
  'worker request': 'waitingWorker',
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
 * Whether a delegate line belongs on the face of the card or in its fold.
 *
 * The line answers "is anything under this agent still moving", which is the
 * question a *working* card exists to answer — so on a busy card every claim
 * is on the face. On an idle or waiting card the question is a different one,
 * and "delegated nothing" on every idle card is a sentence read past forty
 * times a day. So `none` folds there, while `some` and `unknown` stay: a
 * count is worth a glance, and "cannot tell" is an admission INV-13 does not
 * let the card bury (INV-11).
 */
function delegatesOnFace(agent: Agent, claim: DelegationClaim): boolean {
  if (claim.kind === 'unread') return false
  if (agent.status === 'busy') return true
  return claim.kind !== 'none'
}

/**
 * One agent in the list. Memoised because the fleet re-renders on every server
 * broadcast, which is every couple of seconds with nine agents.
 *
 * **Three tiers, one card.** The face of the card carries what the group's
 * question needs and nothing else: identity (name, status), the activity line,
 * and one line of where it is. A working card adds what "is it still moving"
 * needs — the trail, its delegates, the stall question — and a waiting card
 * adds the one verb that answers it. Everything a reader can ask for but does
 * not scan for — the token count and its caveat, the session's original name,
 * the full path, the delegation tree — sits in a fold below the card, behind
 * the one disclosure the card had already.
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
  const [showDetails, setShowDetails] = useState(false)
  const claim = useMemo(() => claimOf(tree), [tree])
  const stalled = isStallCandidate(agent, claim)
  /*
   * Through `ageFrom`, so the rule it documents is the rule that runs: an
   * agent with no recorded activity gets no age rather than one counted from
   * when it started, because how long it has been blocked is then not
   * something this app knows (INV-11).
   */
  const since = ageFrom(agent)
  const rel = since === null ? '' : formatRelative(lang, relative(since))
  const tok = tokens(agent.tokens)
  /*
   * The one figure with a real denominator (INV-11): Claude Code's own reading
   * of how full the context window is, via the statusLine bridge. It is
   * captioned with when it was read, and it reaches the face only past
   * `CONTEXT_WARN_PCT`, where "about to compact" is something a fleet-wide
   * glance wants — below that it is a fact a reader asks for, so it folds.
   */
  const contextPct = agent.usage?.contextPct
  const contextRounded = contextPct === undefined ? undefined : Math.round(contextPct)
  const contextHot = contextRounded !== undefined && contextRounded >= CONTEXT_WARN_PCT
  const usageWhen = agent.usage ? formatRelative(lang, relative(agent.usage.at)) : ''
  // Only for agents that are not the default: with a fleet of nine Claude
  // sessions there is nothing to disambiguate, and a badge on every card is a
  // word to read past on every card.
  const kindLabel = agent.agentKind === CLAUDE_KIND ? '' : (specOf(agent.agentKind)?.label ?? agent.agentKind)
  // Advertised on the card so a selector can ask for one that can hold a
  // conversation, rather than counting positions and hoping — which is what the
  // UX and mobile audits were doing until a terminal fixture sorted into the slot.
  const transcripts = hasTranscripts(agent.agentKind)

  /*
   * What the session is working on now, shown only when it adds something the
   * name above does not already say. With no `aiTitle` this line *is* the name
   * (see `describeAgent`), and printing it twice is noise, not emphasis.
   */
  const subject = agent.description?.trim()
  const descriptionLine = subject && subject !== displayName(agent) ? subject : ''
  const working = agent.status === 'busy'
  /*
   * INV-11. `lastActivityAt` means two different things depending on where it
   * came from: a transcript write, or a pane that produced output. The trail
   * draws the first as "it was working until here", which is a claim the second
   * cannot support — a pane goes quiet when a TUI stops repainting, not only
   * when the agent stops. So an agent whose CLI writes no transcript gets no
   * trail rather than a weaker one wearing the same shape.
   *
   * And only a working card gets one at all: on an idle card the trail says
   * nothing the timestamp beside it does not, and a shape that carries no new
   * information is the definition of noise.
   */
  const trail = transcripts && working ? trailOf(agent) : null
  const worked = formatUptime(lang, uptimeParts(agent.startedAt, agent.lastActivityAt))
  const quietFor = formatUptime(lang, uptimeParts(agent.lastActivityAt))
  const onFace = delegatesOnFace(agent, claim)
  const canAnswer = agent.status === 'waiting' && Boolean(agent.paneId)
  /*
   * The sessions the server has told us have lost their pane. The card has to
   * know: a pane id says a reference exists, not that anything is behind it,
   * and a card claiming "terminal reachable" beside its own `exited` is the
   * over-claim INV-11 exists to prevent.
   */
  const exited = useStore((s) => s.exited)
  const rail = railOf(agent, exited)
  const reach = reachOf(agent, exited)
  /** Whether the age on this card is time-in-state rather than time-since. */
  const blockedFor = ageIsTimeInState(agent)
  /*
   * INV-11. What the agent's process is running, read from the process table:
   * a measurement rather than a report, so it is captioned as such wherever it
   * is drawn. The server sends a start time, never a duration, and the age is
   * computed here — which is why a card whose process has not changed costs no
   * broadcast (INV-4). It never feeds the trail: a process start is not a
   * transcript write.
   */
  const runningFor = agent.running ? formatUptime(lang, uptimeParts(agent.running.since)) : ''
  const runningLine = agent.running
    ? t('runningProcess', { cmd: agent.running.command, t: runningFor })
    : ''

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
        data-attached="true"
        aria-current={selected}
        /*
         * Named deliberately rather than by whatever its text concatenates to.
         *
         * The context line separates its parts with a `::after` middot, and
         * generated content is in the accessibility tree — so the card
         * announced as "waiting · dialog open· Bash: rm -rf dist· ~/Projects/
         * lego-deals· terminal reachable", dots and all, with the reach mark's
         * own words on the end. Every one of those facts is worth having and
         * none of them is worth hearing in that order before the name.
         */
        aria-label={`${displayName(agent)} — ${statusText(agent)} — ${tildePath(agent.cwd)}`}
        onClick={() => onSelect(agent.sessionId)}
      >
        {/*
         * The rail: one glyph, in a fixed gutter, carrying the whole state.
         *
         * It is the card's primary channel now, and the reason is scanning —
         * the status word used to sit in the top-right corner, so eight cards
         * were eight reads at eight different x positions. Down a column the
         * fleet answers "which of these needs me" before the names are in
         * focus, which is the only question this app exists for.
         *
         * Four shapes and never four colours (the set's own rule, stated at
         * `bell-off`): a swept arc while working, the hand while waiting, a
         * hollow ring when idle, a struck ring when the pane is gone —
         * plus a dashed stroke for a state this app worked out rather than
         * was told (INV-11), which is the same device the status pill has
         * always used.
         *
         * Decorative by the `Icon` contract, so the meaning is carried by the
         * status text on the row below; this is a second channel, never a
         * replacement for the words.
         */}
        <span
          className={styles.rail}
          data-testid="agent-rail"
          data-state={rail.state}
          data-inferred={rail.inferred || undefined}
          aria-hidden="true"
        >
          <span className={rail.state === 'working' ? styles.spin : undefined}>
            <Icon name={RAIL_ICON[rail.state]} size={ICON_BUTTON} />
          </span>
        </span>

        <div className={styles.body}>
          <div className={styles.top}>
            <span className={styles.name} data-testid="agent-name" title={displayName(agent)}>
              {displayName(agent)}
            </span>
            {kindLabel && (
              <span className={styles.kind} data-testid="agent-kind">
                {kindLabel}
              </span>
            )}
            {/*
             * The age, and what it is the age *of*. For an agent that reported
             * itself waiting this is how long it has been blocked, not when it
             * last wrote — the same number and a different fact, and only one
             * of them tells a reader whether to go and look. Said in the label
             * rather than only in the number, because a screen reader gets no
             * help from position.
             */}
            {rel && (
              <span
                className={styles.age}
                data-testid="agent-age"
                data-since={blockedFor ? 'state' : 'activity'}
                title={blockedFor ? t('ageBlockedTitle') : undefined}
              >
                {rel}
              </span>
            )}
          </div>

          {descriptionLine && (
            <div
              className={styles.description}
              data-testid="agent-description"
              title={t('descriptionTitle')}
            >
              {plainText(descriptionLine)}
            </div>
          )}

          <div className={styles.line} data-testid="agent-meta">
            <span
              className={styles.status}
              data-testid="agent-status"
              data-status={agent.status}
              data-inferred={agent.statusInferred === true}
              title={agent.statusInferred === true ? t('statusInferredTitle') : undefined}
            >
              {statusText(agent)}
            </span>

            {agent.activity ? (
              <span className={styles.activity} data-testid="agent-activity" title={agent.activity}>
                {plainText(agent.activity)}
              </span>
            ) : agent.running ? (
              <span
                className={styles.activity}
                data-testid="agent-activity"
                data-running="true"
                title={t('runningFromProcessTable')}
              >
                {runningLine}
              </span>
            ) : (
              <span
                className={`${styles.activity} ${styles.activityMuted}`}
                data-testid="agent-activity"
                title={transcripts ? t('noPromptsYet') : t('noTranscript')}
              >
                {transcripts ? t('noPromptsYet') : t('noTranscript')}
              </span>
            )}

            <span className={styles.folder} data-testid="agent-dir" title={agent.cwd}>
              {tildePath(agent.cwd)}
            </span>
            {agent.gitBranch && <span className={styles.branch}>{agent.gitBranch}</span>}

            {contextHot && contextRounded !== undefined && (
              <span
                className={styles.context}
                data-testid="agent-context"
                title={t('contextFaceTitle', { pct: contextRounded })}
              >
                {t('contextFace', { pct: contextRounded })}
              </span>
            )}

            {onFace && <DelegateLine agent={agent} claim={claim} />}

            {/*
              * The waiting group's one verb. Not a second button — the card is
              * the button, and opening it lands on the answer card — but the
              * affordance says what the tap does, which "waiting · dialog open"
              * alone does not.
              */}
            {canAnswer && (
              <span className={styles.cta} data-testid="agent-answer-cta" aria-hidden="true">
                {t('cardAnswer')}
              </span>
            )}

            {/*
              * Reachability, and it is a second channel rather than part of the
              * state: an agent can be perfectly reachable and unknowable, or
              * blocked on you and unreachable. The server's own reason rides on
              * the title where it has one, which is where `attachBlockedReason`
              * has wanted to live all along — it is not a status and never was.
              */}
            <span
              className={styles.reach}
              data-testid="agent-reach"
              data-reach={reach.reach}
              title={reach.reach === 'gone' ? (reach.reason ?? t('notAttachable')) : undefined}
            >
              <Icon name={reach.reach === 'gone' ? 'screen-off' : 'screen'} size={ICON_MARK} />
              <span className="sr-only">
                {reach.reach === 'gone' ? (reach.reason ?? t('notAttachable')) : t('reachable')}
              </span>
            </span>
          </div>
        </div>
      </button>
      {/*
        * Outside the card's own button, because a disclosure inside a button is
        * not a button — nested interactive elements are invalid, and a keyboard
        * lands on whichever one the browser decides to honour.
        */}
      <button
        type="button"
        className={styles.disclosure}
        data-testid="details-toggle"
        aria-expanded={showDetails}
        onClick={() => setShowDetails((open) => !open)}
      >
        {showDetails ? t('detailsHide') : t('detailsShow')}
      </button>
      {showDetails && (
        <div className={styles.panel} data-testid="agent-details">
          <dl className={styles.facts}>
            {/* INV-11: labelled for what it is, in words a phone can show. This
                counts output tokens only, from a transcript tail that is capped,
                so it is not the session's spend and must not read as though it
                were. */}
            {tok && (
              <div className={styles.fact} data-testid="agent-tokens">
                <dt>{t('tokensLabel')}</dt>
                <dd>{t('tokensSeen', { n: tok })}</dd>
              </div>
            )}
            {/* INV-11: a percentage with a real denominator, said with when it
                was read; and a cost said to be the CLI's own estimate. */}
            {contextRounded !== undefined && (
              <div className={styles.fact} data-testid="agent-context-fact">
                <dt>{t('contextLabel')}</dt>
                <dd>
                  {agent.usage?.contextSize
                    ? t('contextFold', {
                        pct: contextRounded,
                        size: tokens(agent.usage.contextSize),
                        when: usageWhen,
                      })
                    : t('contextFoldNoSize', { pct: contextRounded, when: usageWhen })}
                </dd>
              </div>
            )}
            {agent.usage?.costUsd !== undefined && (
              <div className={styles.fact} data-testid="agent-cost">
                <dt>{t('costLabel')}</dt>
                <dd>{t('costFold', { usd: usd(agent.usage.costUsd) })}</dd>
              </div>
            )}
            {isRenamed(agent) && (
              <div className={styles.fact}>
                <dt>{t('sessionNameLabel')}</dt>
                <dd className={styles.derived}>{agent.name}</dd>
              </div>
            )}
            <div className={styles.fact}>
              <dt>{t('pathLabel')}</dt>
              <dd className={styles.path}>{agent.cwd}</dd>
            </div>
            {/* INV-11: the source is named in visible words, as the token
                caveat is, because a phone cannot show a hover title. */}
            {agent.running && (
              <div className={styles.fact} data-testid="agent-running">
                <dt>{t('runningLabel')}</dt>
                <dd>{t('runningFold', { cmd: agent.running.command, t: runningFor })}</dd>
              </div>
            )}
          </dl>

          {/*
           * The trail, and INV-15's question, moved off the face with the rail.
           *
           * Both are about *how long*, which is a second question — the face
           * now answers "which needs me" in one glyph column and the fold
           * answers "and how long has it been like that". Neither claim is
           * weakened: the trail is still absent entirely for an agent whose CLI
           * writes no transcript, and the stall question still refuses to be
           * asked without a duration to name.
           */}
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

          {stalled && quietFor !== '' && (
            <p
              className={styles.stall}
              data-testid="stall-candidate"
              title={t('stallQuestionTitle')}
            >
              {t('stallQuestion', { t: quietFor })}
            </p>
          )}

          {!onFace && <DelegateLine agent={agent} claim={claim} />}
          {claim.kind === 'some' && tree && <DelegationTree nodes={tree.children} />}
        </div>
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
export function DelegateLine({ agent, claim }: { agent: Agent; claim: DelegationClaim }) {
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
