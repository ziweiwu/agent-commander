import { useMemo } from 'react'
import { useStore } from '../store/store.ts'
import { grouped, type StatusFilter } from '../lib/filter.ts'
import type { Key } from '../lib/i18n.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
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

export function FleetList({ tiled, selected, onSelect, searchRef }: FleetListProps) {
  const t = useTranslate()
  const agents = useStore((s) => s.agents)
  const fleet = useStore((s) => s.fleet)
  const setQuery = useStore((s) => s.setQuery)
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen)

  const groups = useMemo(() => grouped(agents, fleet), [agents, fleet])

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

      <Button
        className={styles.newAgent}
        data-testid="new-agent-button"
        onClick={() => setNewAgentOpen(true)}
      >
        + {t('newAgent')}
      </Button>

      <div className={styles.list} data-testid="fleet-list">
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
