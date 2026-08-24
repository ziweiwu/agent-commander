/**
 * INV-4: "a poll cannot overlap itself or outrun its own cost. Every loop
 * re-arms after the work completes rather than on a fixed interval, and never
 * schedules the next read sooner than the last one took."
 *
 * That rule was written once and implemented four times — once properly in
 * `registry.ts`, and three times as `setInterval` plus a busy flag, which stops
 * the overlap but converts an overrun into silently dropped ticks. `Poller` is
 * the rule in one place; this is the rule as a test.
 */
import { describe, expect, it } from 'vitest'
import { Poller } from '../src/server/poll.ts'

const settle = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

describe('INV-4 Poller', () => {
  it('does not start the next pass until the last one has finished', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let passes = 0
    const poller = new Poller(10, async () => {
      inFlight += 1
      passes += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await settle(40)
      inFlight -= 1
    })

    poller.start(true)
    await settle(200)
    poller.stop()

    expect(maxInFlight).toBe(1)
    // Work of 40ms on a 10ms interval: paced by the work, so nothing like the
    // ~20 passes a `setInterval(10)` would have attempted.
    expect(passes).toBeLessThan(6)
    expect(passes).toBeGreaterThan(1)
  })

  it('never schedules sooner than the last pass took', async () => {
    const starts: number[] = []
    const poller = new Poller(5, async () => {
      starts.push(Date.now())
      await settle(50)
    })

    poller.start(true)
    await settle(220)
    poller.stop()

    expect(starts.length).toBeGreaterThan(1)
    for (let i = 1; i < starts.length; i += 1) {
      // The floor is how long the work takes, not the configured interval.
      // Timers fire late, never early, so a small tolerance is one-sided.
      expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(45)
    }
  })

  it('keeps going after a pass throws', async () => {
    let passes = 0
    const poller = new Poller(5, async () => {
      passes += 1
      throw new Error('nope')
    })

    poller.start(true)
    await settle(60)
    poller.stop()

    // INV-5: a failed pass is not a reason to stop polling.
    expect(passes).toBeGreaterThan(2)
  })

  it('stops for good, including from inside a pass', async () => {
    let passes = 0
    const poller: Poller = new Poller(5, async () => {
      passes += 1
      await settle(10)
      poller.stop()
    })

    poller.start(true)
    await settle(100)
    const after = passes
    await settle(60)

    // The re-arm that pass was about to do must not undo the stop.
    expect(passes).toBe(after)
    expect(passes).toBe(1)
  })

  it('refuses to run two chains for one loop', async () => {
    let passes = 0
    const poller = new Poller(20, async () => {
      passes += 1
    })

    poller.start(true)
    poller.start(true)
    poller.start(true)
    await settle(70)
    poller.stop()

    // Three chains on one loop is the duplication `PaneHub` was written to
    // remove; it hides behind a single timer handle, so it is asserted here.
    expect(passes).toBeLessThanOrEqual(5)
  })

  it('waits an interval before the first pass unless asked not to', async () => {
    let eager = 0
    let patient = 0
    const a = new Poller(60, async () => {
      eager += 1
    })
    const b = new Poller(60, async () => {
      patient += 1
    })

    a.start(true)
    b.start()
    await settle(20)
    a.stop()
    b.stop()

    expect(eager).toBe(1)
    expect(patient).toBe(0)
  })
})
