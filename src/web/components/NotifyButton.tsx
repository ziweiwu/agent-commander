import { useStore } from '../store/store.ts'
import { saveNudgeDismissed } from '../lib/prefs.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useNotifyToggle } from '../hooks/useNotifyToggle.ts'
import { Button } from './ui/Button.tsx'
import styles from './NotifyButton.module.css'

/**
 * The bell: whether this app may reach out of its tab when an agent needs you.
 *
 * It was a row inside the settings menu, behind an icon that reads everywhere
 * else as a theme toggle, and nothing on screen said the setting existed. The
 * whole product rests on "an agent needs you" being worth walking across the
 * room for, and the switch that makes that true should not depend on
 * curiosity. So it is its own control, beside the status filters, with its
 * state in its shape: the bell is struck through while it is off.
 */
export function NotifyButton() {
  const t = useTranslate()
  const { notify, hint, supported, toggle } = useNotifyToggle()
  const showToast = useStore((s) => s.showToast)
  const label = notify ? t('notifyOn') : t('notifyOff')
  const reason = hint === 'denied' ? t('notifyDenied') : hint === 'unsupported' ? t('notifyUnsupported') : ''

  return (
    <Button
      variant="icon"
      className={styles.bell}
      data-testid="notify-toggle"
      data-state={supported ? (notify ? 'on' : 'off') : 'unsupported'}
      aria-pressed={notify}
      aria-label={label}
      title={reason || label}
      disabled={!supported}
      onClick={() => void toggle().then(announceRefusal)}
    >
      <Bell state={notify ? 'on' : 'off'} />
    </Button>
  )

  /** A refusal is said out loud, not left as a bell that did not move. */
  function announceRefusal(): void {
    if (useStore.getState().notify || !supported) return
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      showToast(t('notifyDenied'))
    }
  }
}

/** A bell, struck through when off. `currentColor` so it follows the theme. */
function Bell({ state }: { state: 'on' | 'off' }) {
  const off = state === 'off'
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5v3.2L4 13v1h12v-1l-1.5-2.8V7A4.5 4.5 0 0 0 10 2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 16a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {off && <path d="M3 17 17 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  )
}

/**
 * The one unsolicited prompt in the app.
 *
 * Raised only after this page watched an agent become blocked while
 * notifications were off — never on load, never for the backlog, never twice
 * once waved away (INV-14). It sits under the header where the blocked agent
 * itself just appeared, so the suggestion arrives beside its evidence.
 */
export function NotifyNudge() {
  const t = useTranslate()
  const nudge = useStore((s) => s.notifyNudge)
  const setNudge = useStore((s) => s.setNotifyNudge)
  const { toggle } = useNotifyToggle()
  if (!nudge) return null

  const dismiss = (): void => {
    saveNudgeDismissed()
    setNudge(false)
  }

  return (
    <div className={styles.nudge} data-testid="notify-nudge" role="status">
      <span>{t('notifyNudge')}</span>
      <Button variant="compact" data-testid="notify-nudge-on" onClick={() => void toggle()}>
        {t('notifyNudgeOn')}
      </Button>
      <Button variant="compact" data-testid="notify-nudge-dismiss" onClick={dismiss}>
        {t('notifyNudgeDismiss')}
      </Button>
    </div>
  )
}
