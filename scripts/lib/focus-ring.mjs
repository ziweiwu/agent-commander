/**
 * Whether a focus ring reached the screen, read from a screenshot.
 *
 * A computed outline is a statement about style, not about pixels. The
 * conversation once matched `:focus-visible` with a 2px outline while nothing
 * blue was painted: a `mask-image` on the box (the scroll-edge fade) clips the
 * element's own outline to its border box, and a scroller's `overflow` clips
 * the ring of a box flush against its edge. Every check that asked the style
 * passed it.
 *
 * So this looks at the screenshot instead: along each of the element's four
 * edges, from `OUTSIDE` px outside to `INSIDE` px inside, for the colour the
 * `--focus` token resolves to on this page. An inset ring and the global
 * outset one both land in that band. The share of samples along an edge that
 * found the colour is that edge's score, and an edge with no sample on screen
 * scores `null`: off screen is not judged, and neither is an edge an ancestor's
 * clip has scrolled out of view, since no ring could show there; an edge that
 * is in view with its ring clipped beyond it is judged, and fails. `e2e/focus-ring.spec.ts` and
 * `scripts/audit-a11y.mjs` both judge with it, so the two cannot disagree on
 * what "painted" means.
 */

/** The global ring is offset 2px and 2px wide; one spare pixel past it. */
const OUTSIDE = 6
/** An inset ring sits in the first 2px inside the edge; two spare. */
const INSIDE = 4
/** RGB distance under which a pixel is the ring: antialiasing, not another colour. */
const TOLERANCE = 60
/** One sample every this many pixels along an edge. */
const STEP = 6
/** The corners are rounded, so sampling starts this far in from each. */
const CORNER = STEP * 2

/**
 * How long a Tab's own scroll takes to settle before the ring is judged. Focus
 * scrolling fires `scroll` a frame later, and only then does `useOverflowEdge`
 * lift a fade that the scroll took to the end; a screenshot taken before that
 * reported a faded ring the reader never sees.
 */
const SETTLE_MS = 300

/** The share of an edge's samples the ring must reach to count as painted. */
export const RING_PAINTED = 0.8

/** Positions from `start` to `end`, `STEP` apart, keeping clear of the corners. */
function along(start, end) {
  const out = []
  for (let at = start + CORNER; at < end - CORNER; at += STEP) out.push(at)
  return out
}

/**
 * For each edge, one row of points per position along it: the band across the
 * edge, outside to inside. The first point of a row is the edge itself.
 */
function edgeRows(box) {
  const right = box.left + box.width - 1
  const bottom = box.top + box.height - 1
  const depths = [0]
  for (let depth = 1; depth <= OUTSIDE; depth += 1) depths.push(-depth)
  for (let depth = 1; depth <= INSIDE; depth += 1) depths.push(depth)
  const rows = (positions, point) => positions.map((pos) => depths.map((depth) => point(pos, depth)))
  const xs = along(box.left, right)
  const ys = along(box.top, bottom)
  return {
    left: rows(ys, (y, depth) => [box.left + depth, y]),
    top: rows(xs, (x, depth) => [x, box.top + depth]),
    right: rows(ys, (y, depth) => [right - depth, y]),
    bottom: rows(xs, (x, depth) => [x, bottom - depth]),
  }
}

/**
 * Runs in the page: decode the screenshot and read each point's RGB, or
 * `null` for a point off the image. Self-contained, as `page.evaluate` needs,
 * which is why the four bytes of a pixel are spelled here rather than named
 * at the top of the module.
 */
