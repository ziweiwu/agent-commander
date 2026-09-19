import { memo, useState } from 'react'
import { parseBlocks, parseInline, type ChatMessage, type Span, type ToolCall } from '../lib/chat.ts'
import { clock } from '../lib/format.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import styles from './Message.module.css'
import { ICON_INLINE, Icon } from './ui/Icon.tsx'

/**
 * How many tool calls show before the rest collapse behind a summary.
 *
 * They are *shown*, which is what this constant always said and not what the
 * code did: a run long enough to collapse hid every row behind the toggle, so
 * five calls rendered in full and six rendered as the word "6 actions" and
 * nothing else. The reader lost the detail exactly where there was most of it.
 */
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
function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((span: Span, i: number) =>
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
    </>
  )
}

/**
 * A markdown table, as a real one.
 *
 * Every cell runs through the same inline parser the prose does, so a link in
 * a table is held to INV-18 exactly as a link in a sentence is — there is one
 * gate, and this is not a second path around it.
 *
 * The scroll box is INV-17, not decoration: a table is the one thing in a
 * conversation whose width is set by its content rather than by the column it
 * sits in, and a four-column table of file paths is wider than a phone. The
 * page may never scroll sideways, so the table does instead.
 */
function Table({ block }: { block: Extract<ReturnType<typeof parseBlocks>[number], { kind: 'table' }> }) {
  return (
    <div className={styles.tableWrap} data-testid="message-table">
      <table className={styles.table}>
        <thead>
          <tr>
            {block.head.map((cell, i) => (
              <th key={i} style={{ textAlign: block.align[i] ?? 'left' }}>
                <Inline text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={{ textAlign: block.align[c] ?? 'left' }}>
                  <Inline text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RichText({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  /*
   * The overwhelmingly common message is one paragraph, and it is rendered
   * exactly as it was before tables existed: one `pre-wrap` box, no wrapper,
   * no gap.
   *
   * That is not a micro-optimisation, it is a height guarantee. Wrapping every
   * message in a grid gave each one a gap it did not have before, every
   * message in the conversation grew, and with an on-screen keyboard up the
   * message being replied to was pushed out of the visible band — which is the
   * thing INV-17's keyboard clause exists to prevent, reintroduced by a
   * container added for a feature most messages never use.
   */
  if (blocks.length === 1 && blocks[0]?.kind === 'p') {
    return (
      <div className={`${styles.text} ${styles.para}`} data-testid="message-text">
        <Inline text={blocks[0].text} />
      </div>
    )
  }
  return (
    <div className={`${styles.text} ${styles.blocks}`} data-testid="message-text">
      {blocks.map((block, i) =>
        block.kind === 'table' ? (
          <Table key={i} block={block} />
        ) : (
          <p key={i} className={styles.para}>
            <Inline text={block.text} />
          </p>
        ),
      )}
    </div>
  )
}

function Tools({ message }: { message: ChatMessage }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const tools = message.tools
  // Worth a toggle only when it hides more than one row: a control that
  // reveals a single line costs a press to save a line.
  const hidden = tools.length - VISIBLE_TOOLS
  const collapsible = hidden > 1
  const shown = collapsible && !open ? tools.slice(0, VISIBLE_TOOLS) : tools

  const row = (call: ToolCall) => (
    <div
      key={call.id}
      className={`${styles.tool} ${call.subagent ? styles.subagent : ''}`}
      data-testid="tool-call"
      title={call.text ? `${call.tool}: ${call.text}` : call.tool}
    >
      <span className={styles.toolName}>{call.tool}</span>
      {/*
        * Through the inline parser, so a `WebFetch` argument — which is
        * usually nothing but a URL — is a link here as it would be in a
        * sentence. Same gate, same INV-18: `parseInline` is the only thing
        * that ever produces an href, and this is not a way around it.
        */}
      {call.text && (
        <span className={styles.toolArg}>
          <Inline text={call.text} />
        </span>
      )}
    </div>
  )

  return (
    <div className={styles.tools}>
      {shown.map(row)}
      {collapsible && (
        <button
          type="button"
          className={styles.toggle}
          data-testid="tools-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={ICON_INLINE} />{' '}
          {open ? t('actionsFewer') : t('actionsMore', { n: hidden })}
        </>
        </button>
      )}
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
