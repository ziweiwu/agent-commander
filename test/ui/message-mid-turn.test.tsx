/**
 * INV-11 at the element: a message the agent read while it was working is the
 * reader's own, drawn as "You", and says when the agent read it — beside the
 * time, in the reader's language — whether it heads its run or is grouped
 * under the message before.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Message } from '../../src/web/components/Message.tsx'
import type { ChatMessage } from '../../src/web/lib/chat.ts'
import type { Lang } from '../../src/web/lib/i18n.ts'
import { useStore } from '../../src/web/store/store.ts'
import { resetStore } from './helpers.tsx'

const CAPTION: Record<Lang, string> = { en: 'read mid-turn', 'zh-CN': '回合中读取' }

function said(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'm1', role: 'you', at: 0, text: 'use the second layout', tools: [], grouped: false, ...over }
}

beforeEach(resetStore)

describe.each(Object.keys(CAPTION) as Lang[])('a message read mid-turn, in %s (INV-11)', (lang) => {
  beforeEach(() => act(() => useStore.setState({ lang })))

  it('is yours, captioned beside its time', () => {
    render(<Message message={said({ midTurn: true })} />)
    expect(screen.getByTestId('message-author').textContent).toBe(lang === 'en' ? 'You' : '你')
    const caption = screen.getByTestId('message-mid-turn')
    expect(caption.textContent).toBe(CAPTION[lang])
    expect(caption.previousElementSibling?.tagName).toBe('TIME')
    expect(caption.getAttribute('title')).toBeTruthy()
  })

  it('keeps the caption when it is grouped under the message before', () => {
    render(<Message message={said({ midTurn: true, grouped: true })} />)
    expect(screen.getByTestId('message-mid-turn').textContent).toBe(CAPTION[lang])
  })

  it('says nothing of the kind about a message typed at the prompt', () => {
    render(<Message message={said({})} />)
    expect(screen.queryByTestId('message-mid-turn')).toBeNull()
  })
})
