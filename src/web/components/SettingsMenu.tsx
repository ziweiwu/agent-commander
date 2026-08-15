import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/store.ts'
import { LANGUAGES, LANGUAGE_NAMES } from '../lib/i18n.ts'
import { THEMES, type Theme } from '../lib/prefs.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { Button } from './ui/Button.tsx'
import styles from './SettingsMenu.module.css'

const THEME_KEY = {
  system: 'themeSystem',
  light: 'themeLight',
  dark: 'themeDark',
} as const

const THEME_ICON: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' }

/**
 * Theme and language, the two things a user changes once and never again.
 * The menu closes on a choice so the result is visible immediately, which is
 * what every other menu on the platform does.
 */
export function SettingsMenu() {
  const t = useTranslate()
  const theme = useStore((s) => s.theme)
  const lang = useStore((s) => s.lang)
  const setTheme = useStore((s) => s.setTheme)
  const setLang = useStore((s) => s.setLang)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <Button
        variant="icon"
        data-testid="settings-button"
        aria-haspopup="true"
        aria-expanded={open}
        title={t('settings')}
        aria-label={t('settings')}
        onClick={() => setOpen((v) => !v)}
      >
        {THEME_ICON[theme]}
      </Button>

      {open && (
        <div className={styles.menu} data-testid="settings-menu" role="menu">
          <div className={styles.group}>
            <span className={styles.label}>{t('theme')}</span>
            {THEMES.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                className={styles.item}
                data-testid={`theme-${option}`}
                aria-checked={theme === option}
                aria-pressed={theme === option}
                onClick={() => {
                  setTheme(option)
                  setOpen(false)
                }}
              >
                <span className={styles.icon}>{THEME_ICON[option]}</span>
                {t(THEME_KEY[option])}
              </button>
            ))}
          </div>

          <div className={styles.group}>
            <span className={styles.label}>{t('language')}</span>
            {LANGUAGES.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                className={styles.item}
                data-testid={`lang-${option}`}
                aria-checked={lang === option}
                aria-pressed={lang === option}
                onClick={() => {
                  setLang(option)
                  setOpen(false)
                }}
              >
                <span className={styles.icon}>{option === 'zh-CN' ? '中' : 'A'}</span>
                {LANGUAGE_NAMES[option]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
