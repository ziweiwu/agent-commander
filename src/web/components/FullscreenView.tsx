import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Agent } from '../../shared/types.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useModalChrome } from '../hooks/useModalChrome.ts'
import { Chat } from './Chat.tsx'
import { LazyTerminal } from './LazyTerminal.tsx'

import { Button } from './ui/Button.tsx'
import { displayName } from '../lib/naming.ts'
import styles from './FullscreenView.module.css'

export interface FullscreenViewProps {
  agent: Agent
  tab: 'chat' | 'attach'
  onTab: (tab: 'chat' | 'attach') => void
  onExit: () => void
}

/**
 * Full screen for whichever view is open.
 *
 * It hosts the same Chat / Terminal tabs as the panel does, so you can read the
 * conversation full-bleed, jump to the terminal to answer a prompt, and come
 * back without ever dropping out of full screen. Rendered through a portal at
 * body level so it escapes the detail panel's overflow.
 */
export function FullscreenView({ agent, tab, onTab, onExit }: FullscreenViewProps) {
  const t = useTranslate()
  const overlayRef = useRef<HTMLDivElement>(null)

  useModalChrome(overlayRef, true)

  // Focus lands on the overlay itself rather than its first tab stop, so the
  // dialog's label is announced before the tabs are read out.
  useEffect(() => {
    overlayRef.current?.focus()
  }, [])

  // The overlay owns the screen; the page behind it must not scroll.
  useEffect(() => {
    document.body.classList.add('no-scroll')
    return () => document.body.classList.remove('no-scroll')
  }, [])

  return createPortal(
    <div
      ref={overlayRef}
      tabIndex={-1}
      className={styles.overlay}
      data-testid="fullscreen-view"
      role="dialog"
      aria-modal="true"
      aria-label={displayName(agent)}
    >
      <header className={styles.head}>
        <span className={styles.title} title={agent.cwd}>
          {displayName(agent)}
        </span>
        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            className={styles.tab}
            data-testid="fullscreen-tab-chat"
            aria-selected={tab === 'chat'}
            onClick={() => onTab('chat')}
          >
            {t('tabChat')}
          </button>
          <button
            type="button"
            role="tab"
            className={styles.tab}
            data-testid="fullscreen-tab-attach"
            aria-selected={tab === 'attach'}
            disabled={!agent.paneId}
            onClick={() => onTab('attach')}
          >
            {t('tabAttach')}
          </button>
        </div>
        <Button variant="compact" data-testid="fullscreen-exit" onClick={onExit}>
          {t('collapse')}
        </Button>
      </header>

      <div className={styles.body}>
        {tab === 'chat' ? <Chat agent={agent} /> : <LazyTerminal agent={agent} onExit={onExit} />}
      </div>
    </div>,
    document.body,
  )
}
