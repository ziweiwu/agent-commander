import { useRef, useState } from 'react'
import type { Agent } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { sendShiftTab } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { modeLabel } from '../lib/modes.ts'
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
 * Send Shift+Tab to the agent — the chord that cycles its permission mode —
 * and show the mode the session last wrote down.
 *
 * **The readout and the press are two different claims, and keeping them apart
 * is the whole design.** This was a mode switch twice before: a `<select>` that
 * asked the server to chase a named mode, and then a cycle button that pressed
 * once and waited to be told where it landed. Both were reported as not
 * working, and neither was wrong about the key — measured against a live
 * session, three presses walk it `auto` → `plan` exactly as they should.
 *
 * What neither could do is *see* that. Claude Code writes its `permission-mode`
 * record when a turn ends, so a session sitting at its prompt — the one you are
 * usually switching — writes nothing in reply, and a session that has not taken
 * a turn yet has no transcript to write it to. So a press cost 2.5 seconds with
 * the control disabled, then said it could not confirm the switch, then left the
 * old mode's name sitting on the button: three signals that nothing had
 * happened, about something that had.
 *
 * So the mode shown here is never the answer to a press. It is
 * `agent.permissionMode` — what the session itself last recorded — rendered
 * whenever there is one and omitted when there is not, and the press does not
 * touch it. **It therefore lags a switch, by design:** on an agent at its
 * prompt the readout stays on the old mode until that session finishes a turn.
 * Pressing still says only that the chord went out, and the toast still points
 * at the agent's own terminal, which shows the new mode immediately and without
 * this app having to guess (INV-11: never assert more than is known).
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
   * Absent until the session has recorded one — which is the ordinary state for
   * an agent that has not taken a turn yet, not an error to paper over. Nothing
   * is substituted for it: no "unknown", no assumed `default`, because either
   * would be this app naming a mode it has not been told (INV-11).
   */
  const current = agent.permissionMode ? modeLabel(agent.permissionMode, t) : undefined

  /*
   * `⇧⇥` alone does not say what pressing it will do, and a sighted user cannot
   * infer it from the glyph. The accessible name spells out both the chord and
   * what it is for — and carries the mode too when one is shown, because a
   * label that omits part of its own visible text leaves a screen reader with
   * less than the screen has.
   */
  const label = current
    ? t('shiftTabActionWithMode', { mode: current })
    : t('shiftTabAction')

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
      {/* "Mode", not "Shift+Tab": the readout is what a reader scans for, and
          a button named after its chord said nothing about what it showed. The
          chord is the glyph beside it and the accessible name spells it out. */}
      <span className={styles.name}>{t('modeLabel')}</span>
      {/* Decoration between two labels, and read as neither. */}
      <span aria-hidden="true" className={styles.sep}>
        ·
      </span>
      {current ? (
        /*
          Hidden from the accessible name rather than duplicated into it: the
          button's `aria-label` already ends with this mode, and leaving it
          exposed would have a screen reader say it twice.
        */
        <span aria-hidden="true" className={styles.current} data-testid="shift-tab-mode">
          {current}
        </span>
      ) : (
        /*
          Said rather than left blank. A bare "Mode ·" reads as a broken
          readout; "not reported yet" is the actual state — the session has
          not finished a turn since it started, so it has written no mode down
          — and it names no mode this app was not told (INV-11).
        */
        <span aria-hidden="true" className={styles.unreported} data-testid="shift-tab-unreported">
          {t('modeUnreported')}
        </span>
      )}
    </button>
  )
}
