import { useCallback, useEffect, useState } from 'react'
import type { DirListing } from '../../shared/types.ts'
import { browseDirs } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useOverflowEdge } from '../hooks/useOverflowEdge.ts'
import { Button } from './ui/Button.tsx'
import styles from './FolderBrowser.module.css'

export interface FolderBrowserProps {
  /** Where to open. Falls back to the server's root. */
  start?: string
  onChoose: (path: string) => void
}

/**
 * Directory picker. The server decides what is reachable — it resolves every
 * path and refuses anything outside its root (INV-9) — so this component just
 * renders what it is given and never constructs paths itself.
 */
export function FolderBrowser({ start, onChoose }: FolderBrowserProps) {
  const t = useTranslate()
  // A long listing is capped at 40dvh and scrolls; the fade says so.
  const [listRef, listEdge] = useOverflowEdge<HTMLDivElement>()
  const [listing, setListing] = useState<DirListing | null>(null)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(
    async (path?: string, withHidden = hidden) => {
      try {
        setError('')
        setListing(await browseDirs(path, withHidden))
      } catch (err) {
        setError(t('browseFailed', { error: err instanceof Error ? err.message : String(err) }))
      }
    },
    [hidden, t],
  )

  useEffect(() => {
    void load(start)
    // Only on open: afterwards navigation drives the listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles.browser} data-testid="folder-browser">
      <div className={styles.bar}>
        <Button
          variant="compact"
          data-testid="browse-up"
          disabled={!listing?.parent}
          onClick={() => void load(listing?.parent ?? undefined)}
        >
          ↑ {t('browseUp')}
        </Button>
        <span className={styles.path} title={listing?.path}>
          {listing ? shorten(listing.path, listing.root) : '…'}
        </span>
        <label className={styles.hidden}>
          <input
            type="checkbox"
            checked={hidden}
            data-testid="browse-hidden"
            onChange={(e) => {
              setHidden(e.target.checked)
              void load(listing?.path, e.target.checked)
            }}
          />
          {t('browseHidden')}
        </label>
        <Button
          variant="primary"
          data-testid="browse-choose"
          disabled={!listing}
          onClick={() => listing && onChoose(listing.path)}
        >
          {t('browseChoose')}
        </Button>
      </div>

      {error ? (
        <p className={styles.error}>{error}</p>
      ) : (
        <div className={styles.list} ref={listRef} data-overflow={listEdge}>
          {listing?.entries.length === 0 && <p className={styles.empty}>{t('browseEmpty')}</p>}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={`${styles.entry} ${entry.hidden ? styles.entryHidden : ''}`}
              data-testid="browse-entry"
              onClick={() => void load(entry.path)}
            >
              <span className={styles.icon}>▸</span>
              {entry.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Show the path relative to the browsable root, which is usually home. */
function shorten(path: string, root: string): string {
  if (path === root) return '~'
  return path.startsWith(`${root}/`) ? `~/${path.slice(root.length + 1)}` : path
}
