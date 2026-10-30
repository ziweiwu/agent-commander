/**
 * INV-11 at the element: what Claude Code files as a `user` record without a
 * person typing it — a delegate's hand-back, another agent's message, a
 * background task's end — is a mark on the conversation in the reader's
 * language, never a message from "you". What another agent said stays one tap
 * away, behind a native disclosure.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Message } from '../../src/web/components/Message.tsx'
import type { ChatMessage } from '../../src/web/lib/chat.ts'
import type { Lang } from '../../src/web/lib/i18n.ts'
import { useStore } from '../../src/web/store/store.ts'
import { resetStore } from './helpers.tsx'

const REPORT = 'Renamed the export button in all three locales.\n\nThe build passes.'

function notice(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'n1', role: 'notice', at: 0, text: '', tools: [], grouped: false, ...over }
}

const COPY: Record<Lang, Record<string, string>> = {
  en: {
    handback: '«general-purpose» reported back',
    handbackUnnamed: 'a delegate reported back',
    showReport: 'show report',
    peer: 'message from «reviewer»',
    showMessage: 'show message',
    task: 'background task · npm test completed',
    taskBare: 'background task ended',
  },
  'zh-CN': {
    handback: '「general-purpose」已交回结果',
    handbackUnnamed: '一个代理已交回结果',
    showReport: '查看报告',
    peer: '来自「reviewer」的消息',
    showMessage: '查看消息',
    task: '后台任务 · npm test completed',
    taskBare: '后台任务已结束',
  },
}

const line = (): string => screen.getByTestId('notice-text').textContent ?? ''

beforeEach(resetStore)

describe.each(Object.keys(COPY) as Lang[])('notices in %s (INV-11)', (lang) => {
  const copy = COPY[lang]
  beforeEach(() => act(() => useStore.setState({ lang })))

  it('draws a hand-back as a notice naming the delegate, with the report behind "show report"', () => {
    render(<Message message={notice({ notice: 'handback', from: 'general-purpose', text: REPORT })} />)
    expect(screen.queryByTestId('message-author')).toBeNull()
    expect(screen.getByTestId('notice').dataset.notice).toBe('handback')
    expect(line()).toBe(copy.handback)
    const disclosure = screen.getByTestId('notice-disclosure') as HTMLDetailsElement
    expect(disclosure.tagName).toBe('DETAILS')
    expect(disclosure.open).toBe(false)
    expect(disclosure.querySelector('summary')?.textContent).toBe(copy.showReport)
    expect(screen.getByTestId('notice-said').textContent).toBe(REPORT)
  })

  it('says "a delegate" when the hand-back names nobody', () => {
    render(<Message message={notice({ notice: 'handback', text: REPORT })} />)
    expect(line()).toBe(copy.handbackUnnamed)
  })

  it('draws another agent’s message as a notice naming the sender, behind "show message"', () => {
    render(<Message message={notice({ notice: 'peerMessage', from: 'reviewer', text: 'Is it ready?' })} />)
    expect(line()).toBe(copy.peer)
    expect(screen.getByTestId('notice-disclosure').querySelector('summary')?.textContent).toBe(
      copy.showMessage,
    )
    expect(screen.getByTestId('notice-said').textContent).toBe('Is it ready?')
  })

  it('draws a background task’s end with its summary, and nothing to disclose', () => {
    render(<Message message={notice({ notice: 'taskEnded', text: 'npm test completed' })} />)
    expect(line()).toBe(copy.task)
    expect(screen.queryByTestId('notice-disclosure')).toBeNull()
  })

  it('says only that a background task ended when it carried no summary', () => {
    render(<Message message={notice({ notice: 'taskEnded' })} />)
    expect(line()).toBe(copy.taskBare)
  })

  it('draws no disclosure for a hand-back that said nothing', () => {
    render(<Message message={notice({ notice: 'handback', from: 'general-purpose' })} />)
    expect(line()).toBe(copy.handback)
    expect(screen.queryByTestId('notice-disclosure')).toBeNull()
  })
})

/**
 * The disclosure's touch floor, read from the stylesheet because the mock draws
 * no notice for a browser gate to measure. Both queries — the width cut and the
 * pointer, as AGENTS.md asks of every floor — and each after the 24px base
 * rule: a floor earlier in the file loses to that rule at equal specificity,
 * which is how this one first measured 24px on an iPhone.
 */
describe('the notice disclosure under a finger', () => {
  it('lifts "show report" to 44px on a phone and under a coarse pointer, after its base rule', () => {
    const css = readFileSync('src/web/components/Message.module.css', 'utf8')
    const base = css.search(/^\.noticeToggle \{[^}]*min-height: 24px/m)
    expect(base, 'the 24px base rule').toBeGreaterThan(-1)
    for (const query of ['(max-width: 560px)', '(pointer: coarse)']) {
      const escaped = query.replace(/[()]/g, '\\$&')
      const floor = new RegExp(`@media ${escaped} \\{\\s*\\.noticeToggle \\{\\s*min-height: 44px`, 'g')
      const after = [...css.matchAll(floor)].some((found) => found.index > base)
      expect(after, `a 44px floor under ${query} after the base rule`).toBe(true)
    }
  })
})
