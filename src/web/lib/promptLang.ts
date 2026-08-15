import type { Lang } from './i18n.ts'
import type { ChatMessage } from './chat.ts'

/**
 * Which language to offer the quick prompts in.
 *
 * The interface language is the wrong answer here. It says how *you* want the
 * app labelled; the prompt is not label text, it is a message that goes to the
 * agent and lands in its transcript. Someone reading an English UI while
 * working with an agent in Chinese wants to send 继续, and switching the whole
 * interface to get it is a silly price.
 *
 * So the conversation decides. The interface language is only the fallback,
 * for a chat with nothing in it yet.
 */
const HAN = /\p{Script=Han}/gu
const LETTERS = /[\p{Letter}\p{Number}]/gu

/** How many recent messages count as "what this conversation is written in". */
const RECENT = 5

/**
 * Han characters as a share of all letters, above which the conversation reads
 * as Chinese. A threshold rather than "any Han character at all" because an
 * English conversation quoting a Chinese filename or a 中文 term in passing is
 * still an English conversation.
 */
const HAN_SHARE = 0.1

export function conversationLang(messages: ChatMessage[], fallback: Lang): Lang {
  const recent: string[] = []
  for (let i = messages.length - 1; i >= 0 && recent.length < RECENT; i -= 1) {
    const text = messages[i]?.text.trim()
    if (text !== undefined && text.length > 0) recent.push(text)
  }
  // Nothing said yet, so there is no conversation to take a cue from.
  if (recent.length === 0) return fallback

  const sample = recent.join(' ')
  const han = sample.match(HAN)?.length ?? 0
  if (han === 0) return 'en'
  const letters = sample.match(LETTERS)?.length ?? 0
  return letters > 0 && han / letters >= HAN_SHARE ? 'zh-CN' : 'en'
}
