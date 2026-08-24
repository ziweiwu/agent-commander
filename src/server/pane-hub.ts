/**
 * One poll per pane, however many browser tabs are watching it.
 *
 * Two problems this solves, both of which got worse the more the app was used.
 *
 * The first is duplication. Polling used to hang off the `Viewer` — one timer
 * per WebSocket — so two tabs open on the same agent asked tmux for the same
 * pane twice as often, and a phone and a laptop looking at the same blocked
 * agent doubled the load on the one thing that was already the bottleneck.
 * Subscribers now share a single read and each still computes its own delta,
 * which is what keeps them independent: a tab that attached ten seconds ago
 * and one that attached just now need different frames from the same capture.
 *
 * The second is cadence. A fixed `setInterval(140)` assumes the work fits in
 * the interval. It did not: two tmux round trips measured p50 141ms, so the
 * timer was permanently behind and the `frameBusy` guard silently dropped
 * ticks — the terminal ran at a rate nobody chose and nothing reported. The
 * loop here re-arms only *after* a read completes, so it cannot pile up, and
 * it never schedules the next read sooner than the last one took, which caps
 * this app at half the wall clock of whatever tmux can actually deliver.
 *
 * On top of that it backs off when nothing is happening. An agent thinking for
 * two minutes redraws a spinner; an agent waiting at a prompt redraws nothing
 * at all, and polling it seven times a second is pure waste. Any change at all
 * snaps the cadence back to full speed, so the backoff costs latency only on
 * the frame that ends a quiet spell.
 */
import type { PaneMeta } from './pane.ts'
import type { PaneApi } from './sources.ts'

export interface Sample {
  meta: PaneMeta
  lines: string[]
}

export type HubEvent = { sample: Sample; error?: never } | { sample?: never; error: Error }
export type Listener = (event: HubEvent) => void

/** Full speed: the cadence the Attach view is designed to look live at. */
export const BASE_MS = 140
/** The slowest a pane is polled once it has stopped changing. */
export const MAX_MS = 1_000
/** How fast the backoff grows across consecutive unchanged reads. */
const IDLE_GROWTH = 1.5

/**
 * How long a pane stays at full speed after this app writes to it.
 *
 * A write and the redraw it causes are not simultaneous. tmux accepts the
 * paste, the program in the pane then decides to draw something, and a shell
 * or a TUI can take a few tens of milliseconds to get round to it. Without
 * this window the first read after a write usually lands *before* the echo,
 * finds the pane unchanged, and takes that as evidence the pane is quiet — so
 * it backs off, and the read that finally catches the echo is a whole extra
 * interval away. Measured end to end, that turned a ~90ms keystroke into a
 * ~224ms one, which is precisely the sluggishness this file exists to remove.
 */
const HOT_MS = 1_000

/**
 * How often to look while an echo is expected.
 *
 * Not `BASE_MS`. The steady cadence is chosen for a pane redrawing on its own,
 * where a seventh of a second is imperceptible; it is far too slow for the one
 * case where the user is watching for a specific character they just typed.
 * Measured through the browser, a keystroke's write finished in ~4ms and the
 * frame carrying its echo arrived at ~146ms — the whole of that gap was this
 * loop waiting out a full `BASE_MS` after the one read that was a fraction too
 * early to see it.
 *
 * A read is cheap enough to afford this: ~0.4ms through the control client on
 * a quiet server. On a busy one the duty-cycle floor below — never re-read
 * sooner than the last read took — pulls the real rate back by itself, so this
 * is a ceiling on eagerness rather than a promise of 40Hz.
 */
const HOT_INTERVAL_MS = 25

function sameLines(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return false
  for (let row = 0; row < before.length; row += 1) {
    if (before[row] !== after[row]) return false
  }
  return true
}

function unchanged(before: Sample, after: Sample): boolean {
  return (
    before.meta.cursorX === after.meta.cursorX &&
    before.meta.cursorY === after.meta.cursorY &&
    before.meta.rows === after.meta.rows &&
    before.meta.cols === after.meta.cols &&
    sameLines(before.lines, after.lines)
  )
}