async function readPixels({ data, points }) {
  const img = new Image()
  img.src = `data:image/png;base64,${data}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const context = canvas.getContext('2d')
  context.drawImage(img, 0, 0)
  const pixels = context.getImageData(0, 0, img.width, img.height).data
  const bytesPerPixel = 4
  return points.map(([x, y]) => {
    const column = Math.round(x)
    const row = Math.round(y)
    if (column < 0 || row < 0 || column >= img.width || row >= img.height) return null
    const index = (row * img.width + column) * bytesPerPixel
    return [pixels[index], pixels[index + 1], pixels[index + 2]]
  })
}

/**
 * Read in the page: the element's box, the colour `--focus` resolves to, and
 * the visible rect left by every ancestor that clips, so an edge scrolled out
 * of its scroller is told apart from a ring that edge failed to show.
 */
function boxAndFocus(element) {
  const rect = element.getBoundingClientRect()
  const probe = document.createElement('i')
  probe.style.color = 'var(--focus)'
  document.body.append(probe)
  const focus = getComputedStyle(probe).color
  probe.remove()
  const clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }
  for (let up = element.parentElement; up; up = up.parentElement) {
    const style = getComputedStyle(up)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const outer = up.getBoundingClientRect()
    clip.left = Math.max(clip.left, outer.left)
    clip.top = Math.max(clip.top, outer.top)
    clip.right = Math.min(clip.right, outer.right)
    clip.bottom = Math.min(clip.bottom, outer.bottom)
  }
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, focus, clip }
}

/** An edge's share of on-screen rows that found the ring, or `null` with none on screen. */
function scoreEdge(rows, isRing) {
  const onScreen = rows.filter((row) => row[0] !== null)
  if (onScreen.length === 0) return null
  return onScreen.filter((row) => row.some(isRing)).length / onScreen.length
}

/**
 * Each edge's share of samples where the `--focus` colour is painted near it.
 *
 * `target` is a Playwright locator or element handle. The page is
 * screenshotted at CSS scale, so a device pixel ratio does not move the band.
 */
export async function ringSides(page, target) {
  await page.waitForTimeout(SETTLE_MS)
  const box = await target.evaluate(boxAndFocus)
  const rows = edgeRows(box)
  const shot = await page.screenshot({ scale: 'css' })
  const points = Object.values(rows).flat(2)
  const colours = await page.evaluate(readPixels, { data: shot.toString('base64'), points })
  const [red, green, blue] = (box.focus.match(/\d+/g) ?? []).map(Number)
  const isRing = (rgb) => rgb !== null && Math.hypot(rgb[0] - red, rgb[1] - green, rgb[2] - blue) < TOLERANCE
  const { clip } = box
  const visible = ([x, y]) => x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom
  let next = 0
  const scores = {}
  for (const [side, sideRows] of Object.entries(rows)) {
    const read = sideRows.map((row) => {
      const rgbs = row.map(() => colours[next++])
      return visible(row[0]) ? rgbs : [null]
    })
    scores[side] = scoreEdge(read, isRing)
  }
  return scores
}

/** How often, and for how long at most, `untilStill` reads a scroll box. */
const STILL_POLL_MS = 150
const STILL_LIMIT_MS = 5000

/**
 * Wait until a scroll box has stopped moving: the same height and offset on
 * two reads in a row. A conversation is still landing a beat after it is
 * drawn, and a re-render then moves it; a box Tab had just scrolled into view
 * was then measured half out of it, which reads exactly like a clipped ring.
 */
export async function untilStill(page, selector) {
  const read = () => page.locator(selector).evaluate((box) => `${box.scrollHeight}:${box.scrollTop}`)
  let last = await read()
  for (let waited = 0; waited < STILL_LIMIT_MS; waited += STILL_POLL_MS) {
    await page.waitForTimeout(STILL_POLL_MS)
    const now = await read()
    if (now === last) return
    last = now
  }
}

/** The on-screen edges whose score is under `RING_PAINTED`, so an empty list means painted. */
export async function unpaintedEdges(page, target) {
  const sides = await ringSides(page, target)
  return Object.entries(sides)
    .filter(([, share]) => share !== null && share < RING_PAINTED)
    .map(([side, share]) => `${side} ${share.toFixed(2)}`)
}
