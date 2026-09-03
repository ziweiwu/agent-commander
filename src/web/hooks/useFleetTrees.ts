import { useEffect, useRef, useState } from 'react'
import type { FleetTree } from '../../shared/types.ts'
import { fetchTree } from '../store/transport.ts'
import { useStore } from '../store/store.ts'

/**
 * How often to re-read the delegation graph while a view of it is open.
 *
 * Slower than the fleet's own tick because nothing here is urgent: a delegate's
 * state changes on the order of a minute, and what this feeds is the shape of
 * the work rather than its instant.
 */
const POLL_MS = 3000

/** One read. `null` when the graph has not moved, so nothing re-renders. */
async function readTrees(
  etag: string | null,
  signal: AbortSignal,
): Promise<{ etag: string | null; trees: FleetTree['trees'] } | null> {
  /*
   * A failed read leaves the last graph on screen rather than blanking it
   * (INV-5). A view that flickered empty on one dropped request would read as
   * every session having stopped delegating at once.
   *
   * `try` rather than `.catch`, because the two failures are not the same
   * shape: a dropped request rejects, but a transport that throws on the way in
   * — an aborted signal, a module that is not what the caller thought — throws
   * synchronously, and that one escaped the promise entirely and left the loop
   * below with no next pass armed. A poll that dies leaves the view frozen on
   * an old reading with nothing saying so.
   */
  try {
    const body = await fetchTree(etag, signal)
    return body.changed ? { etag: body.etag, trees: body.trees } : null
  } catch {
    return null
  }
}

/**
 * The fleet's delegation graph, re-read while something is watching it.
 *
 * One holder — the fleet list — because it is one question about the whole
 * fleet. When each card polled for itself the answer was thirty requests for
 * one 54 KB body.
 *
 * Polled over HTTP rather than pushed, and **only while a component holding
 * this hook is mounted**: INV-4's first rule is that nothing polls what nobody
 * is watching, and an effect that stops on unmount satisfies it without adding
 * a subscription lifecycle to the wire.
 *
 * `etag` is a ref rather than state because it must never itself cause a
 * render: it changes only when `trees` does, and holding it is what leaves
 * `trees` — and every memoised node behind it — untouched when the graph has
 * not moved.
 *
 * Each pass arms the next read *before* applying the one it has, so nothing
 * that throws while applying a graph can stop the loop. A poll that dies leaves
 * the view frozen on an old reading with nothing saying so, which is worse than
 * a blank view because it still looks like an answer.
 */
export function useFleetTrees(): FleetTree['trees'] {
  /*
   * Seeded from, and published to, the store. Two holders take turns with
   * this hook — the fleet list, and the detail view on a phone where the list
   * is unmounted while the sheet covers it — and the detail's status line
   * reads the graph from the store rather than polling for itself. Seeding
   * from the store is what keeps the graph on screen across the hand-over
   * instead of blanking for one poll; the tag comes with it so the hand-over
   * costs a 304 rather than the whole body.
   */
  const [trees, setTrees] = useState<FleetTree['trees']>(() => useStore.getState().trees)

  const etag = useRef<string | null>(useStore.getState().treesEtag)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const stop = (): void => {
      live = false
      controller.abort()
      if (timer) clearTimeout(timer)
    }

    const pass = async (): Promise<void> => {
      const next = await readTrees(etag.current, controller.signal)
      if (live) timer = setTimeout(() => void pass(), POLL_MS)
      if (live && next) {
        etag.current = next.etag
        setTrees(next.trees)
        useStore.getState().setTrees(next.trees, next.etag)
      }
    }

    void pass()
    return () => stop()
  }, [])

  return trees
}
