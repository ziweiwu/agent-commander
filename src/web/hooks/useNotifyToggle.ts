import { useState } from 'react'
import { useStore } from '../store/store.ts'

export type NotifyHint = 'unsupported' | 'denied' | null

/**
 * The notification preference, and the honest reasons it can fail to turn on.
 *
 * iOS Safari outside an installed web app has no Notification constructor at
 * all, and a user who blocked the permission once will never see the browser
 * prompt again — in both cases a control that flipped on and did nothing would
 * be the app claiming an ability it does not have (INV-11). The hint says
 * which of the two happened.
 *
 * The permission prompt rides the click — the one moment a browser accepts the
 * request as intentional rather than ambient (INV-14).
 */
export function useNotifyToggle(): {
  notify: boolean
  hint: NotifyHint
  supported: boolean
  toggle: () => Promise<void>
} {
  const notify = useStore((s) => s.notify)
  const setNotify = useStore((s) => s.setNotify)
  const supported = typeof Notification !== 'undefined'
  const [hint, setHint] = useState<NotifyHint>(supported ? null : 'unsupported')

  const toggle = async (): Promise<void> => {
    if (notify) {
      setNotify(false)
      return
    }
    if (!supported) {
      setHint('unsupported')
      return
    }
    const permission = await Notification.requestPermission()
    if (permission === 'granted') {
      setHint(null)
      setNotify(true)
    } else {
      setHint('denied')
    }
  }

  return { notify, hint, supported, toggle }
}
