import { useStore } from '../store/store.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import styles from './SearchBar.module.css'

/**
 * The fleet's free-text filter, shared by both renderings.
 *
 * One component rather than one per view because the query is one piece of
 * state: typing in the forest and switching to the cards must show the same
 * narrowed fleet, not a fresh box (the "true in both" rule in AGENTS.md).
 */
export function SearchBar({ searchRef }: { searchRef?: React.RefObject<HTMLInputElement | null> }) {
  const t = useTranslate()
  const query = useStore((s) => s.fleet.query)
  const setQuery = useStore((s) => s.setQuery)

  return (
    <div className={styles.searchbar}>
      <input
        id="search"
        ref={searchRef}
        data-testid="search"
        type="search"
        value={query}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchLabel')}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      <kbd className={styles.slashHint}>/</kbd>
    </div>
  )
}
