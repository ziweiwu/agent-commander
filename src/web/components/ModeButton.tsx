import { useEffect, useRef, useState } from 'react'
import type { Agent, ControlResponse } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { cycleAgentMode } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import type { Key } from '../lib/i18n.ts'
import { MODE_KEY } from '../lib/modes.ts'
import styles from './ModeButton.module.css'

/**
 * How much room the button has where it stands.
 *
 * The two places it appears are the only difference between them: the detail
 * panel's control row shares a line with several other controls and takes the
 * tighter spelling, while the composer strip has the width to spell it out.
 */
type ModeButtonSize = 'regular' | 'compact'

/**
 * The permission-mode switch: one Shift+Tab per press.
 *
 * **This replaced a `<select>`, and the shape of the control was the bug.** A
 * dropdown asks for a *named* mode, which the server could only reach by
 * pressing Shift+Tab repeatedly and re-reading until the session reported the
 * one that was picked. Claude Code writes its permission mode down at the end
 * of a turn, so against a working agent the reading could not move, the loop
 * stopped itself rather than press blind — and by then it had already pressed
 * twice, leaving a live session in a mode nobody chose. `cycleMode` in
 * `src/server/control.ts` carries the full reasoning.
 *
 * A press is now the same act the CLI's own Shift+Tab performs, which is also
 * what Shift+Tab in the composer does, so all three do literally one thing.
 *
 * Shared by the composer strip and the detail panel rather than written twice.
 * The select existed in both, was fixed in one, and stayed broken in the other
 * two clicks away — the same drift `useHeldChoice` was extracted to stop.
 */
export function ModeButton({ agent, size = 'regular' }: { agent: Agent; size?: ModeButtonSize }) {
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
  const heldMode = useStore((s) => s.heldMode)
  const setHeldMode = useStore((s) => s.setHeldMode)
  /*
   * What the user just moved to, until the agent reports it back.
   *
   * Kept in the store rather than in this component because two of these are
   * on screen at once — the composer strip and the detail panel's control row.
   * Held locally, pressing one left the other showing the old mode two inches
   * away until the enricher caught up (see `heldMode` in `store.ts`).
   *
   * A hold belonging to another agent is not this one's, and the agent
   * reporting the held value is what ends the hold.
   */
  const held =
    heldMode !== null && heldMode.sessionId === agent.sessionId && heldMode.mode !== agent.permissionMode
      ? heldMode.mode
      : undefined
  const mode = held ?? agent.permissionMode ?? ''
  /*
   * The press went out and the session has not written a mode down yet. Held
   * separately from the mode itself because it is a different claim: not "it is
   * now plan" but "something moved and this app cannot see what" (INV-11).
   */
  const [unreported, setUnreported] = useState(false)

  // The agent reported something, so this app can see again.
  useEffect(() => {
    setUnreported(false)
  }, [agent.permissionMode, agent.sessionId])

  /*
   * Permitted while the agent is working, and INV-8 says why: this sends a
   * control key rather than typing into the prompt. Deciding "this next step
   * should run in plan mode" happens *while* the agent is running, which is
   * the only time it matters.
   */
  const disabled = !agent.paneId || pending

  /*
   * INV-8's distinction, and it is the whole of what a press has to say. A
   * reading that moved names the mode it landed in. A reading that did not is
   * *unobserved*, not failed: the key reached the pane, so only the observation
   * is missing, and calling that a failure asserts something nobody checked
   * (INV-11).
   */
  const reportOutcome = (result: ControlResponse): void => {
    if (!result.ok) {
      showToast(t('controlFailed', { error: result.error }))
      return
    }
    if (result.detail === undefined || result.detail === 'unverified') {
      setUnreported(true)
      showToast(t('modeUnverified'))
      return
    }
    setUnreported(false)
    setHeldMode(agent.sessionId, result.detail)
    showToast(t('modeSwitched', { mode: t(MODE_KEY[result.detail] ?? 'modeDefault') }))
  }

  const press = (): void => {
    if (sendingRef.current || disabled) return
    sendingRef.current = true
    setPending(true)
    void (async () => {
      try {
        reportOutcome(await cycleAgentMode())
      } finally {
        sendingRef.current = false
        setPending(false)
      }
    })()
  }

  const named = mode ? t(MODE_KEY[mode] as Key) : undefined
  /*
   * `⇧⇥ Plan` does not say what pressing it will do, and a sighted user cannot
   * infer it from the glyph alone. Both halves are spelt out — the same reason
   * the goal toggle carries its own aria-label rather than leaning on a
   * pressed state.
   */
  const label = named
    ? t('modeCycleAction', { mode: named })
    : t('modeCycleUnknownAction')

  return (
    <button
      type="button"
      className={size === 'compact' ? `${styles.mode} ${styles.compact}` : styles.mode}
      data-testid="mode-cycle"
      data-unreported={unreported}
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={press}
    >
      <span aria-hidden="true" className={styles.kbd}>
        ⇧⇥
      </span>
      <span className={styles.name}>
        {unreported ? t('modePressed') : (named ?? t('modeUnknown'))}
      </span>
    </button>
  )
}
