import { useEffect, useState } from 'react'
import { countdownParts, limitsStale, usageLevel } from '../lib/format.ts'
import { formatRelative, formatUptime } from '../lib/i18n.ts'
import { relative } from '../lib/format.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { useStore } from '../store/store.ts'
import type { UsageWindow } from '../../shared/types.ts'
import styles from './UsageChips.module.css'

/**
 * Claude.ai subscription quota — the 5-hour session window and the 7-day week.
 *
 * This is account-level, not per-agent, which is why it lives in the topbar
 * rather than on a card. It is also the one number here that decides whether
 * any of the agents below can keep working at all.
 *
 * Hidden outright when there is no reading. `rate_limits` is absent for
 * API-key users and for anyone not on a subscription, and an empty meter
 * reading 0% would be a lie told permanently to a user who can never fill it.
 * A reading that has merely gone *stale* is a different claim and gets a
 * different treatment — see below.
 */
export function UsageChips() {
  const limits = useStore((s) => s.limits)

  /*
   * The countdown has to keep counting. Everything else here re-renders on a
   * server broadcast, but this file only changes when some Claude Code session
   * renders its footer, and on a quiet machine that can be an hour apart.
   * A minute is the resolution shown, so a minute is the tick.
   */
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  if (!limits) return null
  const stale = limitsStale(limits)

  return (
    <div className={styles.chips} data-testid="usage-chips" data-stale={stale}>
      {limits.fiveHour && (
        <Meter labelKey="usageFiveHour" win={limits.fiveHour} at={limits.at} stale={stale} testid="usage-five-hour" />
      )}
      {limits.sevenDay && (
        <Meter labelKey="usageSevenDay" win={limits.sevenDay} at={limits.at} stale={stale} testid="usage-seven-day" />
      )}
    </div>
  )
}

interface MeterProps {
  labelKey: 'usageFiveHour' | 'usageSevenDay'
  win: UsageWindow
  /** When the reading was taken, for the stale wording. */
  at: number
  stale: boolean
  testid: string
}

function Meter({ labelKey, win, at, stale, testid }: MeterProps) {
  const t = useTranslate()
  const lang = useLang()
  /*
   * Clamped here as well as at the server boundary. The percentage is written
   * straight into a CSS length, and `Infinity%` or `NaN%` is the kind of thing
   * that renders as a silently broken bar rather than an obvious error.
   */
  const pct = Number.isFinite(win.pct) ? Math.round(Math.max(0, Math.min(100, win.pct))) : 0
  const label = t(labelKey)

  const left = countdownParts(win.resetsAt)
  const reset = left ? t('usageResetsIn', { t: formatUptime(lang, left) }) : t('usageResetting')
  const age = t('usageStale', { t: formatRelative(lang, relative(at)) })
  // The chip is tight, so the inline form drops the framing words and keeps the
  // duration; the full sentence stays in the title and the accessible name.
  const short = left ? formatUptime(lang, left) : t('usageResetting')

  /*
   * A stale bar must not assert a current value to a screen reader, so
   * aria-valuenow is dropped and the label says when the number was true.
   * Sighted users get the same information from the dimmed styling plus the
   * title; this is the non-visual half of that.
   */
  const meterProps = stale
    ? { 'aria-label': t('usageStaleMeter', { label, n: pct, t: formatRelative(lang, relative(at)) }) }
    : { 'aria-label': t('usageMeter', { label, n: pct, reset }), 'aria-valuenow': pct }

  return (
    <span className={styles.chip} data-testid={testid} title={`${label} · ${pct}% · ${stale ? age : reset}`}>
      {/*
        * Both labels are rendered and CSS picks one. A narrow screen still has
        * to say which window it is showing — two bare percentages side by side
        * are indistinguishable, and the title attribute is no help on touch.
        */}
      <span className={styles.label}>{label}</span>
      <span className={styles.labelShort} aria-hidden="true">{t(`${labelKey}Short`)}</span>
      {/*
        * `meter`, not `progressbar`. A progressbar models a task running to
        * completion; this is a level that fills and then refills at `resetsAt`,
        * which is the textbook `meter` case (the spec's own examples are disk
        * usage and battery). The distinction matters to the read: nobody wants
        * to "complete" their quota.
        */}
      <span
        className={styles.track}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        {...meterProps}
      >
        {/*
          * A floor of 2% so a barely-touched window still reads as a bar with a
          * little in it rather than as an empty track, which looks broken.
          */}
        <span
          className={styles.fill}
          data-level={usageLevel(pct)}
          style={{ inlineSize: `${Math.max(2, pct)}%` }}
        />
      </span>
      {/* The percentage is text, so colour is never the only carrier of state. */}
      <span className={styles.value}>{pct}%</span>
      {/*
        * Rendered, not just a `title`. A tooltip needs hover, and hover does
        * not exist on the phone and tablet widths where this row gets a line of
        * its own — the reset time was invisible to exactly the users with the
        * most room to show it.
        */}
      <span className={styles.reset}>{stale ? age : short}</span>
    </span>
  )
}
