import { useEffect, useState } from 'react'
import type { RateLimits, StopCause } from '../../shared/types.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { inScope } from '../lib/filter.ts'
import { clock, countdownParts, dayMark, limitsStale, usageLevel } from '../lib/format.ts'
import { formatDay, formatUptime, type Key, type Lang } from '../lib/i18n.ts'
import { STOP_CAUSE_KEY, stoppedGroup, type StoppedGroup } from '../lib/stopped.ts'
import { useStore } from '../store/store.ts'
import styles from './StoppedStrip.module.css'

/** The strip's own sentence moves by the minute, as the countdown it quotes does. */
const RECHECK_MS = 60_000

/**
 * What the strip tells the owner to do, per cause. One entry, and one string
 * in `i18n.ts` behind it, so that cutting the instruction is deleting both.
 */
const ADVICE: Partial<Record<StopCause, Key>> = {
  authentication_failed: 'stoppedStripSignInAdvice',
}

/**
 * The five-hour reset, when that window is the one that ran out.
 *
 * A limit is also what the weekly window hits, and quoting the five-hour clock
 * then would have the owner wait for a reset that changes nothing, so the
 * window has to read as spent, freshly, and with a reset still to come.
 */
function resetsIn(cause: StopCause, limits: RateLimits | null, now: number) {
  if (cause !== 'rate_limit' || !limits || limitsStale(limits, now)) return null
  const window = limits.fiveHour
  if (!window || usageLevel(window.pct) !== 'critical') return null
  return countdownParts(window.resetsAt, now)
}

/** "11:18", or with its day once that is not today. */
function sinceLabel(lang: Lang, stoppedAt: number): string {
  const mark = dayMark(stoppedAt)
  return mark.kind === 'today' ? clock(stoppedAt) : `${formatDay(lang, mark)} ${clock(stoppedAt)}`
}

function StripButton({ group, lens }: { group: StoppedGroup; lens: StopCause | undefined }) {
  const pressed = lens === group.cause
  const t = useTranslate()
  const lang = useLang()
  const limits = useStore((s) => s.limits)
  const setStopped = useStore((s) => s.setStopped)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), RECHECK_MS)
    return () => window.clearInterval(id)
  }, [])

  const left = resetsIn(group.cause, limits, now)
  const advice = ADVICE[group.cause]
  const sentences = [
    t('stoppedStrip', {
      count: group.count,
      cause: t(STOP_CAUSE_KEY[group.cause]),
      since: sinceLabel(lang, group.since),
    }),
    left && t('stoppedStripResets', { t: formatUptime(lang, left) }),
    advice && t(advice),
    t(pressed ? 'stoppedStripShowAll' : 'stoppedStripShowOnly'),
  ].filter(Boolean)

  return (
    <button
      type="button"
      className={styles.strip}
      data-testid="stopped-strip"
      data-cause={group.cause}
      aria-pressed={pressed}
      onClick={() => setStopped(pressed ? undefined : group.cause)}
    >
      {sentences.join(lang === 'zh-CN' ? '' : ' ')}
    </button>
  )
}

/**
 * "3 agents stopped: sign-in failed since 11:18. Sign in again, then message
 * them." above the list, when more than one card is stopped for one reason.
 *
 * Over the whole fleet in scope rather than the filtered view, because it says
 * what happened to the fleet and a search term does not change that. Not drawn
 * while the socket is down: with the fleet a memory, an instruction about now
 * is a claim this app cannot make (INV-11).
 *
 * Tapping it is a read, and it filters; neither it nor anything it leads to
 * sends a message, which stays the owner's act in the agent's own composer (INV-2).
 */
export function StoppedStrip() {
  const live = useStore((s) => s.conn === 'open')
  const agents = useStore((s) => s.agents)
  const fleet = useStore((s) => s.fleet)
  const group = live ? stoppedGroup(inScope(agents, fleet)) : null
  if (!group) return null
  return <StripButton group={group} lens={fleet.stopped} />
}
