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

/**
 * The same split for the Chat tab's peek at the pane: it draws with xterm too,
 * and a chat that shows no dialog should not pay for it.
 */
const PanePeek = lazy(() => import('./PanePeek.tsx').then((m) => ({ default: m.PanePeek })))

/**
 * A read-only capture of the bottom `rows` of the agent's pane, for the answer
 * card. `rows` defaults to `PEEK_ROWS` in the implementation, not here: naming
 * it here would mean importing it, and importing anything from that module
 * would pull xterm back into the eager bundle. No fallback: a picture that has
 * not loaded yet is simply absent, and a "loading" line in the middle of a
 * question is noise.
 */
export function LazyPanePeek({ agent, rows }: { agent: Agent; rows?: number }) {
  return (
    <Suspense fallback={null}>
      <PanePeek agent={agent} rows={rows} />
    </Suspense>
  )
}
