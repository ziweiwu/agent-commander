import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/store.ts'
import { LANGUAGES, LANGUAGE_NAMES } from '../lib/i18n.ts'
import { SCHEMES, THEMES, VIEWS, type Scheme, type Theme, type View } from '../lib/prefs.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { Button } from './ui/Button.tsx'
import styles from './SettingsMenu.module.css'

const THEME_KEY = {
  system: 'themeSystem',
  light: 'themeLight',
  dark: 'themeDark',
} as const

const THEME_ICON: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' }

/** How close the menu may come to the edge of the window before it flips. */
const VIEWPORT_MARGIN = 8

const VIEW_KEY = {
  forest: 'viewForest',
  legacy: 'viewLegacy',
} as const

/*
 * A name alone does not distinguish these two. "Forest" and "Cards" both sound
 * plausible for either, and picking the wrong one replaces the whole dashboard
 * — so each row carries a line saying what it actually shows, as its tooltip
 * and its accessible description at once.
 */
const VIEW_HINT = {
  forest: 'viewForestHint',
  legacy: 'viewLegacyHint',
} as const

/* Box-drawing over anything more pictorial: `├` is the branch a delegation tree
   is already drawn with in a terminal, and `☰` is a list of rows. Both are as
   widely available in fallback fonts as the theme glyphs beside them. */
const VIEW_ICON: Record<View, string> = { forest: '├', legacy: '☰' }

const SCHEME_KEY = {
  graphite: 'schemeGraphite',
  nordic: 'schemeNordic',
  solar: 'schemeSolar',
  ember: 'schemeEmber',
  mauve: 'schemeMauve',
} as const

/*
 * A swatch per scheme, in that scheme's own colours.
 *
 * A colour scheme named in words is a choice made blind — "Ember" tells you
 * nothing until you have already applied it and had the whole interface change
 * around you. Three dots cost one line of the menu and let the choice be made
 * by looking.
 *
 * The colours come from `--swatch-<scheme>-*`, which `gen-themes.py` emits
 * alongside the palettes, so there is no second copy of them here to fall out
 * of step with a regenerated scheme. They cannot come from the scheme's own
 * tokens: those are defined on `:root[data-scheme=…]`, which only ever matches
 * the root element, and the menu has to draw five schemes at once inside one
 * document that is only ever in one of them.
 */
function Swatch({ scheme }: { scheme: Scheme }) {
  return (
    <span className={styles.swatch} data-swatch={scheme} aria-hidden="true">
      <i style={{ background: `var(--swatch-${scheme}-bg)` }} />
      <i style={{ background: `var(--swatch-${scheme}-panel-2)` }} />
      <i style={{ background: `var(--swatch-${scheme}-accent)` }} />
    </span>
  )
}

/**
 * View, theme, colours and language.
 *
 * The view group comes first because it is the largest of the four choices:
 * which colour the dashboard is matters less than which dashboard it is.
 *
 * Theme and language close the menu on a choice, so the result is visible
 * immediately, which is what every other menu on the platform does. View and
 * colours stay open — both are choices made by comparing, not by knowing.
 */
export function SettingsMenu() {
  const t = useTranslate()
  const view = useStore((s) => s.view)
  const theme = useStore((s) => s.theme)
  const scheme = useStore((s) => s.scheme)
  const lang = useStore((s) => s.lang)
  const setView = useStore((s) => s.setView)
  const setTheme = useStore((s) => s.setTheme)
  const setScheme = useStore((s) => s.setScheme)
  const setLang = useStore((s) => s.setLang)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Which edge the menu hangs from; see the effect below. */
  const [side, setSide] = useState<'right' | 'left'>('right')

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  /*
   * Keep the menu on the screen.
   *
   * It hangs from the right edge of its button, which is right for the button's
   * usual home at the end of the topbar. But the topbar wraps: at around 900px
   * the filters take a row of their own and the buttons drop to the left-hand
   * end of the next one — and a 190px menu hanging leftwards from a button 90px
   * from the edge of the window is a menu that is mostly off the screen. It was
   * reachable by scrolling sideways and not otherwise, which for the menu that
   * holds the theme, the colours and the language is the whole of settings
   * being unreachable at one width.
   *
   * Measured rather than guessed at a breakpoint, because what decides it is
   * where the button ended up after wrapping, which no media query knows.
   */
  useEffect(() => {
    if (!open) return
    const menu = menuRef.current
    if (!menu) return
    const flip = (): void => {
      const box = menu.getBoundingClientRect()
      // `side` is not in the dependencies on purpose: this reads the position
      // it currently has and only asks whether the other one would be better.
      setSide((current) => {
        if (current === 'right') return box.left < VIEWPORT_MARGIN ? 'left' : 'right'
        return box.right > window.innerWidth - VIEWPORT_MARGIN ? 'right' : 'left'
      })
    }
    flip()
    window.addEventListener('resize', flip)
    return () => window.removeEventListener('resize', flip)
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
        <div
          className={styles.menu}
          data-testid="settings-menu"
          data-side={side}
          ref={menuRef}
          role="menu"
        >
          <div className={styles.group}>
            <span className={styles.label}>{t('viewLabel')}</span>
            {VIEWS.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                className={styles.item}
                data-testid={`view-${option}`}
                title={t(VIEW_HINT[option])}
                aria-checked={view === option}
                aria-pressed={view === option}
                onClick={() => {
                  setView(option)
                  // Left open, for the reason the colour schemes are: the two
                  // views are worth flipping between to see which suits the
                  // fleet on screen, and that is two clicks rather than four.
                }}
              >
                <span className={styles.icon}>{VIEW_ICON[option]}</span>
                {t(VIEW_KEY[option])}
              </button>
            ))}
          </div>

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
            <span className={styles.label}>{t('colourScheme')}</span>
            {SCHEMES.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                className={styles.item}
                data-testid={`scheme-${option}`}
                aria-checked={scheme === option}
                aria-pressed={scheme === option}
                onClick={() => {
                  setScheme(option)
                  // Left open, unlike the theme and language choices. Picking a
                  // palette is a thing people try two or three of before
                  // settling, and closing the menu on the first one makes
                  // comparing them four clicks apiece.
                }}
              >
                <Swatch scheme={option} />
                {t(SCHEME_KEY[option])}
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