class PaneLoop {
  readonly listeners = new Set<Listener>()
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  #interval = BASE_MS
  #last: Sample | null = null
  /** While this is in the future, an unchanged read does not slow the loop. */
  #hotUntil = 0
  /**
   * A read is in flight, so there is no timer to cancel.
   *
   * Distinct from `#active`: this is about the current read, that is about the
   * chain of them.
   */
  #running = false
  /**
   * A tick chain exists — a read is in flight, or one is scheduled.
   *
   * Without this, `start()` could not tell "no chain yet" from "a chain whose
   * read is in flight", because both leave `#timer` null. Every subscriber
   * arriving during a read therefore began a *second* chain on the same loop,
   * and since each chain arms its own timeout and nothing cancels the others,
   * they all survived. The pane was then polled once per subscriber — exactly
   * the duplication this class exists to remove, hidden behind a `size` of 1.
   * Measured: three viewers on one pane cost three times the tmux traffic of
   * one, while the hub reported a single loop.
   */
  #active = false
  /** A wake arrived mid-read, so the next read must not wait its turn. */
  #wakePending = false

  constructor(
    private readonly paneId: string,
    private readonly read: (paneId: string) => Promise<Sample>,
  ) {}

  /** The most recent read, so a tab that attaches mid-flight paints at once. */
  get last(): Sample | null {
    return this.#last
  }

  /**
   * Go back to full speed now, cancelling any backoff already being slept off.
   *
   * Lowering the interval alone is not enough: a loop that has backed off to a
   * second is *already* inside that second, so the next read would still be up
   * to a second away. That is exactly the wrong moment to be slow — the two
   * callers are a tab that has just opened the terminal and a user who has
   * just typed into it, and both are waiting to see something happen.
   *
   * `hot` separates those two. A write is a promise that the pane is about to
   * change, so for a moment afterwards an unchanged read means "not yet",
   * not "quiet", and must not slow the loop down. A tab merely attaching
   * promises nothing, so it gets the fast read it needs and then lets the
   * pane's own behaviour decide the cadence.
   */
  wake(hot: boolean): void {
    if (this.#stopped) return
    this.#interval = BASE_MS
    if (hot) this.#hotUntil = Date.now() + HOT_MS

    /*
     * A read already running is the awkward case, and the common one: reads
     * take tens of milliseconds and the loop is rarely idle, so a write very
     * often completes while one is in flight. That read was started before the
     * write landed, so it cannot contain the echo -- and there is no timer to
     * cancel, which meant `wake` quietly did nothing and the echo waited for
     * the *next* scheduled read. Measured end to end that was the difference
     * between a 37ms keystroke and a 224ms one, depending purely on where in
     * the cycle the keypress fell. Flagging it here makes the read that
     * follows start immediately instead.
     */
    if (this.#running) {
      this.#wakePending = true
      return
    }
    if (!this.#timer) return
    clearTimeout(this.#timer)
    this.#timer = null
    void this.#tick()
  }

  start(): void {
    if (this.#stopped || this.#active) return
    this.#active = true
    void this.#tick()
  }

  stop(): void {
    this.#stopped = true
    this.#active = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.listeners.clear()
  }

  async #tick(): Promise<void> {
    if (this.#stopped) {
      this.#active = false
      return
    }
    this.#timer = null
    this.#running = true
    const started = Date.now()

    let event: HubEvent
    try {
      const sample = await this.read(this.paneId)
      if (!this.#last || !unchanged(this.#last, sample)) {
        this.#interval = BASE_MS
        // The redraw this loop was hurrying for has arrived, so stop
        // hurrying. Left running, every keystroke would buy a further
        // second of fast polling that nothing is waiting on.
        this.#hotUntil = 0
      } else if (Date.now() >= this.#hotUntil) {
        // Unchanged, and nothing has been typed recently enough to expect a
        // redraw. Only now is "quiet" the right conclusion.
        this.#interval = Math.min(MAX_MS, Math.round(this.#interval * IDLE_GROWTH))
      }
      this.#last = sample
      event = { sample }
    } catch (err) {
      // The loop keeps running. Whether a failure is fatal is the subscriber's
      // call, not this loop's: a pane that has exited is over, but a tmux that
      // could not be reached for one tick is not, and treating those the same
      // is what used to stop a terminal for good over a transient EAGAIN.
      event = { error: err instanceof Error ? err : new Error(String(err)) }
    }

    this.#running = false
    if (this.#stopped) {
      this.#active = false
      return
    }
    // Iterated live rather than over a copy. A listener that unsubscribes a
    // *different* one mid-delivery — the tab that answers a dead pane by
    // tearing down its neighbour — should stop that one being called, and a
    // Set iterator gives exactly that. Delivering from a snapshot would call
    // a listener that had just been released.
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // One subscriber's failure is not the others' problem.
      }
    }

    if (this.#stopped || this.listeners.size === 0) {
      // The chain ends here; the next `start()` may begin a new one.
      this.#active = false
      return
    }

    // Never start the next read sooner than the last one took. Under load that
    // is what stops the app adding to the congestion it is already waiting on.
    // A wake that arrived mid-read is the one exception: the pane has just been
    // written to, the user is watching for the echo, and this is a single
    // catch-up read rather than a faster steady state -- the coalescing keeps
    // one write in flight per tab, so wakes are already paced by tmux itself.
    const elapsed = Date.now() - started
    // While an echo is outstanding the loop runs at `HOT_INTERVAL_MS`; the
    // duty-cycle floor still applies, so a slow tmux slows this down too.
    const interval = Date.now() < this.#hotUntil ? HOT_INTERVAL_MS : this.#interval
    const delay = this.#wakePending ? 0 : Math.max(interval, elapsed)
    this.#wakePending = false
    this.#timer = setTimeout(() => void this.#tick(), delay)
    this.#timer.unref?.()
  }
}

export class PaneHub {
  #loops = new Map<string, PaneLoop>()

