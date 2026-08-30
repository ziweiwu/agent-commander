import { useEffect, useId, useRef, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useModalChrome } from '../hooks/useModalChrome.ts'
import { Button } from './ui/Button.tsx'
import styles from './ConfirmDialog.module.css'

/** Focus is placed by lookup rather than a ref: `Button` does not take one. */
const CANCEL_TESTID = 'confirm-cancel'

/**
 * The confirmation in front of a destructive control.
 *
 * It replaces `window.confirm()`, which gave three things away for free and one
 * thing badly. Free: modality, focus, and Escape — all three are re-earned here
 * rather than assumed, because a dialog that Tab can walk out of is not modal
 * however it is styled. Badly: its buttons are the OS's, so they are untimed,
 * untranslated and unthemed on an app that is read on a phone in the dark.
 *
 * What it deliberately does not add is friction. Akhawe & Felt's 25M browser
 * warning impressions found that making a warning harder to click through
 * barely moves what people do, while what it *says* moves it several-fold — so
 * this buys its interruption with `loss`, a specific statement of what will not
 * come back, and not with a type-the-name box nobody has evidence for.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  loss,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body: string
  /** The specific, irreversible consequence, when the action has one. */
  loss?: string
  /** A verb naming the outcome. Never "OK": the button has to say what it does. */
  confirmLabel: string
  /** The safe verb. Names what SURVIVES, which differs per action. */
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const titleId = `${id}-title`
  const bodyId = `${id}-body`

  // Declared before the focus effect below so it captures the control that
  // opened the dialog, not the button we are about to focus.
  useModalChrome(rootRef, open)

  useEffect(() => {
    if (!open) return
    /*
     * The safe button, always. This app trains Enter to mean "go" — the
     * composer sends on it, the fleet list opens an agent with it — so a
     * confirmation that lands focus on the destructive verb is a guard the
     * reflex it interrupts can defeat.
     */
    rootRef.current?.querySelector<HTMLElement>(`[data-testid="${CANCEL_TESTID}"]`)?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const container = rootRef.current
    if (!container) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      /*
       * Stopped here rather than left to bubble. `App` has a document-level
       * Escape handler that leaves full screen and navigates out of the agent,
       * and answering a confirmation must not also throw away the view behind
       * it — the same collision the terminal's interrupt dialog already hit.
       */
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    container.addEventListener('keydown', onKeyDown)
    return () => container.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  return createPortal(
    <div ref={rootRef}>
      <div className={styles.backdrop} onClick={onCancel} />
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="confirm-dialog"
      >
        <h2 className={styles.title} id={titleId}>
          {title}
        </h2>
        <p className={styles.body} id={bodyId}>
          {body}
        </p>
        {loss !== undefined && (
          <p className={styles.loss} data-testid="confirm-loss">
            {loss}
          </p>
        )}
        <div className={styles.actions}>
          {/*
            Safe first in the DOM, so Tab reaches it first and a screen reader
            reads it first, and visually primary — the destructive one is only
            outlined. Colour is never the sole signal: the two labels are verbs
            naming their own outcomes, so they still differ with no colour at
            all. The gap between them is deliberate; a design pass found 8px
            close enough that a mis-aimed thumb hit the wrong one.
          */}
          <Button
            variant="primary"
            className={styles.safe}
            data-testid={CANCEL_TESTID}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button className={styles.destructive} data-testid="confirm-accept" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
