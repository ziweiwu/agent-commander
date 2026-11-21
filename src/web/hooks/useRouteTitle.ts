import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { safeName } from '../lib/naming.ts'
import { useStore } from '../store/store.ts'
import { useTranslate } from './useTranslate.ts'

const APP_NAME = 'agent-commander'

/** `(4) kb-vault · main · agent-commander`: how many wait, then where you are. */
export function pageTitle(waiting: number, place: string | null): string {
  const named = place ? `${place} · ${APP_NAME}` : APP_NAME
  return waiting > 0 ? `(${waiting}) ${named}` : named
}

/**
 * The tab title, in one place: the waiting count a backgrounded window shows,
 * and the page the tab is on.
 *
 * The count was written by the transport on every fleet frame, and a second
 * writer for the place would have fought it, so both live here. The place is
 * the open agent's `safeName`, never its card name (INV-3), or Help.
 */
export function useRouteTitle(): void {
  const t = useTranslate()
  const help = useLocation().pathname.startsWith('/help')
  const waiting = useStore((s) => s.agents.filter((a) => a.status === 'waiting').length)
  const name = useStore((s) => {
    const open = s.agents.find((a) => a.sessionId === s.selected)
    return open ? safeName(open) : null
  })
  const place = help ? t('helpTitle') : name

  useEffect(() => {
    document.title = pageTitle(waiting, place)
  }, [waiting, place])
}
