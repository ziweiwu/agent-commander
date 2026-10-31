import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/store.ts'
import { focusAgent } from '../store/transport.ts'
import { agentPath, listNeighbour, nextUp, type AgentTab } from '../lib/hop.ts'
import { useTranslate } from './useTranslate.ts'

/** Go to one agent from another, the way the chip, the hand-off and the chords do. */
export type Hop = (sessionId: string, tab: AgentTab) => void

/**
 * Open another agent without going back to the list.
 *
 * **Replace, not push, while an agent is open.** A phone's swipe-back is the
 * way out of the sheet, and it should land on the fleet rather than walk back
 * through every agent the chip went to on the way — three hops would otherwise
 * be three swipes to reach the list. From the fleet itself the hop is pushed,
 * so back still returns to it.
 *
 * It also records that this arrival was a hop (`hopped`), which is what moves
 * the focus onto the question rather than its first option (INV-2).
 *
 * **The selection moves now, not when the route renders.** The route's effect
 * would get there a frame later, and a second ⌥J pressed inside that frame
 * stepped on from the agent being left rather than the one arrived at — so two
 * quick presses went to the same place, or back. `focusAgent` is idempotent,
 * so the route's own call then finds nothing to do.
 */
export function useHop(): Hop {
  const navigate = useNavigate()
  return useCallback(
    (sessionId, tab) => {
      const replace = useStore.getState().selected !== null
      useStore.setState({ hopped: sessionId })
      focusAgent(sessionId)
      navigate(agentPath(sessionId, tab), { replace })
    },
    [navigate],
  )
}

/** What each chord asks for. */
type Chord = 'next' | 'previous' | 'waiting'

/**
 * Keyed on `e.code`, the physical key, never `e.key`: macOS Option rewrites
 * the character, so ⌥J arrives as `∆` and ⌥K as `˚`, and a layout other than
 * US moves them again.
 */
const CHORDS: Readonly<Record<string, Chord>> = { KeyJ: 'next', KeyK: 'previous', KeyH: 'waiting' }

/**
 * The chord this keydown is, or null when it is not one of ours to take.
 *
 * Not while an input method is composing: an Option-modified key there belongs
 * to the IME, and Pinyin is how this app's Chinese readers type. Not inside the
 * terminal either, where every key — Option chords included — is the agent's.
 * Shift, Ctrl or Cmd held as well makes it some other chord, Shift+Esc's among
 * them, which keeps its priority.
 */
export function chordOf(press: KeyboardEvent): Chord | null {
  if (!press.altKey || press.shiftKey || press.ctrlKey || press.metaKey || press.isComposing) return null
  const target = press.target instanceof Element ? press.target : null
  if (target?.closest('[data-testid="term-wrap"]')) return null
  return CHORDS[press.code] ?? null
}

/**
 * ⌥J / ⌥K: the next or previous agent along the list, on the tab already open.
 * ⌥H: the next agent that needs you (`nextUp`, the chip's and the Next
 * button's), on its conversation, or a toast saying nothing does.
 *
 * On the document, so they work from the composer, with the column collapsed
 * and from full screen alike — the list does not have to be on screen for a
 * key to walk it. Not while the new-agent dialog is up: a hop behind a modal
 * would change what the dialog is sitting on.
 */
export function useHopKeys(): void {
  const hop = useHop()
  const t = useTranslate()
  useEffect(() => {
    const onKey = (press: KeyboardEvent): void => {
      const chord = chordOf(press)
      const state = useStore.getState()
      if (!chord || state.newAgentOpen) return
      press.preventDefault()
      if (chord === 'waiting') {
        const target = nextUp(state.agents, state.selected, state.exited)
        if (target) hop(target.sessionId, 'chat')
        else state.showToast(t('nothingNeedsYou'))
        return
      }
      const step = chord === 'next' ? 1 : -1
      const target = listNeighbour(state.agents, state.fleet, state.selected, step)
      if (target) hop(target.sessionId, state.selected ? state.tab : 'chat')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [hop, t])
}
