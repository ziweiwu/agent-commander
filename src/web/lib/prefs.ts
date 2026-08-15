/**
 * Theme, language and fleet-filter preferences.
 *
 * Theme is applied as a `data-theme` attribute on <html> rather than by
 * swapping stylesheets, so the CSS can express all three states: an explicit
 * light or dark choice, and "system", which falls through to the media query.
 */
import { detectLang, isLang, type Lang } from './i18n.ts'
import { GROUPS } from './format.ts'
import type { StatusFilter } from './filter.ts'

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

const THEME_KEY = 'agent-commander.theme'
const LANG_KEY = 'agent-commander.lang'
const FILTER_KEY = 'agent-commander.filter'

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // Safari private mode throws on localStorage; preferences just won't stick.
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* not fatal */
  }
}

/*
 * The status filter is per-tab, so it lives in sessionStorage rather than
 * alongside theme and language in localStorage. Theme is a statement about the
 * user; a filter is a statement about the task in front of them right now.
 * Persisting it in localStorage would mean a tab opened tomorrow to check on
 * the whole fleet silently opens showing only "needs you", with the reason
 * three days in the past — and would leak across every other tab besides.
 * Surviving a reload is the useful part, and sessionStorage is exactly that
 * scope.
 */
function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    // Safari private mode and some embedded webviews throw on access.
    return null
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* not fatal */
  }
}

const FILTERS: readonly StatusFilter[] = ['all', ...GROUPS.map((g) => g.key)]

function isFilter(value: unknown): value is StatusFilter {
  return typeof value === 'string' && (FILTERS as readonly string[]).includes(value)
}

export function loadFilter(): StatusFilter {
  const stored = readSession(FILTER_KEY)
  return isFilter(stored) ? stored : 'all'
}

export function saveFilter(filter: StatusFilter): void {
  writeSession(FILTER_KEY, filter)
}

export function loadTheme(): Theme {
  const stored = read(THEME_KEY)
  return isTheme(stored) ? stored : 'system'
}

export function saveTheme(theme: Theme): void {
  write(THEME_KEY, theme)
}

export function loadLang(): Lang {
  const stored = read(LANG_KEY)
  return isLang(stored) ? stored : detectLang()
}

export function saveLang(lang: Lang): void {
  write(LANG_KEY, lang)
}

/** Which palette a theme setting actually resolves to right now. */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  return dark ? 'dark' : 'light'
}

/**
 * Apply the theme to the document. "system" removes the attribute entirely so
 * the prefers-color-scheme media query takes over.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  // Keep the iOS status bar colour in step with the resolved palette.
  const resolved = resolveTheme(theme)
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = resolved === 'dark' ? '#0e1116' : '#f6f7f9'
  }
}

export function applyLang(lang: Lang): void {
  document.documentElement.lang = lang
}
