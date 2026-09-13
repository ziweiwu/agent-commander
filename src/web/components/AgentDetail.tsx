import type { Agent } from '../../shared/types.ts'
import { tildePath, uptimeParts } from '../lib/format.ts'
import { formatUptime } from '../lib/i18n.ts'
import { useState } from 'react'
import { useOverflowEdge } from '../hooks/useOverflowEdge.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { DelegateLine, REASON_KEY, STATUS_KEY, useStatusText } from './AgentCard.tsx'
import { aliasOfModel } from './AgentControls.tsx'
import { claimOf, isStallCandidate } from '../lib/delegation.ts'
import { modeLabel } from '../lib/modes.ts'
import { useMemo } from 'react'
import { displayName, isRenamed } from '../lib/naming.ts'
import { useStore } from '../store/store.ts'
import { hasTranscripts } from '../../shared/agent-kinds.ts'
import { AgentControls } from './AgentControls.tsx'
import { FullscreenView } from './FullscreenView.tsx'
import { Chat } from './Chat.tsx'
import { LazyTerminal } from './LazyTerminal.tsx'

import { Button } from './ui/Button.tsx'
import styles from './AgentDetail.module.css'

export interface AgentDetailProps {
  agent: Agent
  tab: 'chat' | 'attach'
  /** True when the detail owns the whole screen rather than sitting beside the list. */
  sheet: boolean
  onTab: (tab: 'chat' | 'attach') => void
  onClose: () => void
}

/** Just the status word, for when there is no room for the reason. */
function useShortStatus(): (agent: Agent) => string {
  const t = useTranslate()
  return (agent) => t(STATUS_KEY[agent.status] ?? 'statusUnknown')
}

