import { useEffect, useRef, type RefObject } from 'react'
import { useLocation } from 'react-router-dom'
import { grouped, listedFleet } from '../lib/filter.ts'
import { useStore } from '../store/store.ts'

/** Which of the app's three places a path is. */
type Place = { kind: 'agent'; id: string } | { kind: 'help' } | { kind: 'fleet' }

const AGENT_PATH = /^\/agent\/([^/]+)/

export function placeOf(pathname: string): Place {
  const agent = AGENT_PATH.exec(pathname)?.[1]
  if (agent) return { kind: 'agent', id: decodeURIComponent(agent) }
  return pathname.startsWith('/help') ? { kind: 'help' } : { kind: 'fleet' }
}

function samePlace(left: Place, entered: Place): boolean {
  return left.kind === entered.kind && (left.kind !== 'agent' || (entered.kind === 'agent' && left.id === entered.id))
}

/**
 * The card to land on when `gone` has left the list: its neighbours in the
 * order the list last drew them, nearest first, below before above.
 */
export function nearestCard(order: readonly string[], gone: string, present: (id: string) => boolean): string | null {
  const at = order.indexOf(gone)
  if (at < 0) return order.find(present) ?? null
  for (let distance = 1; distance < order.length; distance += 1) {
    for (const candidate of [order[at + distance], order[at - distance]]) {
      if (candidate !== undefined && present(candidate)) return candidate
    }
  }
  return null
}

const cardOf = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="agent-card"][data-session-id="${CSS.escape(id)}"]`)

const TYPED = 'input, textarea, select, [contenteditable="true"]'

/** Whether focus sits on something real that the move must not take it from. */
function heldBy(): Element | null {
  const active = document.activeElement
  if (!active || active === document.body || !active.isConnected) return null
  return active
}

function arrive(place: Place): void {
  const held = heldBy()
  if (held?.matches(TYPED) || held?.closest('[data-testid="agent-detail"], [data-testid="help-page"]')) return
  if (held && !matchMedia('(pointer: coarse)').matches) return
  const heading =
    place.kind === 'agent'
      ? document.querySelector<HTMLElement>('[data-testid="detail-name"]')
      : document.querySelector<HTMLElement>('[data-testid="help-page"] h2')
  heading?.focus()
}

function returnTo(from: Place, order: readonly string[], search: HTMLInputElement | null): void {
  if (heldBy()) return
  if (from.kind === 'help') {
    document.querySelector<HTMLElement>('[data-testid="help-button"]')?.focus()
    return
  }
  if (from.kind !== 'agent') return
  const id = cardOf(from.id) ? from.id : nearestCard(order, from.id, (other) => cardOf(other) !== null)
  const target = id === null ? search : cardOf(id)
  const showRing: FocusOptions & { focusVisible: boolean } = { focusVisible: true }
  target?.focus(showRing)
}

/**
 * Focus follows the route, so a move between places never strands it on
 * <body>.
 *
 * Arriving at an agent or at Help on a phone puts focus on its heading, which
 * raises no keyboard and is never anything that sends (INV-2); on a desk only
 * where nothing holds focus, because there Chat already puts it on the
 * composer or on option 1. Anything already inside the place, a hop's question
 * heading among them, is left where it is.
 *
 * Leaving an agent for the fleet puts focus back on its card, or, when its
 * agent has gone, on the nearest card the list drew beside it, else the filter
 * box. Leaving Help puts it back on the help button. Neither moves focus that
 * something on the fleet already holds.
 *
 * Run a microtask after the commit, so the route's own effects have placed
 * whatever they place first.
 */
export function useRouteFocus(search: RefObject<HTMLInputElement | null>): void {
  const { pathname } = useLocation()
  const last = useRef<Place>(placeOf(pathname))
  const order = useRef<string[]>([])

  useEffect(
    () =>
      useStore.subscribe((state, prior) => {
        if (state.agents === prior.agents || !state.agents.some((a) => a.sessionId === state.selected)) return
        order.current = listOrder()
      }),
    [],
  )

  useEffect(() => {
    const from = last.current
    const to = placeOf(pathname)
    last.current = to
    if (to.kind === 'agent') order.current = listOrder()
    if (samePlace(from, to)) return
    queueMicrotask(() => {
      if (to.kind === 'fleet') returnTo(from, order.current, search.current)
      else arrive(to)
    })
  }, [pathname, search])
}

/** The session ids in the order the fleet list draws them, filtered and grouped as it is. */
function listOrder(): string[] {
  const state = useStore.getState()
  return grouped(state.agents, listedFleet(state)).flatMap((group) => group.agents.map((a) => a.sessionId))
}
