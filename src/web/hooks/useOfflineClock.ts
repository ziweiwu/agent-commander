import { useEffect, useReducer } from 'react'
import { useStore } from '../store/store.ts'

/** How often an offline caption is redrawn while `relative` still reads it in seconds. */
export const OFFLINE_TICK_MS = 10_000
/** How often once it reads in minutes, which is all the precision it shows from then on. */
export const OFFLINE_SLOW_TICK_MS = 60_000
/** How long after the socket drops the faster cadence lasts: `relative`'s seconds band. */
const SECONDS_BAND_MS = 60_000

/** The wait before the next redraw, `sinceDown` ms after the socket went down. */
export function offlineTickDelay(sinceDown: number): number {
  return sinceDown < SECONDS_BAND_MS ? OFFLINE_TICK_MS : OFFLINE_SLOW_TICK_MS
}

/**
 * The time to age an "as of" caption against, redrawn while the socket is down.
 *
 * Every caption that says when the fleet was last heard computes
 * `relative(fleetAt, now)` as it renders, and what makes it render is a frame.
 * With the socket down no frame comes, so "as of just now" went on saying "just
 * now" for as long as the outage lasted — measured to 130 s on a phone — which
 * is INV-11's failure in the one caption that exists to prevent it. This is the
 * render the missing frame would have caused.
 *
 * Nothing runs while connected. The timer is armed when `conn` leaves `open` and
 * cleared the moment it returns, so it costs nothing against INV-4 or the idle
 * energy budget, and it makes no request: it only redraws. A timeout re-armed
 * after each tick rather than an interval, so the cadence can slow to a minute
 * once the caption counts minutes.
 */
export function useOfflineClock(): number {
  const offline = useStore((s) => s.conn !== 'open')
  const [, redraw] = useReducer((ticks: number) => ticks + 1, 0)
  useEffect(() => {
    if (!offline) return
    const downAt = Date.now()
    let timer = window.setTimeout(function tick() {
      redraw()
      timer = window.setTimeout(tick, offlineTickDelay(Date.now() - downAt))
    }, offlineTickDelay(0))
    return () => window.clearTimeout(timer)
  }, [offline])
  return Date.now()
}
