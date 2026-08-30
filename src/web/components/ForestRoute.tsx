import { useStore } from '../store/store.ts'
import { useFleetTrees } from '../hooks/useFleetTrees.ts'
import { useTokenNavigate } from '../hooks/useTokenNavigate.ts'
import { sortAgents } from '../lib/filter.ts'
import { buildForest } from '../lib/forest.ts'
import { ForestView } from './ForestView.tsx'

/**
 * How often to re-read the delegation graph while this view is open.
 *
 * The same 3s the tree view uses, and for the same reason: a delegate's state
 * changes on the order of a minute, and this view is about the shape of the
 * work rather than its instant. The fleet itself still arrives pushed, so the
 * only thing on this timer is the graph.
 */

/**
 * The fleet drawn as families on a shared time axis.
 *
 * Polled over HTTP rather than pushed, and **only while this component is
 * mounted** — INV-4's first rule is that nothing polls what nobody is watching,
 * and an effect that stops on unmount satisfies it without adding a
 * subscription lifecycle to the wire. This is the same shape `TreeRoute` uses;
 * the two views ask the same server for the same graph, so neither of them
 * needed a new endpoint.
 */

export function ForestRoute() {
  const agents = useStore((s) => s.agents)
  const conn = useStore((s) => s.conn)
  const fleetAt = useStore((s) => s.fleetAt)
  const selected = useStore((s) => s.selected)
  const navigate = useTokenNavigate()
  const trees = useFleetTrees()

  // The fleet's own order, so a session sits in the same place in either view.
  const ordered = sortAgents(agents, 'recent', 'desc')
  const stale = conn !== 'open' && ordered.length > 0

  /*
   * With the socket down the clock is frozen at the moment the last fleet
   * arrived, not left running. Every age here is measured from `now`, and the
   * stale view renders those ages as absolute clock times — so a `now` that
   * kept ticking would push every one of them further into the past on every
   * render, which is a moving lie rather than a stopped clock.
   */
  const families = buildForest(ordered, trees, stale && fleetAt ? fleetAt : undefined)

  return (
    <ForestView
      families={families}
      stale={stale}
      staleSince={fleetAt}
      selected={selected}
      onOpen={(sessionId: string) => navigate(`/agent/${encodeURIComponent(sessionId)}`)}
    />
  )
}
