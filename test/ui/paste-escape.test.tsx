/**
 * INV-2: pasted text cannot leave its bracketed paste.
 *
 * tmux's `-p` wraps a paste in `ESC[200~` … `ESC[201~` and passes whatever is
 * inside straight through, so text carrying `ESC[201~` ended the paste early
 * and everything after it reached the agent as keypresses: a `\r` that
 * submits, a lone ESC that interrupts, `ESC[Z` that cycles the permission
 * mode. A clipboard copied from a hostile page is enough to carry it.
 *
 * The server refuses such text (`pane::check_paste`). These tests hold the
 * client half: every path to `paste` refuses it first, says so in the reader's
 * language, and puts nothing on the wire — not the text, not an echo, not the
 * Escape an interrupting send would have led with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage } from '../../src/shared/types.ts'

const HOSTILE = 'looks harmless\u001b[201~\rrm -rf build\r'
const EN_REFUSAL =
  'Not sent: the text contains a control character (U+001B) that the terminal would treat as a keypress.'
const ZH_REFUSAL = '未发送：文本含有控制字符（U+001B），终端会把它当作按键。'

interface Wire {
  sent: ClientMessage[]
  transport: typeof import('../../src/web/store/transport.ts')
  store: typeof import('../../src/web/store/store.ts')
}

/** A socket that records rather than connects. */
async function wireUp(sessionId = 'agent-a'): Promise<Wire> {
  const sent: ClientMessage[] = []
  const sockets: FakeSocket[] = []

  class FakeSocket {
    static readonly OPEN = 1
    readyState = 1
    readonly listeners = new Map<string, Array<(e: unknown) => void>>()
    constructor() {
      sockets.push(this)
    }
    send(raw: string): void {
      sent.push(JSON.parse(raw) as ClientMessage)
    }
    addEventListener(type: string, fn: (e: unknown) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
    }
    fire(type: string): void {
      for (const fn of this.listeners.get(type) ?? []) fn({})
    }
    close(): void {
      this.readyState = 3
    }
  }

  vi.resetModules()
  vi.stubGlobal('WebSocket', FakeSocket)
  window.history.replaceState({}, '', '/')

  const transport = await import('../../src/web/store/transport.ts')
  const store = await import('../../src/web/store/store.ts')
  transport.connect()
  sockets[sockets.length - 1]?.fire('open')
  store.useStore.setState({ selected: sessionId, toast: null, pending: [] })
  sent.length = 0
  return { sent, transport, store }
}

const writes = (wire: Wire) => wire.sent.filter((m) => m.type === 'paste' || m.type === 'key')

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('INV-2: text that would leave its bracketed paste is refused', () => {
  it('refuses a composer message, with no echo and nothing on the wire', async () => {
    const wire = await wireUp()
    wire.transport.sendMessage(HOSTILE)
    expect(writes(wire)).toEqual([])
    expect(wire.store.useStore.getState().pending).toEqual([])
    expect(wire.store.useStore.getState().toast).toBe(EN_REFUSAL)
  })

  it('refuses an interrupting send before its Escape', async () => {
    const wire = await wireUp()
    wire.transport.interruptAndSend(HOSTILE)
    expect(writes(wire)).toEqual([])
  })

  it("refuses the Attach view's typing and its paste line's Run", async () => {
    const wire = await wireUp()
    wire.transport.sendText(HOSTILE)
    wire.transport.runText(HOSTILE)
    expect(writes(wire)).toEqual([])
    expect(wire.store.useStore.getState().toast).toBe(EN_REFUSAL)
  })

  it('says it in Chinese to a Chinese reader', async () => {
    const wire = await wireUp()
    wire.store.useStore.setState({ lang: 'zh-CN' })
    wire.transport.sendMessage(HOSTILE)
    expect(wire.store.useStore.getState().toast).toBe(ZH_REFUSAL)
  })

  it('names the character it found, DEL and the C1 range included', async () => {
    const wire = await wireUp()
    for (const [c, code] of [
      ['\u0000', '0000'],
      ['\u0007', '0007'],
      ['\u007f', '007F'],
      ['\u009b', '009B'],
    ]) {
      wire.transport.sendMessage(`a${c}b`)
      expect(wire.store.useStore.getState().toast).toContain(`U+${code}`)
    }
    expect(writes(wire)).toEqual([])
  })

  /**
   * xterm's own paste turns line breaks into CR, and the Attach view sends
   * xterm's data as a paste — so refusing `\r` would break every multi-line
   * paste into Attach.
   */
  it('lets tab and both line breaks through, and CJK and emoji', async () => {
    const wire = await wireUp()
    wire.transport.sendText('line1\rline2\n\tindented')
    wire.transport.sendMessage('多语言 🚀\nsecond line')
    expect(writes(wire).map((m) => m.type === 'paste' && m.text)).toEqual([
      'line1\rline2\n\tindented',
      '多语言 🚀\nsecond line',
    ])
    expect(wire.store.useStore.getState().toast).toBeNull()
  })

  it('does not swallow what was typed around a refused chunk', async () => {
    const wire = await wireUp()
    wire.transport.sendText('a')
    wire.transport.sendText('\u001b[201~')
    wire.transport.sendText('b')
    wire.transport.flushText()
    const pasted = writes(wire).map((m) => (m.type === 'paste' ? m.text : ''))
    expect(pasted.join('')).toBe('ab')
  })
})
