import { memo, useState } from 'react'
import { parseInline, type ChatMessage, type ToolCall } from '../lib/chat.ts'
import { clock } from '../lib/format.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import styles from './Message.module.css'

/** How many tool calls show before the run collapses behind a summary. */
const VISIBLE_TOOLS = 4

/** Compact 886876 to "887k" — a token count is read for its order of magnitude. */
function tokens(value: number | undefined): string {
  if (value === undefined) return '?'
  if (value < 1000) return String(value)
  return `${Math.round(value / 1000)}k`
}

export const Message = memo(function Message({ message }: { message: ChatMessage }) {
  const t = useTranslate()

  /*
   * A compaction is not something either party said, so it is not drawn as a
   * message. It is a mark on the conversation at the point where the agent's
   * memory was cut, which is the only place it means anything.
   */
  if (message.role === 'notice') {
    return (
      <div className={styles.notice} data-testid="notice" data-notice={message.notice}>
        <span className={styles.noticeText}>
          {t(message.notice === 'compactedAuto' ? 'compactedAuto' : 'compacted', {
            before: tokens(message.tokensBefore),
            after: tokens(message.tokensAfter),
          })}
        </span>
        <time className={styles.noticeTime}>{clock(message.at)}</time>
      </div>
    )
  }

  const classes = [styles.msg]
  if (message.role === 'you') classes.push(styles.you)
  if (!message.grouped) classes.push(styles.ungrouped)
  if (message.pending) classes.push(styles.pending)
  if (message.failed) classes.push(styles.failed)

  // Rendered in both branches below. It used to live only in the header, so a
  // second message sent within the grouping window — which has no header —
  // showed no delivery state at all.
  const state = message.failed ? (
    <span
      className={`${styles.state} ${styles.failedState}`}
      data-testid="message-failed"
      title={t('notDeliveredHint')}
    >
      {t('notDelivered')}
    </span>
  ) : message.queued ? (
    /*
     * A third state, not a variant of "sending". The agent was working when
     * this was sent, so it is waiting its turn at the prompt — and Claude Code
     * writes a message down only when it processes it. Saying "sending…" for
     * the minutes a turn can take invites the user to send it again.
     */
    <span className={styles.state} data-testid="message-queued" title={t('queuedHint')}>
      {t('queued')}
    </span>
  ) : message.pending ? (
    <span className={styles.state}>{t('sending')}</span>
  ) : null

  return (
    <div className={classes.join(' ')} data-testid="message" data-role={message.role}>
      {message.grouped ? (
        // Slack's trick: a grouped message keeps its timestamp in the gutter,
        // revealed on hover, so a long run never loses its time anchor.
        <>
          <time className={styles.gutter}>{clock(message.at)}</time>
          {state}
        </>
      ) : (
        <div className={styles.head}>
          <span
            className={`${styles.who} ${message.role === 'you' ? styles.whoYou : styles.whoAgent}`}
            data-testid="message-author"
          >
            {t(message.role === 'you' ? 'you' : 'agent')}
          </span>
          <time className={styles.time}>{clock(message.at)}</time>
          {state}
        </div>
      )}

      {message.text && <RichText text={message.text} />}
      {message.tools.length > 0 && <Tools message={message} />}
    </div>
  )
})

/**
 * Inline markdown rendered as React elements, never as HTML, so transcript
 * content cannot inject markup into the page.
 *
 * A link is the one span that reaches outside the page, so it is held to
 * INV-18: the `href` is whatever `parseInline` vetted and nothing else; it
 * opens in a new tab, because navigating this one away drops the socket and
 * every focus with it; `noopener` so the page it opens cannot reach back into
 * this one; and `noreferrer` so the dashboard's own address — a tailnet name,
 * when it is being used from a phone — is not handed to whatever the agent
 * linked to.
 */
function RichText({ text }: { text: string }) {
  return (
    <div className={styles.text} data-testid="message-text">
      {parseInline(text).map((span, i) =>
        span.kind === 'link' ? (
          <a
            key={i}
            href={span.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="message-link"
            // Inline in a sentence, so the touch-target sweeps (e2e and the
            // audit scripts) apply WCAG 2.5.8's inline exemption to it and to
            // nothing else. One attribute, read by every sweep.
            data-inline="true"
          >
            {span.text}
          </a>
        ) : span.kind === 'code' ? (
          <code key={i}>{span.text}</code>
        ) : span.kind === 'bold' ? (
          <strong key={i}>{span.text}</strong>
        ) : span.kind === 'italic' ? (
          <em key={i}>{span.text}</em>
        ) : (
          <span key={i}>{span.text}</span>
        ),
      )}
    </div>
  )
}

function Tools({ message }: { message: ChatMessage }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const tools = message.tools
  const collapsible = tools.length - VISIBLE_TOOLS > 1

  const row = (call: ToolCall) => (
    <div
      key={call.id}
      className={`${styles.tool} ${call.subagent ? styles.subagent : ''}`}
      data-testid="tool-call"
      title={call.text ? `${call.tool}: ${call.text}` : call.tool}
    >
      <span className={styles.toolName}>{call.tool}</span>
      {call.text && <span className={styles.toolArg}>{call.text}</span>}
    </div>
  )

  if (!collapsible) return <div className={styles.tools}>{tools.map(row)}</div>

  return (
    <div className={styles.tools}>
      <button
        type="button"
        className={styles.toggle}
        data-testid="tools-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} {t('actionsCount', { n: tools.length })}
      </button>
      {open && tools.map(row)}
    </div>
  )
}

export function WorkingIndicator() {
  const t = useTranslate()
  return (
    <div className={styles.msg} data-testid="working-indicator">
      <div className={styles.working}>
        <div className={styles.dots}>
          <i />
          <i />
          <i />
        </div>
        <span>{t('working')}</span>
      </div>
    </div>
  )
}
