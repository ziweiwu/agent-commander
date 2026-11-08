import { translate } from '../lib/i18n.ts'
import { controlCharacterIn } from '../lib/pasteable.ts'
import { useStore } from './store.ts'

/**
 * Refuse text that would leave its bracketed paste, and say so (INV-2).
 *
 * Every client path to `paste` calls this before anything is queued, echoed,
 * flushed or cleared: a refused message that still drew a pending echo would
 * turn "not delivered" twelve seconds later instead of saying why now, and a
 * draft cleared for it would be lost. The server refuses the same text
 * regardless; this is where the refusal is said in the reader's language.
 *
 * Returns `true` when the text was refused.
 */
export function refusedAsKeypresses(text: string): boolean {
  const code = controlCharacterIn(text)
  if (code === null) return false
  const { lang, showToast } = useStore.getState()
  showToast(translate(lang, 'pasteControlChar', { code }))
  return true
}
