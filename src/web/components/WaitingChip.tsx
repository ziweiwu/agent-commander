import { useStore } from '../store/store.ts'
import { nextUp, othersWaiting } from '../lib/hop.ts'
import { displayName } from '../lib/naming.ts'
import { relative, uptimeParts } from '../lib/format.ts'
import { formatRelative, formatUptime } from '../lib/i18n.ts'
import { useLang, useTranslate, type Translate } from '../hooks/useTranslate.ts'
import type { Agent } from '../../shared/types.ts'
import { useHop } from '../hooks/useHop.ts'
import { useOfflineClock } from '../hooks/useOfflineClock.ts'
import { ICON_MARK, Icon } from './ui/Icon.tsx'
import styles from './WaitingChip.module.css'

/** "2 other agents need you — open «name», waiting 14m", and when it was true if not now. */
function accessibleName(
  translateKey: Translate,
  { count, next, age, asOf }: { count: number; next: Agent; age: string; asOf: string },
): string {
  return [
    translateKey(count === 1 ? 'waitingChipOne' : 'waitingChipMany', { count, name: displayName(next) }),
    age ? translateKey('waitingChipAge', { age }) : '',
    asOf ? ` (${asOf})` : '',
  ].join('')
}

export interface WaitingChipProps {
  /**
   * Drawn in the phone's sheet, whose topbar is one row that must not grow.
   * There the connection pill says since when on screen, so the chip keeps its
   * "as of" in its accessible name only: drawn as well, it took the chip from
   * 64px to 147px and pushed the row over (FR-NOTIFY-10).
   */
  sheet?: boolean
}

/**
 * "✋ 2 ›": how many *other* agents need you, and the way to the next of them.
 *
 * It exists for the shapes where the list is off the screen while an agent is
 * open — the phone's sheet, a collapsed column, full screen — because there the
 * waiting group is the one thing this app is for and nothing on screen says it.
 * Where the list is visible it is not drawn: the group at the top of it already
 * says this, and saying it twice is the noise FR-CTL-12 removes.
 *
 * Absent at zero rather than reading "0": a chip that is always there is one
 * the eye learns to skip, and the day it matters it would be skipped too.
 *
 * Tapping it opens `nextUp` — the agent the Next button and ⌥H open too — on
 * its conversation, by a hop (`useHop`): replacing the history entry, so
 * swipe-back still lands on the fleet, and focusing the question rather than
 * its first option.
 *
 * **Offline it says when, not now (INV-11).** With the socket down the count is
 * a memory; the chip goes muted — the plain chip's own colours, the waiting
 * wash withdrawn — and says "as of" the last frame, the way the fleet's stale
 * caption does, aged by `useOfflineClock` because no frame will age it. It
 * still opens the agent, which is a read: what is on the other side carries its
 * own offline state.
 */
export function WaitingChip({ sheet }: WaitingChipProps) {
  const t = useTranslate()
  const lang = useLang()
  const hop = useHop()
  const agents = useStore((s) => s.agents)
  const selected = useStore((s) => s.selected)
  const exited = useStore((s) => s.exited)
  const live = useStore((s) => s.conn === 'open')
  const fleetAt = useStore((s) => s.fleetAt)
  const now = useOfflineClock()

  const next = nextUp(agents, selected, exited)
  if (!next) return null
  const count = othersWaiting(agents, selected, exited).length
  const when = formatRelative(lang, relative(fleetAt ?? undefined, now))
  const asOf = live ? '' : t('waitingChipAsOf', { when })
  const age = formatUptime(lang, uptimeParts(next.lastActivityAt, now))
  const name = accessibleName(t, { count, next, age, asOf })

  return (
    <button
      type="button"
      className={styles.chip}
      data-testid="waiting-chip"
      data-stale={live ? undefined : 'true'}
      aria-label={name}
      title={name}
      onClick={() => hop(next.sessionId, 'chat')}
    >
      <Icon name="hand" size={ICON_MARK} />
      <b>{count}</b>
      <span aria-hidden="true">›</span>
      {asOf && !sheet && <span className={styles.asOf}>{asOf}</span>}
    </button>
  )
}
