/**
 * Turns the flat transcript event stream into a conversation.
 *
 * The transcript is a log: prompt, reply, tool, tool, tool, reply. Read as a
 * chat it needs two things the log does not have — the tool calls folded into
 * the message they belong to, so they read as "what the agent did" rather than
 * as separate utterances, and consecutive messages from the same speaker
 * grouped under one header.
 */
import type { TimelineEvent } from '../../shared/types.ts'

export type Role = 'you' | 'agent'

export interface ToolCall {
  id: string
  tool: string
  text: string
  subagent: boolean
}

export interface ChatMessage {
  id: string
  role: Role
  at: number
  text: string
  tools: ToolCall[]
  /** True when this continues the previous speaker's run and needs no header. */
  grouped: boolean
  /** Sent from this browser but not yet echoed back by the transcript. */
  pending?: boolean
  failed?: boolean
}

/** Messages closer together than this from the same speaker share a header. */
const GROUP_WINDOW_MS = 120_000

export function buildMessages(events: TimelineEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []

  const push = (role: Role, at: number, text: string, id: string): ChatMessage => {
    const prev = messages.at(-1)
    const grouped = prev !== undefined && prev.role === role && at - prev.at < GROUP_WINDOW_MS
    const message: ChatMessage = { id, role, at, text, tools: [], grouped }
    messages.push(message)
    return message
  }

  for (const event of events) {
    switch (event.kind) {
      case 'user':
        push('you', event.at, event.text, event.id)
        break

      case 'assistant':
        push('agent', event.at, event.text, event.id)
        break

      case 'tool':
      case 'subagent': {
        const call: ToolCall = {
          id: event.id,
          tool: event.tool ?? 'tool',
          text: event.text,
          subagent: event.kind === 'subagent',
        }
        const last = messages.at(-1)
        // Attach to the agent message this work belongs to. A tool call that
        // arrives before any reply (the agent acting immediately) gets a
        // headless message of its own so nothing is dropped.
        if (last && last.role === 'agent') last.tools.push(call)
        else push('agent', event.at, '', event.id).tools.push(call)
        break
      }

      case 'notice':
        break
    }
  }

  return messages
}

/** A locally-echoed message, shown immediately so sending feels instant. */
export function pendingMessage(text: string, at: number, seq: number): ChatMessage {
  return { id: `pending-${seq}`, role: 'you', at, text, tools: [], grouped: false, pending: true }
}

/**
 * Drop local echoes the transcript has now confirmed.
 *
 * The agent writes the prompt into its own transcript, so the same text comes
 * back as a real event. Matching on text is enough here: a duplicate would only
 * occur if the user sent the identical message twice before the first was
 * echoed, and collapsing those is the friendlier failure.
 */
export function reconcile(confirmed: ChatMessage[], pending: ChatMessage[]): ChatMessage[] {
  if (pending.length === 0) return confirmed
  const seen = new Set(confirmed.filter((m) => m.role === 'you').map((m) => m.text.trim()))
  const unconfirmed = pending.filter((m) => !seen.has(m.text.trim()))
  if (unconfirmed.length === 0) return confirmed
  const merged = [...confirmed, ...unconfirmed]
  // Re-derive grouping now that the tail has changed.
  for (let i = 1; i < merged.length; i += 1) {
    const prev = merged[i - 1] as ChatMessage
    const cur = merged[i] as ChatMessage
    cur.grouped = prev.role === cur.role && cur.at - prev.at < GROUP_WINDOW_MS
  }
  return merged
}

/* ---- inline formatting ---- */

export type SpanKind = 'text' | 'code' | 'bold' | 'italic'

export interface Span {
  kind: SpanKind
  text: string
}

/*
 * Order matters: code first so backticks win over emphasis inside them, and
 * **bold** before *italic* so the double marker is not eaten as two italics.
 *
 * The two emphasis forms are separate rules, each requiring its own delimiter
 * on both sides. A single combined `(?:\*|_)…(?:\*|_)` let `*` close with `_`,
 * and matched underscores inside a word — so `__init__.py` rendered as
 * `_init_.py` and `react_hig_datepicker` lost its underscores. Underscore
 * emphasis therefore also requires a non-word character on each side, which is
 * how CommonMark avoids exactly this.
 */
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g

/**
 * Parse the small subset of markdown agents actually use in prose.
 *
 * Returns spans rather than HTML: the caller builds text nodes from them, so
 * transcript content can never inject markup into the page.
 */
export function parseInline(text: string): Span[] {
  const spans: Span[] = []
  let last = 0
  INLINE.lastIndex = 0

  for (let m = INLINE.exec(text); m !== null; m = INLINE.exec(text)) {
    if (m.index > last) spans.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[1] !== undefined) spans.push({ kind: 'code', text: m[1] })
    else if (m[2] !== undefined) spans.push({ kind: 'bold', text: m[2] })
    else if (m[3] !== undefined) spans.push({ kind: 'italic', text: m[3] })
    else if (m[4] !== undefined) spans.push({ kind: 'italic', text: m[4] })
    last = m.index + m[0].length
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) })
  return spans.length > 0 ? spans : [{ kind: 'text', text }]
}

/**
 * Render inline markdown as plain text, for somewhere that cannot show it.
 *
 * The card's activity line is a single row of text, so `**bold**` and
 * `` `code` `` would otherwise show their markers.
 *
 * Only *matched* markers are removed — the same ones `parseInline` recognises.
 * A blanket strip was tried and reverted: it deleted every literal `*`, `_` and
 * backtick, turning "5 * 3 = 15" into "5  3 = 15" and "__init__.py" into
 * "init.py". An unpaired marker left visible is a cosmetic blemish; silently
 * corrupting a filename or a sum is a lie about what the agent said.
 */
export function plainText(text: string): string {
  return parseInline(text)
    .map((span) => span.text)
    .join('')
    .trim()
}
