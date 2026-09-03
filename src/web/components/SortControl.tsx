import { useStore } from '../store/store.ts'
import { SORT_SENSE, SORTS, type SortKey } from '../lib/filter.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import type { Key } from '../lib/i18n.ts'
import styles from './SortControl.module.css'

const SORT_KEY: Record<SortKey, Key> = {
  recent: 'sortRecent',
  tokens: 'sortTokens',
  duration: 'sortDuration',
  name: 'sortName',
}

/**
 * Sorting applies inside the status groups, never across them, so this is a
 * plain select rather than anything that implies it reorders the whole list.
 */
export function SortControl() {
  const t = useTranslate()
  const sort = useStore((s) => s.fleet.sort)
  const dir = useStore((s) => s.fleet.dir)
  const setSort = useStore((s) => s.setSort)
  const setDir = useStore((s) => s.setDir)
  // Labelled with what the order means, not "ascending": nobody thinks
  // "ascending tokens", they think "least spent first".
  const sense = SORT_SENSE[sort]
  const senseLabel = t(dir === 'desc' ? sense.desc : sense.asc)

  return (
    <label className={styles.wrap}>
      <span className={styles.label}>{t('sortBy')}</span>
      <select
        className={styles.select}
        data-testid="sort-select"
        name="sort"
        value={sort}
        onChange={(e) => setSort(e.target.value as SortKey)}
      >
        {SORTS.map((key) => (
          <option key={key} value={key}>
            {t(SORT_KEY[key])}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={styles.dir}
        data-testid="sort-direction"
        aria-label={`${t('sortBy')}: ${senseLabel}`}
        title={`${senseLabel} ${t('sortFirst')}`}
        onClick={() => setDir(dir === 'desc' ? 'asc' : 'desc')}
      >
        <span aria-hidden="true">{dir === 'desc' ? '↓' : '↑'}</span>
        <span className={styles.senseLabel}>{senseLabel}</span>
      </button>
    </label>
  )
}
