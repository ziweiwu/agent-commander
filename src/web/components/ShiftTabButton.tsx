import { useRef, useState } from 'react'
import type { Agent } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { sendShiftTab } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import styles from './ShiftTabButton.module.css'

/**
 * How much room the button has where it stands.
 *
 * The two places it appears are the only difference between them: the detail
 * panel's control row shares a line with several other controls and takes the
 * tighter spelling, while the composer strip has the width to spell it out.
 */
type ShiftTabButtonSize = 'regular' | 'compact'

/**
 * Send Shift+Tab to the agent — the chord that cycles its permission mode.
 *
 * **It reports no mode, and that is the fix rather than a shortcoming.** This
 * was a mode switch twice before: a `<select>` that asked the server to chase
 * a named mode, and then a cycle button that pressed once and waited to be
 * told where it landed. Both were reported as not working, and the second one
 * was not even wrong about the key — measured against a live session, three
 * presses walk it `auto` → `plan` exactly as they should.
 *
 * What neither could do is *see* that. Claude Code writes its `permission-mode`
 * record when a turn ends, so a session sitting at its prompt — the one you are
 * usually switching — writes nothing in reply, and a session that has not taken
 * a turn yet has no transcript to write it to. So a press cost 2.5 seconds with
 * the control disabled, then said it could not confirm the switch, then left the
 * old mode's name sitting on the button. Three separate signals that nothing had
 * happened, about something that had.
 *
 * So the button now claims only what a key press can claim. It sends the chord
 * and says so. The agent's own terminal is what shows the mode, immediately and
 * without this app having to guess — which is where a user reads it anyway
 * (INV-11: never assert more than is known).
 *
 * Shared by the composer strip and the detail panel rather than written twice.
 * The select existed in both, was fixed in one, and stayed broken in the other
 * two clicks away — the same drift `useHeldChoice` was extracted to stop.
 */
export function ShiftTabButton({
  agent,
  size = 'regular',
}: {
  agent: Agent
  size?: ShiftTabButtonSize
}) {
  const t = useTranslate()
  const showToast = useStore((s) => s.showToast)
  const [pending, setPending] = useState(false)
  /*
   * INV-2's "exactly once", applied to a control: `pending` is React state and
   * does not land until React flushes, so two clicks delivered in one batch —
   * a double tap, key repeat on a focused button — would both read it as false
   * and both send a Shift+Tab into a live session. The ref is cleared
   * synchronously, so the second finds it taken.
   */
  const sendingRef = useRef(false)

  /*
   * Permitted while the agent is working, and INV-8 says why: this sends a
   * control key rather than typing into the prompt. Deciding "this next step
   * should run in plan mode" happens *while* the agent is running, which is
   * the only time it matters.
   */
  const disabled = !agent.paneId || pending

  const press = (): void => {
    if (sendingRef.current || disabled) return
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

  /*
   * `⇧⇥` alone does not say what pressing it will do, and a sighted user
   * cannot infer it from the glyph. The accessible name spells out both the
   * chord and what it is for — the same reason the goal toggle carries its own
   * aria-label rather than leaning on a pressed state.
   */
  const label = t('shiftTabAction')

  return (
    <button
      type="button"
      className={size === 'compact' ? `${styles.mode} ${styles.compact}` : styles.mode}
      data-testid="shift-tab"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={press}
    >
      <span aria-hidden="true" className={styles.kbd}>
        ⇧⇥
      </span>
      <span className={styles.name}>{t('shiftTabName')}</span>
    </button>
  )
}
