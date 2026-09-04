import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/store.ts'
import { LANGUAGES, LANGUAGE_NAMES } from '../lib/i18n.ts'
import { SCHEMES, THEMES, type Scheme, type Theme } from '../lib/prefs.ts'
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

const SCHEME_KEY = {
  graphite: 'schemeGraphite',
  nordic: 'schemeNordic',
  solar: 'schemeSolar',
  ember: 'schemeEmber',
  mauve: 'schemeMauve',
  one: 'schemeOne',
  dracula: 'schemeDracula',
  monokai: 'schemeMonokai',
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
 * Theme, colours and language: how the app looks.
 *
 * Notifications used to be in here too, behind an icon that reads everywhere
 * else as a theme toggle, so the switch the headline feature depends on was
 * the one nothing on screen pointed at. It is the bell beside this now
 * (`NotifyButton`), and the icon is a gear, which is what a menu of
 * appearance settings is.
 *
 * Theme and language close the menu on a choice, so the result is visible
 * immediately, which is what every other menu on the platform does. Colours
 * stay open — a choice made by comparing, not by knowing.
 */
export function SettingsMenu() {
  const t = useTranslate()
  const theme = useStore((s) => s.theme)
  const scheme = useStore((s) => s.scheme)
  const lang = useStore((s) => s.lang)
  const setTheme = useStore((s) => s.setTheme)
  const setScheme = useStore((s) => s.setScheme)
  const setLang = useStore((s) => s.setLang)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  /**
   * Every way the menu closes on purpose goes through here. Closing by
   * removing the item that had focus drops focus onto <body>, so the next Tab
   * starts the document over; the gear is where it came from, so the gear is
   * where it goes back. Picking a theme or a language is the way most people
   * close this menu, and it was the one path that did not do this.
   */
  const closeAndRefocus = (): void => {
    setOpen(false)
    wrapRef.current?.querySelector<HTMLElement>('[data-testid="settings-button"]')?.focus()
  }
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
    <div
      className={styles.wrap}
      ref={wrapRef}
      /*
       * The one layer in the app that closed on a mouse alone. Escape closes
       * it and hands focus back to the gear, as every other layer here does;
       * and focus leaving the menu — Tab past its last item — closes it too,
       * because a menu left open over the page while focus is on a control
       * underneath it hides that control from the person using it.
       */
      onKeyDown={(press) => {
        if (press.key !== 'Escape' || !open) return
        press.stopPropagation()
        closeAndRefocus()
      }}
      onBlur={(leave) => {
        if (!open) return
        const next = leave.relatedTarget
        if (next instanceof Node && wrapRef.current?.contains(next)) return
        setOpen(false)
      }}
    >
      <Button
        variant="icon"
        data-testid="settings-button"
        aria-haspopup="true"
        aria-expanded={open}
        title={t('settings')}
        aria-label={t('settings')}
        onClick={() => setOpen((v) => !v)}
      >
        ⚙
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
                  closeAndRefocus()
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
                  closeAndRefocus()
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
