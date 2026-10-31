import { memo, useId, useState } from 'react'
import type { Hunk, NoticeKind, ToolResultView } from '../../shared/types.ts'
import {
  outcomeWords,
  parseBlocks,
  parseInline,
  parseLinks,
  type ChatMessage,
  type OutcomeWords,
  type Span,
  type ToolCall,
} from '../lib/chat.ts'
import { clock } from '../lib/format.ts'
import type { Key } from '../lib/i18n.ts'
import { textLang } from '../lib/promptLang.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useStore, type ToolResultEntry } from '../store/store.ts'
import { requestToolResult } from '../store/transport.ts'
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

  if (message.role === 'notice') return <Notice message={message} />

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
  const readMidTurn = message.midTurn ? (
    <span className={styles.state} data-testid="message-mid-turn" title={t('readMidTurnHint')}>
      {t('readMidTurn')}
    </span>
  ) : null

  return (
    <div className={classes.join(' ')} data-testid="message" data-role={message.role}>
      {message.grouped ? (
        // Slack's trick: a grouped message keeps its timestamp in the gutter,
        // revealed on hover, so a long run never loses its time anchor.
        <>
          <time className={styles.gutter}>{clock(message.at)}</time>
          {readMidTurn}
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
          {readMidTurn}
          {state}
        </div>
      )}

      {message.text && <RichText text={message.text} />}
      {message.tools.length > 0 && <Tools message={message} />}
    </div>
  )
})

/** The disclosure that keeps what another agent said one tap away, by notice. */
const SHOW_WHAT_WAS_SAID: Partial<Record<NoticeKind, Key>> = {
  handback: 'noticeShowReport',
  peerMessage: 'noticeShowMessage',
}

/** The line a notice reads as, in the reader's language. */
function noticeLine(message: ChatMessage, translate: Translate): string {
  const name = message.from
  switch (message.notice) {
    case 'handback':
      return name ? translate('noticeHandback', { name }) : translate('noticeHandbackUnnamed')
    case 'peerMessage':
      return name ? translate('noticePeerMessage', { name }) : translate('noticePeerMessageUnnamed')
    case 'taskEnded':
      return message.text
        ? translate('noticeTaskEnded', { summary: message.text })
        : translate('noticeTaskEndedBare')
    default:
      return translate(message.notice === 'compactedAuto' ? 'compactedAuto' : 'compacted', {
        before: tokens(message.tokensBefore),
        after: tokens(message.tokensAfter),
      })
  }
}

/**
 * A mark on the conversation rather than a message, because nobody said it to
 * the reader.
 *
 * A compaction marks the point where the agent's memory was cut, which is the
 * only place it means anything. A delegate's hand-back, another agent's
 * message and a background task's end mark where they arrived: Claude Code
 * files each as a `user` record, and drawing one as "you" put words in the
 * reader's mouth (INV-11). What another agent said was said to the agent, so
 * it waits behind a closed native disclosure, drawn only when there is
 * something to disclose.
 */
function Notice({ message }: { message: ChatMessage }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const line = noticeLine(message, t)
  const show = message.notice === undefined ? undefined : SHOW_WHAT_WAS_SAID[message.notice]

  return (
    <div className={styles.noticeBlock} data-testid="notice" data-notice={message.notice}>
      <div className={styles.notice}>
        <span className={styles.noticeText} data-testid="notice-text" title={line}>
          {line}
        </span>
        <time className={styles.noticeTime}>{clock(message.at)}</time>
      </div>
      {show !== undefined && message.text !== '' && (
        <details
          className={styles.noticeSaid}
          data-testid="notice-disclosure"
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary className={styles.noticeToggle}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={ICON_INLINE} />
            {t(show)}
          </summary>
          <div className={styles.noticeSaidText} data-testid="notice-said" lang={textLang(message.text)}>
            {message.text}
          </div>
        </details>
      )}
    </div>
  )
}

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
function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span: Span, i: number) =>
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

