import { useCallback } from 'react'
import { useStore } from '../store/store.ts'
import { translate, type Key } from '../lib/i18n.ts'

export type Translate = (key: Key, vars?: Record<string, string | number>) => string

/** `t()` bound to the current language, and re-created when it changes. */
export function useTranslate(): Translate {
  const lang = useStore((s) => s.lang)
  return useCallback((key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang])
}

/** The current language, for the format helpers that need it directly. */
export function useLang() {
  return useStore((s) => s.lang)
}
