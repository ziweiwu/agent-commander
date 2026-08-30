import { useStore } from '../store/store.ts'
import { useFleetTrees } from '../hooks/useFleetTrees.ts'
import { useTokenNavigate } from '../hooks/useTokenNavigate.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { grouped } from '../lib/filter.ts'
import { buildForest } from '../lib/forest.ts'
import { Empty } from './FleetList.tsx'
import { ForestView } from './ForestView.tsx'
import { SearchBar } from './SearchBar.tsx'
import { SortControl } from './SortControl.tsx'
import styles from './ForestRoute.module.css'

export interface ForestRouteProps {
  searchRef?: React.RefObject<HTMLInputElement | null>
}

/**
 * The fleet drawn as families on a shared time axis.
 *
 * The delegation graph is polled over HTTP rather than pushed, and **only
 * while this component is mounted** — INV-4's first rule is that nothing polls
 * what nobody is watching, and an effect that stops on unmount satisfies it
 * without adding a subscription lifecycle to the wire. 3s is slow on purpose:
 * a delegate's state changes on the order of a minute, and this view is about
 * the shape of the work rather than its instant. The fleet itself still
 * arrives pushed, so the only thing on the timer is the graph.
 *
 * The families answer to the same query, status filter and sort as the card
 * list, through the same `grouped()` — AGENTS.md's rule is that anything true
 * of the fleet has to be true in both renderings, and "what the search shows"
 * is the sharpest case of it. Grouping is kept as ordering: blocked families
 * first, whatever the sort, because no sort key may bury the one agent that
 * needs you.
 */
export function ForestRoute({ searchRef }: ForestRouteProps) {
  const t = useTranslate()
  const agents = useStore((s) => s.agents)
  const conn = useStore((s) => s.conn)
  const fleet = useStore((s) => s.fleet)
  const fleetAt = useStore((s) => s.fleetAt)
  const selected = useStore((s) => s.selected)
  const navigate = useTokenNavigate()
  const trees = useFleetTrees()

  const ordered = grouped(agents, fleet).flatMap((group) => group.agents)
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
    <div className={styles.column}>
      <SearchBar searchRef={searchRef} />
      <SortControl />

      {agents.length === 0 ? (
        <Empty title={t('emptyFleetTitle')} body={t('emptyFleetBody')} />
      ) : ordered.length === 0 ? (
        <Empty
          title={t('emptyFilterTitle')}
          body={fleet.query ? t('emptyFilterQuery', { query: fleet.query }) : t('emptyFilterStatus')}
        />
      ) : (
        <ForestView
          families={families}
          stale={stale}
          staleSince={fleetAt}
          selected={selected}
          onOpen={(sessionId: string) => navigate(`/agent/${encodeURIComponent(sessionId)}`)}
        />
      )}
    </div>
  )
}
