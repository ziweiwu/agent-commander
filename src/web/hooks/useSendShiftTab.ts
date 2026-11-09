import { useRef, useState } from 'react'
import { useStore } from '../store/store.ts'
import { sendShiftTab } from '../store/transport.ts'
import { useTranslate } from './useTranslate.ts'

/**
 * Send Shift+Tab to the agent once per press, and say that it went.
 *
 * Shared by the Mode button and the composer's own Shift+Tab, because both
 * send the same `BTab` into a live session and both need the same guard. The
 * button had it and the composer did not: a held chord in the message box was
 * one `POST …/mode` per keydown, ten mode changes for ten keydowns.
 *
 * INV-2's "exactly once", applied to a control. `pending` is React state and
 * does not land until React flushes, so two presses delivered in one batch — a
 * double tap, key repeat — would both read it as false and both send. The ref
 * is set and cleared synchronously, so a press made while one is in flight is
 * dropped, with no toast, rather than queued.
 *
 * The press says only that the chord went out and never names the mode it
 * reached: Claude Code writes its mode down at the end of a turn, so nothing
 * here can observe where a press landed (INV-11).
 */
export function useSendShiftTab(): { pending: boolean; send: () => void } {
  const t = useTranslate()
  const showToast = useStore((s) => s.showToast)
  const [pending, setPending] = useState(false)
  const sendingRef = useRef(false)

  const send = (): void => {
    if (sendingRef.current) return
    sendingRef.current = true
    setPending(true)
    void (async () => {
      try {
        const result = await sendShiftTab()
        showToast(result.ok ? t('shiftTabSent') : t('controlFailed', { error: result.error }))
      } finally {
        sendingRef.current = false
        setPending(false)
      }
    })()
  }

  return { pending, send }
}
