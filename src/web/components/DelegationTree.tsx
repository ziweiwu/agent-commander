import type { SubagentNode } from '../../shared/types.ts'
import { isGuess } from '../lib/delegation.ts'
import { relative, uptimeParts } from '../lib/format.ts'
import { formatRelative, formatUptime, type Key } from '../lib/i18n.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import styles from './DelegationTree.module.css'

const STATE_KEY: Record<SubagentNode['state'], Key> = {
  active: 'delegateActive',
  quiet: 'delegateQuiet',
  done: 'delegateDone',
}

/**
 * Why each state means what it means, on the state itself rather than in a
 * legend. `quiet` is the one that needs it: it is the state a reader will
 * otherwise round to "finished", and rounding it is the failure INV-13 exists
 * to prevent.
 */
const STATE_TITLE_KEY: Record<SubagentNode['state'], Key> = {
  active: 'delegateGuessTitle',
  quiet: 'delegateQuietTitle',
  done: 'delegateDoneTitle',
}

/**
 * One agent's delegates, and everything under them.
 *
 * **Nothing here draws a size.** Every node carries `bytes`, and a transcript
 * size has no total to be a fraction of, so the moment it appears as a bar
 * somebody has invented a denominator. It is the same trap `tokens` fell into
 * on the fleet card, where it was drawn as spend.
 *
 * **Nothing here draws a trail either.** A delegate has a last write but no
 * start time — the sidecars do not record one — so a bar leading up to its mark
 * would have to begin somewhere invented. See `trail.ts`.
 */
export function DelegationTree({ nodes }: { nodes: readonly SubagentNode[] }) {
  return (
    <ul className={styles.tree} data-testid="delegation-tree">
      {nodes.map((node) => (
        <Delegate key={node.agentId} node={node} />
      ))}
    </ul>
  )
}

/** Below this the span rounds to "0m", which reads as a measurement of nothing. */
const NAMEABLE_SPAN_MS = 60_000

/**
 * "29 calls over 13m", or "29 calls" when the span is too short to name, or
 * nothing at all when the transcript could not be read. Never "0 calls": a
 * delegate whose transcript could not be read did not do nothing.
 *
 * The span is measured back from the delegate's last write rather than from a
 * bare duration, because `uptimeParts` wants two points in time — and asking it
 * to treat a duration as one silently yields nothing.
 */
function effortText(
  node: SubagentNode,
  lang: Parameters<typeof formatUptime>[0],
  translate: (key: Key, vars?: Record<string, string>) => string,
): string {
  if (node.calls === undefined) return ''
  const n = String(node.calls)
  const worked = node.workedMs ?? 0
  if (worked < NAMEABLE_SPAN_MS) return translate('delegateCalls', { n })
  const span = formatUptime(lang, uptimeParts(node.lastWriteAt - worked, node.lastWriteAt))
  return span === ''
    ? translate('delegateCalls', { n })
    : translate('delegateCallsOver', { n, t: span })
}

function Delegate({ node }: { node: SubagentNode }) {
  const t = useTranslate()
  const lang = useLang()
  const guess = isGuess(node)
  const effort = effortText(node, lang, t)

  return (
    <li className={styles.item}>
      <div className={styles.node} data-testid="delegate" data-state={node.state}>
        <span className={styles.type}>{node.agentType}</span>
        <span className={styles.brief} title={node.description}>
          {node.description}
        </span>

        {/* The state is a word before it is anything else: the dashed edge on a
            guess repeats it, and neither is ever the only carrier (WCAG 1.4.1). */}
        <span
          className={styles.state}
          data-testid="delegate-state"
          data-state={node.state}
          data-inferred={guess}
          title={t(STATE_TITLE_KEY[node.state])}
        >
          {t(STATE_KEY[node.state])}
          {guess ? ` · ${t('delegateGuess')}` : ''}
        </span>

        {/* Named rather than called finished. Something ended it and that is
            worth saying; "done" alone would let it read as its own doing. */}
        {node.stoppedByUser === true && (
          <span className={styles.note}>{t('delegateStopped')}</span>
        )}

        {/*
          * What it did, next to what became of it. `quiet` is almost always the
          * state, so on its own a tree reads as seven identical rows; this is
          * the part that separates thirteen minutes of work from a delegate
          * that died on its first call. A measurement, never a summary — see
          * INV-13 for the summarising heuristics that were tried and dropped.
          */}
        {/* Grouped so they wrap together: separately, a narrow card left a lone
            timestamp stranded on a second line. */}
        <span className={styles.tail}>
          {effort !== '' && (
            <span
              className={styles.effort}
              data-testid="delegate-effort"
              title={t('delegateEffortTitle')}
            >
              {effort}
            </span>
          )}
          <span className={styles.when}>{formatRelative(lang, relative(node.lastWriteAt))}</span>
        </span>

        {node.reparented === true && (
          <span
            className={styles.orphan}
            data-testid="delegate-orphan"
            title={t('delegateOrphanTitle')}
          >
            {t('delegateOrphan')}
          </span>
        )}

      </div>

      {node.children.length > 0 && (
        <ul className={styles.tree}>
          {node.children.map((child) => (
            <Delegate key={child.agentId} node={child} />
          ))}
        </ul>
      )}
    </li>
  )
}
