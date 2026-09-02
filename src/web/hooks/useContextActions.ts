import { useNavigate } from 'react-router-dom'
import { useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { Agent } from '../../shared/types.ts'
import { useStore } from '../store/store.ts'
import { clearAgentContext, compactAgentContext } from '../store/transport.ts'
import { useTranslate } from './useTranslate.ts'
import { displayName } from '../lib/naming.ts'
import type { ConfirmDialogProps } from '../components/ConfirmDialog.tsx'

/** Which of the two is in flight. */
export type ContextAction = 'clear' | 'compact'

export interface ContextActions {
  /** The action in flight, for the button's own label. `null` when idle. */
  pending: ContextAction | null
  /** Raise the confirmation. The only thing a Clear button may call. */
  askClear: () => void
  /** Everything `ConfirmDialog` needs, copy included. Spread it. */
  confirm: ConfirmDialogProps
  /** Compaction. Deliberately not guarded by a dialog — see below. */
  runCompact: () => void
}

type Translate = ReturnType<typeof useTranslate>

/** What the clear path needs from the page, so it can live outside the hook. */
interface ClearSurface {
  t: Translate
  showToast: (text: string) => void
  setExpectSession: (sessionId: string) => void
  navigate: ReturnType<typeof useNavigate>
}

/**
 * `/clear` and `/compact`, wherever they are offered.
 *
 * Two surfaces reach for these: the detail panel's control row, and the
 * composer strip — the strip because the panel's row sits above the tabs,
 * collapses behind `⋯` below 900px, and is absent entirely in full screen,
 * which is where a long conversation is read. Deciding "this context is spent"
 * happens while looking at it.
 *
 * The pair lives in one hook rather than in each surface because the clear path
 * is not obvious and would not survive being written twice: it navigates, it
 * navigates in a particular order, and it must not run twice. Two copies of
 * that sequence is two chances to get the order wrong, and only one of them
 * would be under test.
 */
export function useContextActions(agent: Agent): ContextActions {
  const t = useTranslate()
  const showToast = useStore((s) => s.showToast)
  const setExpectSession = useStore((s) => s.setExpectSession)
  const navigate = useNavigate()
  const sendingRef = useRef(false)
  const [pending, setPending] = useState<ContextAction | null>(null)
  // The button only asks; the runner below is what reaches the agent (INV-2).
  const [confirming, setConfirming] = useState(false)
  const once = (action: ContextAction, run: () => Promise<void>): Promise<void> =>
    runOnce(sendingRef, setPending, action, run)

  const onClear = (): void => {
    if (sendingRef.current) return
    setConfirming(false)
    void once('clear', () => clearAndFollow(agent, { t, showToast, setExpectSession, navigate }))
  }

  return {
    pending,
    askClear: () => setConfirming(true),
    runCompact: () => void once('compact', () => compactAndReport(agent, t, showToast)),
    confirm: {
      open: confirming,
      ...clearDialogCopy(agent, t),
      onConfirm: onClear,
      onCancel: () => setConfirming(false),
    },
  }
}

/**
 * INV-2's "exactly once". `pending` is React state and does not land until
 * React flushes, so two clicks in one batch would both read it as null; the
 * ref is what a second click in the same batch sees. Clear in particular must
 * never go twice: the second would discard the fresh session the first one
 * just created.
 */
async function runOnce(
  sending: MutableRefObject<boolean>,
  setPending: (action: ContextAction | null) => void,
  action: ContextAction,
  run: () => Promise<void>,
): Promise<void> {
  if (sending.current) return
  sending.current = true
  setPending(action)
  try {
    await run()
  } finally {
    sending.current = false
    setPending(null)
  }
}

/**
 * Clear replaces the session rather than editing it, so the id the user is
 * looking at stops existing. Without following it, `focusAgent` points at
 * nothing, the route bails to the fleet, and the agent reappears further down
 * the page as a stranger — from the user's side, the panel closed itself.
 */
async function clearAndFollow(agent: Agent, page: ClearSurface): Promise<void> {
  const name = displayName(agent)
  const result = await clearAgentContext()
  if (!result.ok) {
    page.showToast(page.t('controlFailed', { error: result.error }))
    return
  }
  if (result.detail === undefined || result.detail === 'unverified') {
    // The paste went out and no new session appeared inside the window.
    // Saying it worked would claim something nobody read (INV-11), and
    // navigating on that claim would land on an id that may not exist.
    page.showToast(page.t('clearUnverified', { name }))
    return
  }
  page.showToast(page.t('cleared', { name }))
  /*
   * Say so before navigating. The registry has not scanned for this id yet
   * — it appeared a moment ago — and the route's "the agent ended while it
   * was open" rule would otherwise fire on arrival and bounce straight back
   * to the fleet.
   */
  page.setExpectSession(result.detail)
  page.navigate(`/agent/${encodeURIComponent(result.detail)}`, { replace: true })
}

/*
 * No confirmation: compaction shortens the context rather than discarding it,
 * and Claude Code does it unprompted when the window fills. What it does need
 * is honesty about timing — it runs for minutes, so nothing here waits.
 */
async function compactAndReport(
  agent: Agent,
  translate: Translate,
  showToast: (text: string) => void,
): Promise<void> {
  const result = await compactAgentContext()
  if (!result.ok) showToast(translate('controlFailed', { error: result.error }))
  else showToast(translate('compactRequested', { name: displayName(agent) }))
}

/*
 * The copy travels with the action, not with the surface. `clearConfirm` is
 * the one string that names the half nothing can get back — "There is no
 * undo" — so it is what goes in the loss block, and it says so in one place
 * rather than once per button that can raise the dialog.
 */
function clearDialogCopy(
  agent: Agent,
  translate: Translate,
): Pick<ConfirmDialogProps, 'title' | 'body' | 'loss' | 'confirmLabel' | 'cancelLabel'> {
  return {
    title: translate('clearContext'),
    body: translate('clearContextTitle'),
    loss: translate('clearConfirm', { name: displayName(agent) }),
    confirmLabel: translate('clearContext'),
    cancelLabel: translate('clearKeep'),
  }
}
