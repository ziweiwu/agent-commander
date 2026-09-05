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

export type Role = 'you' | 'agent' | 'notice'

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
  /**
   * Sent to an agent that was working, and waiting its turn at the prompt.
   *
   * Claude Code writes a prompt into its transcript when it *processes* it, not
   * when it arrives, so a message queued behind a long turn is unconfirmable
   * for as long as that turn lasts — which is minutes, not seconds. Counting it
   * down like an ordinary send marked correctly-delivered messages as failed;
   * this is the state that says "waiting", and the countdown does not start
   * until the agent stops working.
   */
  queued?: boolean
  failed?: boolean
  /**
   * How many copies of this exact text were already in the conversation when
   * it was sent. See `reconcile` — this is what tells a fresh "Continue" apart
   * from the four before it.
   */
  priorCopies?: number
  /**
   * For `role === 'notice'`: what happened, and the numbers behind it.
   *
   * Carried rather than pre-formatted so the reader sees it in their own
   * language — the server has no business writing a sentence into a
   * conversation.
   */
  notice?: 'compacted' | 'compactedAuto'
  tokensBefore?: number
  tokensAfter?: number
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

      /*
       * A compaction. Stands on its own rather than folding into a message: it
       * is not something either party said, it is a change to what the agent
       * can still remember, and it belongs at the point in the conversation
       * where the memory was cut.
       */
      case 'notice': {
        const message = push('notice', event.at, '', event.id)
        message.grouped = false
        if (event.notice) message.notice = event.notice
        if (event.tokensBefore !== undefined) message.tokensBefore = event.tokensBefore
        if (event.tokensAfter !== undefined) message.tokensAfter = event.tokensAfter
        break
      }
    }
  }

  return messages
}

/** A locally-echoed message, shown immediately so sending feels instant. */
export function pendingMessage(
  text: string,
  at: number,
  seq: number,
  priorCopies = 0,
  queued = false,
): ChatMessage {
  return {
    id: `pending-${seq}`,
    role: 'you',
    at,
    text,
    tools: [],
    grouped: false,
    pending: true,
    ...(queued ? { queued: true } : {}),
    priorCopies,
  }
}

/** How many times you have already said this, counting messages still in flight. */
export function countSaid(messages: ChatMessage[], text: string): number {
  const key = text.trim()
  // A failed message is one the transcript never recorded, so it is not
  // something the next copy of this text can be confirmed by.
  return messages.filter(
    (m) => m.role === 'you' && m.failed !== true && m.text.trim() === key,
  ).length
}

/**
 * Drop local echoes the transcript has now confirmed.
 *
 * The agent writes the prompt into its own transcript, so the same text comes
 * back as a real event. What identifies it is not the text alone but the text
 * having appeared *once more* than it had when we sent it: the quick prompts
 * are "Continue" and "Go ahead", so matching on text alone meant the second
 * "Continue" was reconciled against the first one an hour earlier. The echo
 * vanished the instant it was drawn, and — worse — the delivery timer was
 * cancelled with it, so a message that never arrived was never marked
 * undelivered either. INV-2 says an unconfirmed message is marked rather than
 * retried; that only means anything if the app can tell it apart.
 *
 * Counting, not timestamps. The two clocks here are a phone's and this Mac's,
 * and a comparison between them would leave every echo on a slightly fast
 * phone looking older than its own confirmation.
 *
 * The baseline is taken when the message is sent, so the one case still not
 * distinguished is a message sent in the second before the backfill for that
 * agent arrives: the history it was measured against was empty, and the
 * backfill may bring an older identical message with it. Re-baselining on the
 * backfill was tried and is worse — it cannot tell "this backfill contains an
 * older copy" from "this backfill contains mine", so a delivered message would
 * be marked undelivered and the user would send it to a live agent twice.
 */
export function reconcile(confirmed: ChatMessage[], pending: ChatMessage[]): ChatMessage[] {
  if (pending.length === 0) return confirmed
  const unconfirmed = pending.filter(
    (m) => countSaid(confirmed, m.text) <= (m.priorCopies ?? 0),
  )
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

export type SpanKind = 'text' | 'code' | 'bold' | 'italic' | 'link'

export interface Span {
  kind: SpanKind
  text: string
  /** Set on a `link` span and nothing else; always `http:` or `https:`. */
  href?: string
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
 *
 * Links sit between code and emphasis. After code, so a URL an agent quoted in
 * backticks stays the literal text it was shown as. Before emphasis, so the
 * `_` and `*` a URL path can carry are never read as markers — though a URL
 * *inside* `**bold**` is still bold text rather than a link, because the
 * earlier marker wins the position and this parser does not nest.
 *
 * Only `http` and `https` are ever matched. The pattern is one of two gates —
 * `linkHref` below is the other — and both have to agree before a string from
 * a transcript becomes somewhere the browser will go.
 */
const INLINE =
  /`([^`\n]+)`|\[([^[\]\n]+)\]\((https?:\/\/[^\s]*)|(https?:\/\/[^\s<>"'`]+)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g

