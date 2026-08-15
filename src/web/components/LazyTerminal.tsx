import { lazy, Suspense } from 'react'
import type { Agent } from '../../shared/types.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import styles from './Terminal.module.css'

/**
 * xterm is about two thirds of the JavaScript this app ships, and it is only
 * needed once you actually open a terminal. Splitting it out keeps the fleet
 * and chat views — the common path, and the one loaded over Tailscale on a
 * phone — far lighter.
 */
const Terminal = lazy(() => import('./Terminal.tsx').then((m) => ({ default: m.Terminal })))

export function LazyTerminal({ agent, onExit }: { agent: Agent; onExit: () => void }) {
  const t = useTranslate()
  return (
    <Suspense fallback={<div className={styles.notice}>{t('termLoading')}</div>}>
      <Terminal agent={agent} onExit={onExit} />
    </Suspense>
  )
}
