import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The attach view re-fits when the box it lives in changes shape.
 *
 * `rescale` used to run from exactly three places — mount, a frame whose
 * geometry changed, and the zoom controls — so a window dragged narrower, a
 * rotated phone, or a collapsing URL bar left the pane at the scale it was
 * given on mount. A quiet agent was the worst case: no redraw means no
 * geometry change, so nothing ever recovered it. These tests drive the
 * container size directly and assert the transform follows it with no frame
 * arriving at all.
 *
 * jsdom lays nothing out and has no `ResizeObserver`, so both are stubbed: the
 * observer records what it was asked to watch and hands back its callback, and
 * the measurements `rescale` reads are set on the elements by hand.
 */

type ResizeCallback = () => void

interface Observed {
  targets: Element[]
  callback: ResizeCallback
  disconnected: boolean
}

/** One observer per test; its `callback` is what a real one runs on a resize. */
const observers: Observed[] = []

function observer(): Observed {
  const only = observers[0]
  if (!only || observers.length !== 1) throw new Error(`expected one observer, got ${observers.length}`)
  return only
}

class FakeResizeObserver {
  #entry: Observed
  constructor(callback: ResizeCallback) {
    this.#entry = { targets: [], callback, disconnected: false }
    observers.push(this.#entry)
  }
  observe(target: Element): void {
    this.#entry.targets.push(target)
  }
  unobserve(): void {}
  disconnect(): void {
    this.#entry.disconnected = true
  }
}

/** Animation frames, run by hand so a test can count them. */
let frames: FrameRequestCallback[] = []
function runFrames(): void {
  // Frames queued while running belong to the next tick, so drain in rounds.
  while (frames.length) {
    const batch = frames
    frames = []
    for (const frame of batch) frame(0)
  }
}

function sized(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(element, 'offsetHeight', { value: height, configurable: true })
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: height, configurable: true })
}

/** A 1000×400 capture at the base font, drawn at whatever font xterm has now. */
const CAPTURE_WIDTH = 1000
const CAPTURE_HEIGHT = 400
const BASE_FONT = 13

/**
 * The layout the component builds: a bounded box, the terminal root, the
 * capture. The screen's size follows the font, as xterm's does — a stub frozen
 * at the base size would read as a smaller and smaller capture every time the
 * pane was enlarged, which is not a thing a real screen does.
 */
function layout(boxWidth: number, boxHeight: number, fontNow: () => number) {
  const box = document.createElement('div')
  const root = document.createElement('div')
  const wrap = document.createElement('div')
  const scaler = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  const keybar = document.createElement('div')
  scaler.append(screen)
  wrap.append(scaler)
  root.append(wrap, keybar)
  box.append(root)
  document.body.append(box)
  sized(box, boxWidth, boxHeight)
  sized(root, boxWidth, 0)
  const drawn = (base: number) => () => (base * fontNow()) / BASE_FONT
  Object.defineProperty(screen, 'offsetWidth', { get: drawn(CAPTURE_WIDTH), configurable: true })
  Object.defineProperty(screen, 'offsetHeight', { get: drawn(CAPTURE_HEIGHT), configurable: true })
  sized(keybar, 0, 40)
  return { box, root, wrap, scaler, screen, keybar }
}

async function mounted(boxWidth: number, boxHeight: number) {
  const { PaneTerm } = await import('../../src/web/lib/term.ts')
  const term = new PaneTerm(
    () => {},
    () => {},
    () => {},
  )
  const dom = layout(boxWidth, boxHeight, () => term.font)
  term.mount(dom.wrap, dom.scaler)
  return { term, ...dom }
}

describe('PaneTerm re-fits to its container', () => {
  // Stubbed once for the file, not unstubbed per test: `unstubAllGlobals`
  // would also take down the `matchMedia` stub in setup.ts that xterm's own
  // `open` needs.
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})

  beforeEach(() => {
    observers.length = 0
    frames = []
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('watches the parent of the box it sizes, never that box', async () => {
    const { wrap, root } = await mounted(500, 1000)
    // Observing `wrap` would be a feedback loop: rescale writes its size.
    expect(observer().targets).toEqual([root])
    expect(observer().targets).not.toContain(wrap)
  })

  it('rescales when the container changes, with no new frame', async () => {
    const { term, scaler, root, box } = await mounted(500, 1000)
    // "fit", so the shrink is exact rather than stopping at the legibility floor.
    term.setZoom('fit')
    term.scheduleRescale()
    runFrames()
    // 1000px wide in 500px: halved.
    expect(scaler.style.transform).toBe('scale(0.5)')

    // The window narrows. No frame arrives; only the observer speaks.
    sized(box, 250, 1000)
    sized(root, 250, 0)
    observer().callback()
    runFrames()
    expect(scaler.style.transform).toBe('scale(0.25)')
  })

  it('coalesces a burst of resizes into one measurement', async () => {
    const { term } = await mounted(500, 1000)
    term.scheduleRescale()
    runFrames()
    frames = []
    const queued = () => frames.length
    for (let i = 0; i < 50; i += 1) observer().callback()
    // One pending schedule, not fifty.
    expect(queued()).toBe(1)
    runFrames()
    // Once it has run, the next resize may schedule again.
    observer().callback()
    expect(queued()).toBe(1)
  })

  it('stops watching when disposed', async () => {
    const { term } = await mounted(500, 1000)
    expect(observer().disconnected).toBe(false)
    term.dispose()
    expect(observer().disconnected).toBe(true)
  })

  /*
   * The height budget is the box less everything else in it. A 1000×400 capture
   * in a 2000-wide box could double on width alone, but the box is 600 tall and
   * a 40px key bar shares it: 560/400 = 1.4, not 600/400 = 1.5.
   */
  it('leaves the key bar its room when enlarging', async () => {
    const { term, wrap } = await mounted(2000, 600)
    term.setMaxFont(52)
    term.scheduleRescale()
    runFrames()
    expect(wrap.style.height).toBe('560px')
  })

  it('enlarges by re-rendering at a bigger font rather than stretching the canvas', async () => {
    const { term, scaler } = await mounted(2000, 10_000)
    term.setMaxFont(26)
    term.scheduleRescale()
    runFrames()
    // Doubled: xterm renders at 26px and the transform carries only what the
    // whole-pixel font could not.
    expect(term.font).toBe(26)
    expect(scaler.style.transform).toBe('scale(1)')
    expect(term.scaled).toBe(true)
  })

  it('shrinks with a transform and the base font', async () => {
    const { term, scaler } = await mounted(500, 10_000)
    term.setZoom('fit')
    term.scheduleRescale()
    runFrames()
    expect(term.font).toBe(BASE_FONT)
    expect(scaler.style.transform).toBe('scale(0.5)')
  })

  // Readable mode keeps its floor: below 9.5px the pane pans rather than shrinks.
  it('still refuses to shrink below the legibility floor', async () => {
    const { term, wrap } = await mounted(500, 10_000)
    term.scheduleRescale()
    runFrames()
    expect(term.overflowing).toBe(true)
    expect(wrap.style.width).toBe('100%')
  })
})