  constructor(private readonly panes: PaneApi) {}

  /**
   * A pane read, from whichever of the two shapes the adapter offers.
   *
   * `sample` is one tmux round trip and is what the real adapter implements;
   * the meta-then-capture pair is kept for the mocks and for tests that stand
   * in their own pane API, which have no round trip to save.
   */
  #read = async (paneId: string): Promise<Sample> => {
    if (this.panes.sample) return this.panes.sample(paneId)
    const meta = await this.panes.meta(paneId)
    const lines = await this.panes.capture(paneId, meta.rows)
    return { meta, lines }
  }

  /** How many panes are being polled. Read by the tests and the benchmark. */
  get size(): number {
    return this.#loops.size
  }

  /**
   * Poll this pane at full speed again, because something just changed it.
   *
   * Called when this app writes to a pane. The backoff assumes that a pane
   * that has not changed in a while will go on not changing, and a keystroke
   * is precisely the evidence that it is about to — without this, typing into
   * an agent sitting quietly at its prompt waited out the idle interval before
   * the character appeared, which is the latency this whole file exists to
   * remove.
   */
  wake(paneId: string): void {
    this.#loops.get(paneId)?.wake(true)
  }

  subscribe(paneId: string, listener: Listener): () => void {
    let loop = this.#loops.get(paneId)
    if (!loop) {
      loop = new PaneLoop(paneId, this.#read)
      this.#loops.set(paneId, loop)
    }
    loop.listeners.add(listener)
    loop.wake(false)

    // A tab joining a pane someone else is already watching gets the last read
    // immediately rather than waiting out the current interval. Deferred by a
    // microtask so the caller holds this unsubscribe handle before its
    // listener can run.
    const cached = loop.last
    if (cached) queueMicrotask(() => listener({ sample: cached }))
    loop.start()

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.#loops.get(paneId)
      if (!current) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      // The last watcher left. Drop the cache with the loop: whatever it holds
      // is about to go stale, and a later attach must repaint from a fresh
      // read rather than from whatever was on screen minutes ago.
      current.stop()
      this.#loops.delete(paneId)
    }
  }

  stop(): void {
    for (const loop of this.#loops.values()) loop.stop()
    this.#loops.clear()
  }
}
