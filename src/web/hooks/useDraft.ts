import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useStore, type Draft, type DraftBox } from '../store/store.ts'

/** The inline height a held draft puts back on its box; empty hands the box back to the stylesheet. */
function inlineHeight(draft: Draft | undefined): string {
  return draft?.height ? `${draft.height}px` : ''
}

export interface HeldDraft {
  /** What the box shows. Only for rendering. */
  draft: string
  /**
   * The synchronous truth about the draft (INV-2). A send empties it before it
   * writes, so a second press in the same React batch finds nothing to send.
   */
  draftRef: RefObject<string>
  /**
   * Hold text for a session: the one on screen, or — when an upload lands after
   * the reader has moved on — the one it was started for.
   */
  write: (sessionId: string, text: string, height: number | null) => void
  /** Let the on-screen draft go after a send that went, and put the box back to its resting height. */
  clear: () => void
}

/**
 * One box's draft, held per agent in the store rather than in the component (F1).
 *
 * The component is not a safe place for it. `<Chat>` is not keyed by agent, so
 * text typed for one showed up in the next one's box; ‹ Agents unmounts the
 * phone sheet, and ⤢ mounts a second `<Chat>`, and both threw the text away.
 * Whatever is half-typed belongs to the agent it was typed for, wherever the
 * reader goes in between — and only a send that went lets it go.
 */
export function useDraft(
  box: DraftBox,
  sessionId: string,
  inputRef: RefObject<HTMLTextAreaElement | null>,
): HeldDraft {
  const draft = useStore((s) => s.drafts[box][sessionId]?.text ?? '')
  const keepDraft = useStore((s) => s.keepDraft)
  const draftRef = useRef(draft)
  const shownRef = useRef(sessionId)

  useLayoutEffect(() => {
    shownRef.current = sessionId
    const held = useStore.getState().drafts[box][sessionId]
    draftRef.current = held?.text ?? ''
    if (inputRef.current) inputRef.current.style.height = inlineHeight(held)
  }, [box, sessionId, inputRef])

  const write = (id: string, text: string, height: number | null): void => {
    if (id === shownRef.current) draftRef.current = text
    keepDraft(box, id, { text, height })
  }

  const clear = (): void => {
    draftRef.current = ''
    keepDraft(box, shownRef.current, null)
    if (inputRef.current) inputRef.current.style.height = ''
  }

  return { draft, draftRef, write, clear }
}
