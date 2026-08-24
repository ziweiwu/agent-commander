import { useMemo, useState } from 'react'
import { useStore } from '../store/store.ts'
import { grouped, unusedAgents, type StatusFilter } from '../lib/filter.ts'
import { displayName } from '../lib/naming.ts'
import { closeAgentById } from '../store/transport.ts'
import type { Key } from '../lib/i18n.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { formatRelative } from '../lib/i18n.ts'
import { relative } from '../lib/format.ts'
import { AgentCard } from './AgentCard.tsx'
import { Button } from './ui/Button.tsx'
import { SortControl } from './SortControl.tsx'
import styles from './FleetList.module.css'

const GROUP_KEY: Record<string, Key> = {
  waiting: 'groupWaiting',
  busy: 'groupBusy',
  idle: 'groupIdle',
}

export interface FleetListProps {
  /** Full width, so cards tile into columns. */
  tiled: boolean
  selected: string | null
  onSelect: (sessionId: string) => void
  searchRef?: React.RefObject<HTMLInputElement | null>
}

/** How many session names the prune confirmation lists before summarising. */
const NAMES_BEFORE_ELLIPSIS = 4

export function FleetList({ tiled, selected, onSelect, searchRef }: FleetListProps) {
  const t = useTranslate()
  const lang = useLang()
  const agents = useStore((s) => s.agents)
  const conn = useStore((s) => s.conn)
  const fleetAt = useStore((s) => s.fleetAt)
  const fleet = useStore((s) => s.fleet)
  const setQuery = useStore((s) => s.setQuery)
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen)
  const showToast = useStore((s) => s.showToast)
  const [pruning, setPruning] = useState(false)

  const groups = useMemo(() => grouped(agents, fleet), [agents, fleet])

  /*
   * Sessions opened and never prompted, counted over the whole fleet rather
   * than the filtered view: the button says what it will close, and a search
   * term narrowing the list must not quietly narrow the action too.
   */
  const unused = useMemo(() => unusedAgents(agents), [agents])

  /**
   * Close them, one at a time, after one confirmation that names them.
   *
   * Sequential rather than concurrent because each close is `/exit` typed into
   * a pane followed by a poll, and a machine at its process cap answers a burst
   * of tmux clients with EAGAIN. Failures are counted rather than thrown: one
   * session refusing to exit is not a reason to abandon the rest, and the toast
   * reports what actually happened rather than what was attempted.
   */
  const prune = async (): Promise<void> => {
    if (pruning || unused.length === 0) return
    const names = unused.map((a) => displayName(a))
    // translate() clamps a substituted value to 80 characters, so the list is
    // shortened here rather than being cut mid-name by the formatter.
    const shown = names.slice(0, NAMES_BEFORE_ELLIPSIS).join(', ')
    const label =
      names.length > NAMES_BEFORE_ELLIPSIS
        ? `${shown} +${names.length - NAMES_BEFORE_ELLIPSIS}`
        : shown
    const count = String(unused.length)
    if (!window.confirm(t('pruneConfirm', { count, names: label }))) return

    setPruning(true)
    let done = 0
    let error = ''
    for (const agent of unused) {
      const result = await closeAgentById(agent.sessionId)
      if (result.ok) done += 1
      else error ||= result.error ?? ''
    }
    setPruning(false)

    if (done === unused.length) showToast(t('pruneDone', { count }))
    else if (done === 0) showToast(t('pruneNone', { error }))
    else
      showToast(
        t('pruneSome', { done: String(done), count, failed: String(unused.length - done), error }),
      )
  }

  return (
    <div className={`${styles.column} ${tiled ? styles.tiled : ''}`}>
      <div className={styles.searchbar}>
        <input
          id="search"
          ref={searchRef}
          data-testid="search"
          type="search"
          value={fleet.query}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchLabel')}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd className={styles.slashHint}>/</kbd>
      </div>

      <SortControl />

      <div className={styles.actions}>
        <Button
          className={styles.newAgent}
          data-testid="new-agent-button"
          onClick={() => setNewAgentOpen(true)}
        >
          + {t('newAgent')}
        </Button>

        {/*
          * Only when there is something to prune, and only while the fleet is
          * live. INV-11: with the socket down these cards are memories, and
          * "idle, never prompted" twenty minutes ago is not a claim about now —
          * which is exactly the wrong thing to close a session on.
          */}
        {unused.length > 0 && (
          <Button
            data-testid="prune-button"
            title={t('pruneTitle')}
            disabled={pruning || conn !== 'open'}
            onClick={() => void prune()}
          >
            {pruning ? t('pruneWorking') : t('prune', { count: String(unused.length) })}
          </Button>
        )}
      </div>

      {/*
        * INV-11: while the socket is down these cards are memories, not
        * readings. Every one of them still says "busy" or "waiting · dialog
        * open" — claims about *now* — and the only thing that changed was a
        * chip in the header. For a dashboard whose whole job is "which agent
        * needs me", that is the failure that matters: acting on a card that
        * went stale twenty minutes ago.
        */}
      {conn !== 'open' && agents.length > 0 && (
        <p className={styles.stale} data-testid="fleet-stale" role="status">
          {fleetAt
            ? t('staleFleet', { when: formatRelative(lang, relative(fleetAt)) })
            : t('staleFleetNoTime')}
        </p>
      )}

      <div
        className={styles.list}
        data-testid="fleet-list"
        data-stale={conn === 'open' ? undefined : 'true'}
      >
        {agents.length === 0 ? (
          <Empty title={t('emptyFleetTitle')} body={t('emptyFleetBody')} />
        ) : groups.length === 0 ? (
          <Empty
            title={t('emptyFilterTitle')}
            body={
              fleet.query ? t('emptyFilterQuery', { query: fleet.query }) : t('emptyFilterStatus')
            }
          />
        ) : (
          groups.map((group) => (
            <section key={group.key}>
              <h2 className={styles.groupHead} data-testid="group-head">
                <span
                  className={group.key === 'waiting' ? styles.waitingTitle : undefined}
                  data-testid="group-title"
                >
                  {t(GROUP_KEY[group.key] as Key)}
                </span>
                <span className={styles.groupCount}>{group.agents.length}</span>
              </h2>
              <div
                className={`${styles.groupList} ${group.key === 'waiting' ? styles.waitingGroup : ''}`}
              >
                {group.agents.map((agent) => (
                  <AgentCard
                    key={agent.sessionId}
                    agent={agent}
                    selected={agent.sessionId === selected}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className={styles.empty} data-testid="empty-state">
      <p className={styles.emptyTitle}>{title}</p>
      <p className={styles.emptyBody}>{body}</p>
    </div>
  )
}

export type { StatusFilter }
