import type { ElementHandle, Locator, Page } from 'playwright'

export type RingSide = 'left' | 'top' | 'right' | 'bottom'

/** The share of an edge's samples the ring must reach to count as painted. */
export const RING_PAINTED: number

/** A `tolerance` that asks for the ring at full strength, as no ancestor's `opacity` leaves it. */
export const FULL_STRENGTH: number

/** How far from `--focus` a pixel may be and still count as the ring, and which depths across each edge to read, negative outside. */
export interface RingOptions {
  tolerance?: number
  band?: number[]
}

/** Each edge's share of samples where the `--focus` colour is painted near it; `null` for an edge off screen. */
export function ringSides(
  page: Page,
  target: Locator | ElementHandle,
  options?: RingOptions,
): Promise<Record<RingSide, number | null>>

/** The on-screen edges whose score is under `RING_PAINTED`, so an empty list means painted. */
export function unpaintedEdges(
  page: Page,
  target: Locator | ElementHandle,
  options?: RingOptions,
): Promise<string[]>

/** Wait until the scroll box `selector` names reads the same height and offset twice in a row. */
export function untilStill(page: Page, selector: string): Promise<void>
