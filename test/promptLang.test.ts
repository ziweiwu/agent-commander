/**
 * Quick prompts follow the conversation, not the interface.
 *
 * The prompt is not label text — it is a message that goes to the agent and
 * lands in its transcript. Someone reading an English UI while working with an
 * agent in Chinese wants to send 继续, and should not have to reskin the whole
 * app to get it.
 */
import { describe, expect, it } from 'vitest'
import { conversationLang } from '../src/web/lib/promptLang.ts'
import type { ChatMessage } from '../src/web/lib/chat.ts'

let seq = 0
const msg = (text: string, role: ChatMessage['role'] = 'agent'): ChatMessage => ({
  id: `m${seq++}`,
  role,
  at: 1_000_000 + seq,
  text,
  tools: [],
  grouped: false,
})

describe('conversationLang', () => {
  it('falls back to the interface language when nothing has been said', () => {
    expect(conversationLang([], 'zh-CN')).toBe('zh-CN')
    expect(conversationLang([], 'en')).toBe('en')
  })

  it('reads a Chinese conversation as Chinese even under an English interface', () => {
    const messages = [msg('帮我把深色模式的开关加到页面顶部', 'you'), msg('好的，我先看一下现在的代码结构。')]
    expect(conversationLang(messages, 'en')).toBe('zh-CN')
  })

  it('reads an English conversation as English even under a Chinese interface', () => {
    const messages = [msg('add a dark mode toggle', 'you'), msg('Getting oriented in the codebase.')]
    expect(conversationLang(messages, 'zh-CN')).toBe('en')
  })

  // An English conversation that happens to quote a Chinese path or term is
  // still an English conversation.
  it('is not swayed by a stray Chinese term in English prose', () => {
    const messages = [
      msg('I renamed the file to 报告.md and updated every import that referred to it', 'you'),
      msg('Understood — I will update the remaining references and run the test suite now.'),
    ]
    expect(conversationLang(messages, 'en')).toBe('en')
  })

  it('follows the most recent turns when the conversation switches language', () => {
    const messages = [
      msg('add a dark mode toggle', 'you'),
      msg('Getting oriented in the codebase.'),
      msg('改用中文吧，接下来都用中文回答', 'you'),
      msg('好的，我会用中文继续。'),
      msg('先把主题切换按钮做好。', 'you'),
    ]
    expect(conversationLang(messages, 'en')).toBe('zh-CN')
  })

  // Only the tail counts, so a conversation that began in Chinese and moved to
  // English offers English prompts.
  it('lets an older Chinese opening fall out of the window', () => {
    const messages = [
      msg('我们开始吧', 'you'),
      msg('好的。'),
      msg('Actually, let us continue in English from here', 'you'),
      msg('Sure — switching to English for the rest of this session.'),
      msg('Start with the header component please', 'you'),
      msg('Reading the header component now.'),
      msg('Then run the full test suite and report what fails.', 'you'),
    ]
    expect(conversationLang(messages, 'zh-CN')).toBe('en')
  })

  // Tool calls carry file paths, not conversation, and live outside `text`.
  it('ignores messages that carry only tool calls', () => {
    const messages = [
      msg('继续处理这个问题', 'you'),
      { ...msg(''), tools: [{ id: 't1', tool: 'Read', text: 'src/app.ts', subagent: false }] },
    ]
    expect(conversationLang(messages, 'en')).toBe('zh-CN')
  })
})