/** Prose: the full inline subset — links, code, emphasis. */
function Inline({ text }: { text: string }) {
  return <Spans spans={parseInline(text)} />
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
  const lang = textLang(text)
  if (blocks.length === 1 && blocks[0]?.kind === 'p') {
    return (
      <div className={`${styles.text} ${styles.para}`} data-testid="message-text" lang={lang}>
        <Inline text={blocks[0].text} />
      </div>
    )
  }
  return (
    <div className={`${styles.text} ${styles.blocks}`} data-testid="message-text" lang={lang}>
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

  return (
    <div className={styles.tools}>
      {shown.map((call) => (
        <ToolRow key={call.id} call={call} />
      ))}
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

type Translate = ReturnType<typeof useTranslate>

/** An outcome in the reader's words: `+12 −3`, `failed`, `refused · auto mode · …`. */
function sayOutcome(words: OutcomeWords, translate: Translate): string {
  if (words.kind === 'ok') return words.counts
  if (words.kind === 'failed') return translate('outcomeFailed')
  const by = {
    autoMode: translate('refusedByAutoMode'),
    hook: translate('refusedByHook'),
    you: translate('refusedByYou'),
  }
  return [translate('outcomeRefused'), words.by && by[words.by], words.category].filter(Boolean).join(' · ')
}

/**
 * One call: its name, what it was called on, and how it ended. A call whose
 * result is on record opens to show it.
 *
 * The argument goes through the inline parser, so a `WebFetch` argument —
 * which is usually nothing but a URL — is a link here as it would be in a
 * sentence. Same gate, same INV-18: `parseInline` is the only thing that ever
 * produces an href, and this is not a way around it.
 */
function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const [asked, setAsked] = useState<Asked>('sent')
  const panel = useId()
  const toolUseId = call.outcome ? call.toolUseId : undefined
  const toggle = () => {
    if (!open && toolUseId) setAsked(requestToolResult(toolUseId) ? 'sent' : 'offline')
    setOpen((was) => !was)
  }
  return (
    <>
      <div
        className={`${styles.tool} ${call.subagent ? styles.subagent : ''}`}
        data-testid="tool-call"
        title={call.text ? `${call.tool}: ${call.text}` : call.tool}
      >
        {toolUseId ? (
          <ToolButton call={call} shown={open ? 'open' : 'closed'} panel={panel} onToggle={toggle} />
        ) : (
          <span className={styles.toolName}>{call.tool}</span>
        )}
        {call.text && (
          <span className={styles.toolArg}>
            <Spans spans={parseLinks(call.text)} />
          </span>
        )}
        <OutcomeCell call={call} />
      </div>
      {open && toolUseId && <ToolResult id={panel} tool={call.tool} toolUseId={toolUseId} asked={asked} />}
    </>
  )
}

/** Whether a row's result is on screen. */
type Shown = 'open' | 'closed'

/**
 * The name of a call that can open, as the button that opens it.
 *
 * The button is stretched over the whole row, so a tap anywhere on a phone
 * opens it while a link in the argument stays a link (INV-18) rather than a
 * link inside a button, which is not a thing a page may contain.
 */
function ToolButton(props: { call: ToolCall; shown: Shown; panel: string; onToggle: () => void }) {
  const t = useTranslate()
  const open = props.shown === 'open'
  return (
    <button
      type="button"
      className={styles.toolButton}
      data-testid="tool-expand"
      aria-expanded={open}
      aria-controls={open ? props.panel : undefined}
      aria-label={`${props.call.tool} — ${t('toolResultShow')}`}
      onClick={props.onToggle}
    >
      <span className={styles.toolName}>{props.call.tool}</span>
    </button>
  )
}

function OutcomeCell({ call }: { call: ToolCall }) {
  const t = useTranslate()
  const words = outcomeWords(call.outcome)
  if (!words) return null
  return (
    <span className={styles.outcome} data-testid="tool-outcome" data-kind={words.kind}>
      {sayOutcome(words, t)}
    </span>
  )
}

/** Whether a row's request went out, or could not for want of a socket. */
type Asked = 'sent' | 'offline'

/** What the row says while its record is not in hand. */
function statusKey(entry: ToolResultEntry | undefined, asked: Asked) {
  if (entry?.state === 'missing') return 'toolResultMissing'
  return !entry && asked === 'offline' ? 'toolResultOffline' : 'toolResultReading'
}

/**
 * What a call returned, as it was recorded — never as the file is now.
 *
 * It scrolls inside its own box, both ways, so a long line in a diff can never
 * push the page sideways on a phone (INV-17), and its caption says when the
 * record was written, because a diff read back later is a memory (INV-11).
 */
function ToolResult(props: { id: string; tool: string; toolUseId: string; asked: Asked }) {
  const t = useTranslate()
  const entry: ToolResultEntry | undefined = useStore((s) => s.toolResults[props.toolUseId])
  const label = t('toolResultLabel', { tool: props.tool })
  return (
    <div id={props.id} className={styles.result} data-testid="tool-result" role="region" aria-label={label}>
      {entry?.state === 'ready' ? (
        <Recorded view={entry.view} label={label} />
      ) : (
        <p className={styles.resultCaption} data-testid="tool-result-status">
          {t(statusKey(entry, props.asked))}
        </p>
      )}
    </div>
  )
}

/** The bytes a reply left out, as a reader counts them. */
function size(bytes: number): string {
  const KIB = 1024
  return bytes < KIB ? `${bytes} B` : `${Math.ceil(bytes / KIB)} KB`
}

function Recorded({ view, label }: { view: ToolResultView; label: string }) {
  const t = useTranslate()
  const time = clock(view.at)
  const caption = [t(view.hunks ? 'toolResultEditAt' : 'toolResultAt', { time })]
  if (view.userModified) caption.push(t('toolResultUserModified'))
  const more = view.omitted > 0 ? size(view.omitted) : null
  return (
    <>
      <p className={styles.resultCaption} data-testid="tool-result-caption">
        {caption.join(' · ')}
      </p>
      {more && !view.hunks && <p className={styles.resultMore}>{t('toolResultMoreBefore', { size: more })}</p>}
      <div className={styles.resultBody} data-testid="tool-result-body" tabIndex={0} aria-label={label}>
        <pre className={styles.resultText}>
          {view.hunks ? view.hunks.map((hunk, i) => <HunkLines key={i} hunk={hunk} />) : view.output}
        </pre>
      </div>
      {more && view.hunks && <p className={styles.resultMore}>{t('toolResultMoreAfter', { size: more })}</p>}
    </>
  )
}

/** One hunk under its header, each line marked by the prefix it carries. */
function HunkLines({ hunk }: { hunk: Hunk }) {
  const kind = (line: string) => (line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx')
  return (
    <>
      <span className={styles.hunkHead}>{`@@ -${hunk.oldStart} +${hunk.newStart} @@\n`}</span>
      {hunk.lines.map((line, i) => (
        <span key={i} className={styles.hunkLine} data-line={kind(line)}>
          {`${line}\n`}
        </span>
      ))}
    </>
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
