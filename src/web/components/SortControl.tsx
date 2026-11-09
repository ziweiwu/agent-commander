import { useStore } from '../store/store.ts'
import { SORT_SENSE, SORTS, type SortKey } from '../lib/filter.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useLayout } from '../hooks/useMediaQuery.ts'
import type { Key } from '../lib/i18n.ts'
import styles from './SortControl.module.css'
import { ICON_INLINE, Icon } from './ui/Icon.tsx'

const SORT_KEY: Record<SortKey, Key> = {
  recent: 'sortRecent',
  context: 'sortContext',
  tokens: 'sortTokens',
  duration: 'sortDuration',
  name: 'sortName',
}

/**
 * The same choices in words that fit beside the filter box on a 320px phone,
 * where the select sizes to its widest option. The select's value is the key,
 * so nothing but the text changes.
 */
const SORT_KEY_PHONE: Record<SortKey, Key> = {
  recent: 'sortRecentShort',
  context: 'sortContextShort',
  tokens: 'sortTokensShort',
  duration: 'sortDurationShort',
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
  const optionKeys = useLayout() === 'phone' ? SORT_KEY_PHONE : SORT_KEY
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
            {t(optionKeys[key])}
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
        <Icon name={dir === 'desc' ? 'arrow-down' : 'arrow-up'} size={ICON_INLINE} />
        <span className={styles.senseLabel}>{senseLabel}</span>
      </button>
    </label>
  )
}
