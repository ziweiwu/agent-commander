import { memo, useState } from 'react'
import { parseInline, type ChatMessage, type ToolCall } from '../lib/chat.ts'
import { clock } from '../lib/format.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import styles from './Message.module.css'

/** How many tool calls show before the run collapses behind a summary. */
const VISIBLE_TOOLS = 4

export const Message = memo(function Message({ message }: { message: ChatMessage }) {
  const t = useTranslate()
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
 */
function RichText({ text }: { text: string }) {
  return (
    <div className={styles.text} data-testid="message-text">
      {parseInline(text).map((span, i) =>
        span.kind === 'code' ? (
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
