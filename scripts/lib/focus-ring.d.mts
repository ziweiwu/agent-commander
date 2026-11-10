import type { ElementHandle, Locator, Page } from 'playwright'

export type RingSide = 'left' | 'top' | 'right' | 'bottom'

/** The share of an edge's samples the ring must reach to count as painted. */
export const RING_PAINTED: number

/** Each edge's share of samples where the `--focus` colour is painted near it; `null` for an edge off screen. */
export function ringSides(page: Page, target: Locator | ElementHandle): Promise<Record<RingSide, number | null>>

/** The on-screen edges whose score is under `RING_PAINTED`, so an empty list means painted. */
export function unpaintedEdges(page: Page, target: Locator | ElementHandle): Promise<string[]>