export function AgentDetail({ agent, tab, sheet, onTab, onClose }: AgentDetailProps) {
  const t = useTranslate()
  const lang = useLang()
  const statusText = useStatusText()
  const shortStatus = useShortStatus()
  const fullscreen = useStore((s) => s.fullscreen)
  const setFullscreen = useStore((s) => s.setFullscreen)
  /*
   * The settings row folds at every width, not only on a phone.
   *
   * On a phone it wrapped to three lines and took 111px of a 568px screen,
   * which is why it first collapsed there. The reasoning was right and the
   * conclusion was too narrow: measured at 1440x900 the row is a 960x53 band
   * holding one 103x36 button, so 857px of it is empty and it costs 3.9% of the
   * screen — permanently, on the surface whose whole job is showing a
   * conversation, for a control pressed about once per session.
   *
   * This is the same argument that turned the composer strip into a menu
   * (INV-8): a row that is the most expensive thing on screen relative to what
   * it holds is a menu nobody had written yet. INV-17 permits the fold because
   * the `⋯` that opens it is itself on screen and named.
   */
  const [controlsOpen, setControlsOpen] = useState(false)
  const showControls = controlsOpen
  const transcripts = hasTranscripts(agent.agentKind)
  // On a landscape phone the second answer option sits below this pane's fold
  // with nothing saying so; the fade is the something.
  const [paneRef, paneEdge] = useOverflowEdge<HTMLDivElement>()

  // Full screen replaces the panel entirely rather than rendering both, so the
  // conversation is not mounted twice and scrolled in two places.
  if (fullscreen) {
    return (
      <FullscreenView agent={agent} tab={tab} onTab={onTab} onExit={() => setFullscreen(false)} />
    )
  }

  const up = formatUptime(lang, uptimeParts(agent.startedAt))
  const subtitle = [
    isRenamed(agent) ? agent.name : '',
    tildePath(agent.cwd),
    agent.gitBranch,
    up ? `${t('uptimePrefix')} ${up}` : '',
    `pid ${agent.pid}`,
  ]
    .filter(Boolean)
    .join('  ·  ')

  /** The server's own sentence where there is one; a generic one otherwise. */
  const reasonNotAttachable = agent.attachBlockedReason ?? t('termNotAttachable')

  return (
    <section
      className={`${styles.detail} ${sheet ? styles.sheet : ''}`}
      data-testid="agent-detail"
      aria-label={agent.name}
    >
      <div className={styles.head} data-testid="detail-head">
        <Button
          variant="compact"
          className={styles.back}
          data-testid="back-button"
          aria-label={t('back')}
          title={t('back')}
          onClick={onClose}
        >
          <span aria-hidden="true">‹</span>
          <span className={styles.backLabel}> {t('backLabel')}</span>
        </Button>
        <h2 data-testid="detail-name" title={`${displayName(agent)} · ${agent.cwd}`}>
          {displayName(agent)}
        </h2>
        <span
          className={styles.pill}
          data-testid="detail-status"
          data-status={agent.status}
          title={statusText(agent)}
        >
          {/* Rendered, not CSS-hidden: two copies would be read out twice. On a
              narrow sheet the reason is spelled out in the banner below anyway,
              and dropping it gives the agent's name back its space. */}
          {sheet ? shortStatus(agent) : statusText(agent)}
        </span>
        {/* Elided to a cap, so `title` is the only place the whole path is
            still readable (see `.path` in the stylesheet). */}
        <span className={styles.path} title={subtitle}>
          {subtitle}
        </span>

        {/*
          * On a desktop the facts sit inside the header's row, the way the tabs
          * already do.
          *
          * They were a band of their own: 1406x32 at a 1440 viewport, 3.4% of
          * the screen for one 294px run of facts on a row that was otherwise
          * empty. The header had 18px of slack and could not take it — until
          * `.path` stopped claiming 621px of that row for a folder name. With
          * the path elided there is room for the facts beside it, so the band
          * goes and the facts stay.
          *
          * Two placements rather than one, and the reason is `.sheet .head`:
          * it is `flex-wrap: nowrap` on purpose, so a phone keeps the back
          * link, the name and the actions on a single line. Wrapping the facts
          * in beside them would squeeze that row rather than take a new one, so
          * below 900px they stay under the header, which is where a narrow
          * shape has the room anyway.
          */}
        {!sheet && <StatusLine agent={agent} />}

        {/*
          * The tabs share the header's row.
          *
          * They had one of their own, and the two rows came to 108px of a
          * phone screen whose whole job is showing a conversation — while the
          * tab row itself used 202px of 474 and left 272 empty. Merged, the
          * header carries both and the conversation gets the row back. It is
          * a `flex-wrap` rather than a breakpoint: what decides whether they
          * fit is the agent's *name*, which no media query knows, so on a
          * screen too narrow for both the tabs drop to their own line exactly
          * as they used to and nothing is lost.
          */}
        <div className={styles.tabs} role="tablist">
        {/*
          Hidden rather than empty. This agent's CLI keeps no transcript this
          app can read, so the conversation would be blank forever — and a blank
          Chat tab beside a working Attach tab reads as this app being broken
          rather than as the agent having nothing to show.
        */}
        {transcripts && (
          <button
            type="button"
            role="tab"
            className={styles.tab}
            data-testid="tab-chat"
            aria-selected={tab === 'chat'}
            onClick={() => onTab('chat')}
          >
            {t('tabChat')}
          </button>
        )}
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-testid="tab-attach"
          aria-selected={tab === 'attach'}
          disabled={!agent.paneId}
          onClick={() => onTab('attach')}
        >
          {t('tabAttach')}
        </button>
        {/*
          * Why the tab is greyed out, next to the tab.
          *
          * INV-5 says a degraded capability "renders a reason", and this one
          * had the reason and no way to read it: `attachBlockedReason` was only
          * shown inside the Attach view, which is precisely the view a
          * non-attachable agent cannot open. A disabled control cannot carry a
          * tooltip either — a browser fires no mouse events over it — so the
          * only place the sentence can live is beside it. Elided rather than
          * wrapped, so it can never add a row to the tab strip on a phone.
          */}
        {!agent.paneId && (
          <span className={styles.tabNote} data-testid="attach-blocked-note" title={reasonNotAttachable}>
            {reasonNotAttachable}
          </span>
        )}

        </div>

        {/*
          * One group, so the buttons wrap together onto the same line. Left as
          * separate children, the wider labelled ⤢ pushed `close` onto a row
          * of its own and grew the header by a whole line.
          *
          * Full screen is rendered once now rather than once per layout: it
          * used to be drawn in the header on a desktop and in the tab row on a
          * phone, which was two copies of one control kept apart only by the
          * breakpoint between them (FR-CTL-12).
          */}
        <div className={styles.headActions}>
          <Button
            variant="compact"
            data-testid="controls-toggle"
            aria-expanded={controlsOpen}
            title={t('agentSettings')}
            aria-label={t('agentSettings')}
            onClick={() => setControlsOpen((v) => !v)}
          >
            ⋯
          </Button>
          <Button
            variant="compact"
            data-testid="fullscreen-toggle"
            title={t('expand')}
            onClick={() => setFullscreen(true)}
          >
            {/* The word is dropped where the row is tightest, and the glyph is
                never the accessible name: `title` carries it either way. */}
            ⤢ <span className={styles.actionLabel}>{t('expand')}</span>
          </Button>
          {/* Keeps `.close`: the sheet hides this button, where `‹ Agents` is
              the way back and a second one would be two answers to one question. */}
          <Button variant="compact" className={styles.close} data-testid="close-button" onClick={onClose}>
            {t('close')}
          </Button>
        </div>

        {/*
          * On a desktop the facts sit inside the header's row, the way the tabs
          * already do.
          *
          * They were a band of their own: 1406x32 at a 1440 viewport, 3.4% of
          * the screen for one 294px run of facts on a row that was otherwise
          * empty. The header had 18px of slack and could not take it — until
          * `.path` stopped claiming 621px of that row for a folder name (see
          * `.path` in the stylesheet). With the path elided there is room for
          * the facts beside it, so the band goes and the facts stay.
          *
          * Two placements rather than one, and the reason is `.sheet .head`:
          * it is `flex-wrap: nowrap` on purpose, so that a phone keeps the back
          * link, the name and the actions on a single line. Wrapping the facts
          * in beside them would squeeze that row rather than take a new one, so
          * below 900px they stay where they were — under the header, which is
          * where a narrow shape has the room anyway.
          */}
      </div>

      {showControls && <AgentControls agent={agent} />}

      {sheet && <StatusLine agent={agent} />}

      <div className={styles.pane} ref={paneRef} data-overflow={paneEdge} data-testid="detail-pane">
        {agent.status === 'waiting' && (
          <BlockedBanner agent={agent} tab={tab} onOpenTerminal={() => onTab('attach')} />
        )}
        {tab === 'chat' ? (
          <Chat agent={agent} />
        ) : (
          <LazyTerminal agent={agent} onExit={onClose} />
        )}
      </div>
    </section>
  )
}

