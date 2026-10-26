import { useStore } from '../store/store.ts'
import { nextWaiting, othersWaiting } from '../lib/hop.ts'
import { displayName } from '../lib/naming.ts'
import { relative, uptimeParts } from '../lib/format.ts'
import { formatRelative, formatUptime } from '../lib/i18n.ts'
import { useLang, useTranslate, type Translate } from '../hooks/useTranslate.ts'
import type { Agent } from '../../shared/types.ts'
import { useHop } from '../hooks/useHop.ts'
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
 * Tapping it opens the next one in the list's order on its conversation, by a
 * hop (`useHop`): replacing the history entry, so swipe-back still lands on the
 * fleet, and focusing the question rather than its first option.
 *
 * **Offline it says when, not now (INV-11).** With the socket down the count is
 * a memory; the chip goes muted — the plain chip's own colours, the waiting
 * wash withdrawn — and says "as of" the last frame, the way the fleet's stale
 * caption does. It still opens the agent, which is a read: what is on the other
 * side carries its own offline state.
 */
export function WaitingChip() {
  const t = useTranslate()
  const lang = useLang()
  const hop = useHop()
  const agents = useStore((s) => s.agents)
  const selected = useStore((s) => s.selected)
  const exited = useStore((s) => s.exited)
  const sort = useStore((s) => s.fleet.sort)
  const dir = useStore((s) => s.fleet.dir)
  const live = useStore((s) => s.conn === 'open')
  const fleetAt = useStore((s) => s.fleetAt)

  const next = nextWaiting(agents, selected, { sort, dir }, exited)
  if (!next) return null
  const count = othersWaiting(agents, selected, exited).length
  const when = formatRelative(lang, relative(fleetAt ?? undefined))
  const asOf = live ? '' : t('waitingChipAsOf', { when })
  const age = formatUptime(lang, uptimeParts(next.lastActivityAt))
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
      {asOf && <span className={styles.asOf}>{asOf}</span>}
    </button>
  )
}
