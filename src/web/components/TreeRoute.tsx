import { useStore } from '../store/store.ts'
import { useFleetTrees } from '../hooks/useFleetTrees.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { sortAgents } from '../lib/filter.ts'
import { TreeRoot } from './TreeView.tsx'
import styles from './TreeView.module.css'
import layout from './App.module.css'

/**
 * How often to re-read the graph while this view is open.
 *
 * Slower than the fleet's own 2s tick because nothing here is urgent: a
 * delegate's state changes on the order of a minute, and the whole point of the
 * view is the shape of the work rather than its instant. The cost is a
 * `readdir` and a few cached sidecar reads per agent.
 */

/**
 * The fleet's delegation graph, re-read while this view is on screen.
 *
 * Its own hook because it has its own lifetime, and the same shape
 * `ForestRoute` gives the same job: the effect stopping on unmount is what
 * makes INV-4's first rule — nothing polls what nobody is watching — hold, and
 * burying that inside a component that is also shaping props put the one rule
 * the loop exists to obey in the hardest place to find it. Polled over HTTP
 * rather than pushed down the socket, which spares the wire a fifth client
 * message and a subscription lifecycle.
 *
 * The loop re-arms after the work completes rather than on a fixed interval,
 * which is `Poller`'s rule on the server applied here for the same reason: a
 * slow read must not stack requests behind itself.
 *
 * The served `ETag` is a ref rather than state because it must never itself
 * cause a render: it changes only when `trees` changes, and the whole point of
 * holding it is to leave `trees` — and so every node behind `TreeRoot`'s `memo`
 * — untouched when the graph has not moved. Calling `setTrees` with a freshly
 * parsed copy of identical data was the bug this replaced: every `tree` prop
 * got a new identity every three seconds, so the `memo` could never hit and all
 * of it re-rendered for data nobody had changed.
 */

/** The fleet's delegation graph, one collapsible tree per session. */
export function TreeRoute() {
  const t = useTranslate()
  const agents = useStore((s) => s.agents)
  const conn = useStore((s) => s.conn)
  const trees = useFleetTrees()

  const byId = new Map(trees.map((tree) => [tree.sessionId, tree]))
  // The fleet's own order, so an agent sits in the same place in both views.
  const ordered = sortAgents(agents, 'recent', 'desc')

  return (
    <main className={`${layout.layout} ${layout.solo}`}>
      <div className={styles.list} data-testid="tree-view">
        {/*
          The same caveat the fleet carries with the socket down (INV-11): every
          state here is a claim about now, and with nothing arriving they are
          all memories.
        */}
        {conn !== 'open' && ordered.length > 0 && (
          <p className={styles.empty} role="status" data-testid="tree-stale">
            {t('staleFleetNoTime')}
          </p>
        )}
        {ordered.length === 0 ? (
          <p className={styles.empty}>{t('treeEmpty')}</p>
        ) : (
          ordered.map((agent) => (
            <TreeRoot key={agent.sessionId} agent={agent} tree={byId.get(agent.sessionId)} />
          ))
        )}
      </div>
    </main>
  )
}