/**
 * What the session is doing, in one line under the tabs: its permission mode,
 * its model, and its delegates — the same claims the fleet card makes, on the
 * screen where they were missing. The card is glanced at; this is where the
 * work is read, and "which mode is this in" and "is the delegate still going"
 * are questions asked from here.
 *
 * Every figure is the session's own or an admission (INV-11): a mode is what
 * the transcript last recorded, or "not reported yet"; the delegates are the
 * sidecars' claims and nothing more (INV-13); a quiet family is asked about,
 * never pronounced on (INV-15). The graph comes from the store, filled by
 * whichever holder currently polls it.
 */
function StatusLine({ agent }: { agent: Agent }) {
  const t = useTranslate()
  const lang = useLang()
  const trees = useStore((s) => s.trees)
  const tree = trees.find((candidate) => candidate.sessionId === agent.sessionId)
  const claim = useMemo(() => claimOf(tree), [tree])
  const quietFor = formatUptime(lang, uptimeParts(agent.lastActivityAt))
  const stalled = isStallCandidate(agent, claim) && quietFor !== ''
  const mode = agent.permissionMode ? modeLabel(agent.permissionMode, t) : undefined
  const model = aliasOfModel(agent.model)

  /*
   * Only what this line can actually say. It used to carry a mode reading of
   * "not reported yet" — which is the usual answer, because Claude Code writes
   * the record at the end of a turn (INV-8) — beside "delegated nothing", and
   * for an ordinary idle agent that was 31px of screen saying nothing at all,
   * on the surface whose whole job is showing a conversation. The mode is on
   * the same screen either way: the composer's menu carries the control, and
   * a control that names its own state is a better home for it than a caption
   * that repeats it.
   *
   * `none` follows the fleet card's rule for the same reason it does there
   * (INV-13): "delegated nothing" answers a question a *working* agent raises
   * and nobody else asks. `unknown` and `some` stay whatever the status —
   * a count is worth a glance, and "cannot tell" is not something to bury.
   */
  const showDelegates = claim.kind !== 'unread' && (agent.status === 'busy' || claim.kind !== 'none')
  // Truthiness, not `!== undefined`: `aliasOfModel` answers with an empty
  // string for a model it cannot name, and an empty row is the thing being
  // removed here.
  const facts = [Boolean(mode), Boolean(model), showDelegates, stalled]
  if (!facts.some(Boolean)) return null

  return (
    <div className={styles.statusLine} data-testid="detail-status-line">
      {mode !== undefined && (
        <span className={styles.fact} data-testid="detail-mode" data-reported="true">
          <span className={styles.factLabel}>{t('modeLabel')}</span>
          {mode}
        </span>
      )}
      {model && (
        <span className={styles.fact} data-testid="detail-model">
          <span className={styles.factLabel}>{t('modelLabel')}</span>
          {model}
        </span>
      )}
      {showDelegates && <DelegateLine agent={agent} claim={claim} />}
      {stalled && (
        <span className={styles.stall} data-testid="detail-stall" title={t('stallQuestionTitle')}>
          {t('stallQuestion', { t: quietFor })}
        </span>
      )}
    </div>
  )
}

