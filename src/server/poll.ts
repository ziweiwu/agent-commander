/**
 * A repeat that paces itself.
 *
 * INV-4, in as many words: "a poll cannot overlap itself or outrun its own
 * cost. Every loop re-arms after the work completes rather than on a fixed
 * interval, and never schedules the next read sooner than the last one took."
 *
 * `setInterval` does neither. It fires on a wall-clock cadence whether or not
 * the previous pass returned, so on a loaded machine the passes stack up and
 * the poll that was meant to *bound* cost becomes the thing driving it. The
 * usual patch — a `#running` boolean that returns early — stops the overlap
 * but not the cause: ticks are then dropped silently, at a rate nobody chose
 * and nothing reports. That is what `pane-hub.ts` was written to fix for the
 * pane loop, and three other loops in this server were still doing it.
 *
 * Re-arming after the work does both jobs at once. Overlap is impossible
 * because there is no timer while a pass is in flight, and a pass that takes
 * longer than its interval simply backs its own cadence off instead of running
 * back-to-back.
 */
export class Poller {
  #timer: NodeJS.Timeout | null = null
  #stopped = true

  /**
   * @param intervalMs the floor between passes; the real gap is the greater of
   *   this and how long the last pass actually took.
   * @param work one pass. Rejections are swallowed — see `#run`.
   */
  constructor(
    private readonly intervalMs: number,
    private readonly work: () => Promise<void>,
  ) {}

  /** True between `start()` and `stop()`, whether or not a pass is in flight. */
  get active(): boolean {
    return !this.#stopped
  }

  /**
   * Begin the chain. Starting an already-started poller is a no-op rather than
   * a second chain — two chains on one loop is exactly the duplication this
   * class exists to prevent, and it hides behind a single timer handle.
   *
   * `immediate` runs the first pass now instead of one interval from now.
   */
  start(immediate = false): void {
    if (!this.#stopped) return
    this.#stopped = false
    if (immediate) void this.#run()
    else this.#arm(this.intervalMs)
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #arm(delay: number): void {
    const timer = setTimeout(() => void this.#run(), delay)
    // Never hold the process open on a poller's account; whatever owns the
    // program decides that.
    timer.unref?.()
    this.#timer = timer
  }

  async #run(): Promise<void> {
    if (this.#stopped) return
    this.#timer = null
    const started = Date.now()
    try {
      await this.work()
    } catch {
      // INV-5: a failed pass is not a reason to stop polling. The next one may
      // well succeed, and a loop that gave up would leave whatever it feeds
      // frozen with no indication that it had.
    }
    // Re-checked after the await: `stop()` during a pass must not be undone by
    // the re-arm that pass is about to do.
    if (this.#stopped) return
    this.#arm(Math.max(this.intervalMs, Date.now() - started))
  }
}
