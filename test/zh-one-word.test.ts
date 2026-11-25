/**
 * C6: one word for agent in the Chinese interface.
 *
 * 代理 was the dominant word, 助手 stood in for it on twenty lines and the
 * English "agent" in nine values, so one screen could carry all three. The
 * waiting chip read 待处理 where its own group heading read 需要你处理.
 * Every Chinese value is read here, so a new string is held to it too.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { translate, type Key } from '../src/web/lib/i18n.ts'

const SOURCE = readFileSync('src/web/lib/i18n.ts', 'utf8')
const EN_BLOCK = SOURCE.slice(SOURCE.indexOf('const EN = {'), SOURCE.indexOf('export type Key'))
const KEYS = [...EN_BLOCK.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1] as Key)
const PRODUCT = /agent-commander/g
const ENGLISH_AGENT = /\bagents?\b/i

const chinese = (key: Key) => translate('zh-CN', key)

describe('C6 one word for agent in Chinese', () => {
  it('reads every key', () => {
    expect(KEYS.length).toBeGreaterThan(400)
  })

  it('never says agent in English outside the product name', () => {
    expect(KEYS.filter((key) => ENGLISH_AGENT.test(chinese(key).replace(PRODUCT, '')))).toEqual([])
  })

  it('never says 助手', () => {
    expect(KEYS.filter((key) => chinese(key).includes('助手'))).toEqual([])
  })

  it('calls the waiting chip 需要你, as its heading does', () => {
    expect(chinese('filterWaiting')).toBe('需要你')
  })
})