/**
 * A blocked agent is the whole reason to look at this app, so say plainly what
 * is wrong and put the action that fixes it one click away.
 */
function BlockedBanner({
  agent,
  tab,
  onOpenTerminal,
}: {
  agent: Agent
  tab: 'chat' | 'attach'
  onOpenTerminal: () => void
}) {
  const t = useTranslate()
  const key = agent.waitingFor ? REASON_KEY[agent.waitingFor] : undefined
  const reason = key ? t(key) : (agent.waitingFor ?? t('blockedReasonFallback'))
  /*
   * The Chat tab can now answer some of these itself (INV-16), and when it is
   * about to, "answer it in the terminal below" is the app contradicting itself
   * two inches above the buttons that do the job.
   */
  const answerable = useStore((s) => s.prompt) !== null

  return (
    <div className={styles.blocked} data-testid="blocked-banner">
      <div className={styles.blockedText}>
        <strong>{t('blockedTitle', { reason })}</strong>
        {t(
          !agent.paneId
            ? 'blockedBodyNotAttachable'
            : answerable && tab === 'chat'
              ? 'blockedBodyAnswerable'
              : 'blockedBodyAttachable',
        )}
      </div>
      {agent.paneId && (
        <Button
          className={styles.cta}
          data-testid="unblock-button"
          onClick={() => {
            if (tab === 'attach') {
              document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
            } else {
              onOpenTerminal()
            }
          }}
        >
          {t(tab === 'attach' ? 'focusTerminal' : 'openTerminal')}
        </Button>
      )}
    </div>
  )
}
