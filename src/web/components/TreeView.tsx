import { memo, useState } from 'react'
import type { Agent, AgentTree, SubagentNode } from '../../shared/types.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useTokenNavigate } from '../hooks/useTokenNavigate.ts'
import { useStore } from '../store/store.ts'
import { formatRelative } from '../lib/i18n.ts'
import { folderLabel, relative } from '../lib/format.ts'
import { displayName, shortName } from '../lib/naming.ts'
import { specOf } from '../../shared/agent-kinds.ts'
import { useStatusText } from './AgentCard.tsx'
import styles from './TreeView.module.css'

/**
 * Transcript size, captioned as a size.
 *
 * Never a percentage, and never a progress bar with a full end: there is no
 * total for it to be a fraction of. INV-11 caught the same mistake once already
 * — `tokens` was displayed as spend and sorted as "most spent" when it was an
 * output-token count from a capped tail.
 */
function size(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`
  return `${bytes} B`
}

/*
 * The scale the bar is drawn against, and both halves of it are a size.
 *
 * A full bar stands for one megabyte, whose base-10 exponent is 6 — so the fill
 * is a position on a fixed reference size, not a share of a total that does not
 * exist. `MIN_BAR_FILL` is the floor that keeps the smallest transcript visible;
 * an empty rail would read as nothing written rather than as very little.
 */
const MEGABYTE_EXPONENT = 6
const MIN_BAR_FILL = 0.04

/** How much of the bar to fill. Log-scaled, because sizes span three orders. */
function weight(bytes: number): number {
  const filled = Math.log10(Math.max(bytes, 1)) / MEGABYTE_EXPONENT
  return Math.min(1, Math.max(MIN_BAR_FILL, filled))
}

const GLYPH: Record<string, string> = { done: '✓', active: '●', quiet: '○' }
/* Stopped is a `done` — something recorded the ending — but it is not the same
   news as finished, and lending it the tick said it was. */
const STOPPED_GLYPH = '■'

/**
 * What a delegate is doing, in a chip that says how much of it is known.
 *
 * INV-13's rule made visible. `done` is only ever shown on evidence; `active`
 * is a guess and carries the word and a dashed edge saying so — the same device
 * a fleet card already uses for an inferred status; and `quiet` is its own
 * answer rather than a quiet `done`, because an agent that finished and one
 * that died both stop writing.
 *
 * The glyph is not decoration: colour is never the only signal here, which is
 * what `audit:contrast` and the generated palettes both assume.
 */
function StateChip({ node }: { node: SubagentNode }) {
  const t = useTranslate()
  const inferred = node.stateInferred === true
  const label =
    node.stoppedByUser === true
      ? t('treeStoppedByUser')
      : node.state === 'done'
        ? t('treeStateDone')
        : node.state === 'active'
          ? t('treeStateActive')
          : t('treeStateQuiet')

  return (
    <span
      className={styles.chip}
      data-testid="tree-state"
      data-state={node.state}
      data-inferred={inferred}
      data-stopped={node.stoppedByUser === true}
    >
      <span aria-hidden="true" className={styles.glyph}>
        {node.stoppedByUser === true ? STOPPED_GLYPH : (GLYPH[node.state] ?? '○')}
      </span>
      {label}
      {inferred && <span className={styles.inferred}> · {t('treeStateInferred')}</span>}
    </span>
  )
}

/**
 * What the vertical line beside a node does once it reaches it.
 *
 * A position rather than a yes/no: "last" names where a node sits in an array
 * and says nothing about what changes, and this is the only thing that does
 * change. `TreeView.module.css` cuts the rail short at an `ends` node so the
 * line does not run past the bottom of the branch.
 */
type Rail = 'continues' | 'ends'

const railOf = (index: number, siblings: SubagentNode[]): Rail =>
  index === siblings.length - 1 ? 'ends' : 'continues'

function Node({ node, rail }: { node: SubagentNode; rail: Rail }) {
  const t = useTranslate()
  const lang = useStore((s) => s.lang)
  const rel = formatRelative(lang, relative(node.lastWriteAt))

  return (
    <div
      className={styles.node}
      data-testid="tree-node"
      data-last={rail === 'ends'}
      data-depth={node.depth}
    >
      <span className={styles.nodeName}>{node.agentType}</span>
      <StateChip node={node} />
      {node.description && <span className={styles.nodeDesc}>{node.description}</span>}
      <span className={styles.nodeFoot}>
        <span
          className={styles.bar}
          role="img"
          aria-label={`${t('treeSizeLabel')}: ${size(node.bytes)}`}
        >
          <i style={{ width: `${Math.round(weight(node.bytes) * 100)}%` }} />
        </span>
        <span>{t('treeWritten', { size: size(node.bytes) })}</span>
        {rel && <span className={styles.sep}>·</span>}
        {rel && <span>{rel}</span>}
        {node.reparented === true && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.orphan} data-testid="tree-reparented">
              <span aria-hidden="true">△</span>{' '}
              {t('treeReparented', { name: node.agentType })}
            </span>
          </>
        )}
      </span>
      {node.children.length > 0 && (
        <div className={styles.nest}>
          {node.children.map((child, i) => (
            <Node key={child.agentId} node={child} rail={railOf(i, node.children)} />
          ))}
        </div>
      )}
    </div>
  )
}

/** How many delegates there are, and how many of them are moving. */
function count(children: SubagentNode[]): { total: number; running: number } {
  let total = 0
  let running = 0
  const walk = (nodes: SubagentNode[]): void => {
    for (const node of nodes) {
      total += 1
      if (node.state === 'active') running += 1
      walk(node.children)
    }
  }
  walk(children)
  return { total, running }
}

export const TreeRoot = memo(function TreeRoot({
  agent,
  tree,
}: {
  agent: Agent
  tree: AgentTree | undefined
}) {
  const t = useTranslate()
  const lang = useStore((s) => s.lang)
  const navigate = useTokenNavigate()
  const statusText = useStatusText()
  const [open, setOpen] = useState(true)

  const children = tree?.children ?? []
  const { total, running } = count(children)
  const rel = formatRelative(lang, relative(agent.lastActivityAt))
  const name = displayName(agent)

  return (
    <div
      className={styles.root}
      data-testid="tree-root"
      data-status={agent.status}
      data-open={open}
      data-empty={children.length === 0}
    >
      <button
        type="button"
        className={styles.rootHead}
        data-testid="tree-root-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true" className={styles.caret}>
          ▼
        </span>
        <span className={styles.rootName}>{name}</span>
        <span
          className={styles.pill}
          data-status={agent.status}
          data-inferred={agent.statusInferred === true}
        >
          {statusText(agent)}
        </span>
        <span className={styles.rootMeta}>
          <span className={styles.mono}>{folderLabel(agent)}</span>
          {total > 0 && <span className={styles.sep}>·</span>}
          {total > 0 && (
            <span>
              {t(total === 1 ? 'treeDelegateCount' : 'treeDelegateCountPlural', { n: total })}
              {running > 0 && `, ${t('treeRunningCount', { n: running })}`}
            </span>
          )}
          {rel && <span className={styles.sep}>·</span>}
          {rel && <span>{rel}</span>}
        </span>
      </button>

      {open && children.length > 0 && (
        <div className={styles.kids}>
          {children.map((child, i) => (
            <Node key={child.agentId} node={child} rail={railOf(i, children)} />
          ))}
        </div>
      )}

      {/*
        An agent that has delegated nothing and one this app cannot ask are
        different claims, and saying the same thing for both would be the
        dashboard asserting more than it knows (INV-11).

        Both are one muted line rather than a card with a paragraph and a
        button. On a machine running thirty sessions most of them have delegated
        nothing, and giving each of those the full treatment buried the two or
        three trees the view exists to show.
      */}
      {open && children.length === 0 && (
        <p className={styles.empty} data-testid="tree-empty">
          {tree?.unknown === true
            ? t('treeUnknown', { kind: specOf(agent.agentKind)?.label ?? agent.agentKind })
            : t('treeNoDelegates')}
        </p>
      )}

      {open && children.length > 0 && (
        <div className={styles.rootFoot}>
          <button
            type="button"
            className={styles.open}
            data-testid="tree-open-agent"
            onClick={() => navigate(`/agent/${encodeURIComponent(agent.sessionId)}`)}
          >
            {/* Shortened: a derived session name runs to forty characters, and
                the button is an action rather than a second label for the row
                two lines above it. */}
            {t('treeOpenAgent', { name: shortName(agent) })}
          </button>
        </div>
      )}
    </div>
  )
})