/*
 * A link's label may not itself contain `[`: with it allowed, the outer half
 * of `[a [b](https://x.test)](https://y.test)` matched as one label ending at
 * the *inner* close bracket, and the rest rendered as stray `](` text beside a
 * second link. Refusing the opener makes the inner link the one that matches,
 * which is what a reader would have pointed at.
 *
 * The markdown URL runs to whitespace and the pattern names no closing paren:
 * `markdownUrlEnd` finds it, because the URL may hold parens of its own.
 * `[^\s)]+\)` closed at the *first* `)`, which cut
 * `[Bash](https://en.wikipedia.org/wiki/Bash_(Unix_shell))` to a valid link
 * for the wrong page and left a stray `)` in the prose.
 */

/**
 * Where a markdown link's URL ends: the first `)` that no `(` inside the URL
 * is still waiting for. `undefined` when there is none, in which case the text
 * was never a link.
 */
function markdownUrlEnd(candidate: string): number | undefined {
  let depth = 0
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      if (depth === 0) return i
      depth -= 1
    }
  }
  return undefined
}

/** What a sentence leaves after a URL and a URL never ends with. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}'])

/** Each closing bracket a sentence might leave, and the opener that keeps it. */
const OPENER_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const OPENERS = new Set(Object.values(OPENER_OF))

/**
 * A bare URL's end is a guess, because prose does not delimit it: "see
 * https://x.test/a." ends at the `a`, not the `.`. A closing bracket is kept
 * only when the URL itself opened one, which is how a Wikipedia title, a
 * `{id}` path template and an IPv6 host all survive while "(https://x.test)"
 * does not swallow its paren.
 *
 * The balance is taken once and walked back as characters are shed, because
 * recounting the prefix per shed character was quadratic, and a run of twenty
 * thousand parens — which a transcript can carry — took seconds to strip.
 */
function withoutTrailingPunctuation(url: string): string {
  // Opens minus closes, per bracket pair, over the whole candidate.
  const balance = new Map<string, number>()
  for (const ch of url) {
    if (OPENERS.has(ch)) balance.set(ch, (balance.get(ch) ?? 0) + 1)
    const opener = OPENER_OF[ch]
    if (opener !== undefined) balance.set(opener, (balance.get(opener) ?? 0) - 1)
  }

  let end = url.length
  while (end > 0) {
    const last = url[end - 1] as string
    if (!TRAILING_PUNCTUATION.has(last)) break
    const opener = OPENER_OF[last]
    if (opener !== undefined) {
      const opened = balance.get(opener) ?? 0
      // Nothing before it is left unclosed: the URL opened this one.
      if (opened >= 0) break
      balance.set(opener, opened + 1)
    }
    end -= 1
  }
  return url.slice(0, end)
}

/**
 * The one place a string from a transcript becomes an `href`.
 *
 * Spans are rendered as React elements rather than HTML, so nothing here can
 * inject markup — but an `href` is the one attribute that carries a scheme,
 * and `javascript:` in one runs. The pattern above admits only `http://` and
 * `https://`; this checks the parsed result as well, because a regex is a
 * claim about the text and `new URL` is a claim about the URL. Anything that
 * fails either stays the literal text it arrived as (INV-18).
 */
export function linkHref(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.hostname === '') return undefined
  return url.href
}

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
    let end = m.index + m[0].length
    // The alternatives of INLINE, in the order it spells them.
    const [whole, code, label, labelled, bare, bold, starred, underscored] = m
    if (code !== undefined) spans.push({ kind: 'code', text: code })
    else if (labelled !== undefined) {
      // The match ran to whitespace; the link ends at its own close paren, and
      // whatever follows that is prose the next match may start inside.
      const close = markdownUrlEnd(labelled)
      if (close === undefined) spans.push({ kind: 'text', text: whole })
      else {
        const before = whole.length - labelled.length
        end = m.index + before + close + 1
        spans.push(link(label as string, labelled.slice(0, close), text.slice(m.index, end)))
        INLINE.lastIndex = end
      }
    } else if (bare !== undefined) {
      const url = withoutTrailingPunctuation(bare)
      spans.push(link(url, url, url))
      // The punctuation handed back is prose, and the next match may start
      // inside it — "(https://a.test)(https://b.test)" is two links.
      end = m.index + url.length
      INLINE.lastIndex = end
    } else if (bold !== undefined) spans.push({ kind: 'bold', text: bold })
    else if (starred !== undefined) spans.push({ kind: 'italic', text: starred })
    else if (underscored !== undefined) spans.push({ kind: 'italic', text: underscored })
    last = end
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) })
  return spans.length > 0 ? spans : [{ kind: 'text', text }]
}

/** A link where `linkHref` agrees, and the text it was written as where not. */
function link(label: string, raw: string, literal: string): Span {
  const href = linkHref(raw)
  return href === undefined ? { kind: 'text', text: literal } : { kind: 'link', text: label, href }
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
