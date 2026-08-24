/**
 * Typing in the Attach view, and why it is not one write per keystroke.
 *
 * Every character used to be its own `paste`, and a paste is a tmux write that
 * measured p50 229ms on a loaded machine. Ordinary typing produces a character
 * about every 120ms, so the writes queued and the gap between pressing a key
 * and seeing it grew for as long as the sentence went on — a 40-character line
 * cost about 11 seconds of tmux work to deliver.
 *
 * A fixed debounce would be wrong at both ends: too short to coalesce anything
 * on a slow machine, and pure added latency on a fast one. So the client keeps
 * exactly one paste in flight and lets everything typed meanwhile accumulate
 * into the next one. The chunk size is then set by how fast tmux is actually
 * draining, which is the only thing that knows.
 *
 * INV-2 runs through all of this: nothing is ever sent twice, nothing is
 * synthesised, and a dropped connection discards buffered input rather than
 * replaying it into a live agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage } from '../../src/shared/types.ts'

interface Wire {
  sent: ClientMessage[]
  /** Everything the client sent, as the server would have applied it. */
  pastes: () => string[]
  ack: (seq: number, sessionId?: string) => void
  drop: () => void
  reconnect: () => void
  transport: typeof import('../../src/web/store/transport.ts')
  store: typeof import('../../src/web/store/store.ts')
}

/** A socket that records rather than connects, and can answer. */
async function wireUp(sessionId = 'agent-a'): Promise<Wire> {
  const sent: ClientMessage[] = []
  const sockets: FakeSocket[] = []

  class FakeSocket {
    static readonly OPEN = 1
    readyState = 1
    readonly listeners = new Map<string, Array<(e: unknown) => void>>()
    constructor(readonly url: unknown) {
      sockets.push(this)
    }
    send(raw: string): void {
      if (this.readyState !== 1) return
      sent.push(JSON.parse(raw) as ClientMessage)
    }
    addEventListener(type: string, fn: (e: unknown) => void): void {
      const list = this.listeners.get(type) ?? []
      list.push(fn)
      this.listeners.set(type, list)
    }
    fire(type: string, event: unknown = {}): void {
      for (const fn of this.listeners.get(type) ?? []) fn(event)
    }
    close(): void {
      this.readyState = 3
      this.fire('close')
    }
  }

  const live = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket

  vi.resetModules()
  vi.stubGlobal('WebSocket', FakeSocket)
  window.history.replaceState({}, '', '/')

  const transport = await import('../../src/web/store/transport.ts')
  const store = await import('../../src/web/store/store.ts')
  transport.connect()
  live().fire('open')
  store.useStore.setState({ selected: sessionId, tab: 'attach' })
  sent.length = 0

  return {
    sent,
    pastes: () =>
      sent
        .filter((m): m is Extract<ClientMessage, { type: 'paste' }> => m.type === 'paste')
        .map((m) => m.text),
    ack: (seq, id = sessionId) =>
      live().fire('message', { data: JSON.stringify({ type: 'paste-ack', sessionId: id, seq }) }),
    drop: () => {
      live().readyState = 3
      live().fire('close')
    },
    /** What the transport does by itself after a drop: dial again, and resume. */
    reconnect: () => {
      const before = sockets.length
      vi.advanceTimersByTime(1_000)
      expect(sockets.length).toBeGreaterThan(before)
      live().fire('open')
    },
    transport,
    store,
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('one write in flight at a time', () => {
  it('sends the first character immediately', async () => {
    const wire = await wireUp()
    wire.transport.sendText('h')
    // Nothing is gained by delaying the first keystroke — on an idle machine
    // the ack comes straight back and typing is character-by-character.
    expect(wire.pastes()).toEqual(['h'])
  })

  it('holds later characters until the first is acknowledged', async () => {
    const wire = await wireUp()
    for (const ch of 'hello') wire.transport.sendText(ch)
    expect(wire.pastes()).toEqual(['h'])

    wire.ack(1)
    // The four characters typed while the first write was outstanding go as
    // one write, not four.
    expect(wire.pastes()).toEqual(['h', 'ello'])
  })

  it('turns a 40-character burst into a handful of writes', async () => {
    const wire = await wireUp()
    const sentence = 'the quick brown fox jumps over the lazyd'
    let seq = 0
    for (const ch of sentence) {
      wire.transport.sendText(ch)
      // A slow drain: one write completes for roughly every ten typed.
      if (seq % 10 === 9) wire.ack(Math.floor(seq / 10) + 1)
      seq += 1
    }
    const writes = wire.pastes()
    expect(writes.length).toBeLessThan(8)
    // Nothing may be lost or reordered in the process.
    expect(writes.join('')).toBe(sentence.slice(0, writes.join('').length))
  })

  it('never sends the same characters twice', async () => {
    const wire = await wireUp()
    for (const ch of 'abc') wire.transport.sendText(ch)
    wire.ack(1)
    wire.ack(1) // a duplicate ack must not re-open the gate for sent text
    wire.ack(2)
    expect(wire.pastes().join('')).toBe('abc')
  })
})

describe('ordering against everything else', () => {
  it('flushes typed characters before the key that submits them', async () => {
    const wire = await wireUp()
    for (const ch of 'run it') wire.transport.sendText(ch)
    wire.transport.sendKey('Enter')

    // An Enter that overtook the line it submits would submit an empty prompt
    // and leave the text behind it unsent.
    const kinds = wire.sent.map((m) => m.type)
    expect(kinds[kinds.length - 1]).toBe('key')
    expect(wire.pastes().join('')).toBe('run it')
  })

  it('flushes before a chat message so the two cannot interleave', async () => {
    const wire = await wireUp()
    wire.transport.sendText('x')
    wire.transport.sendText('y')
    wire.transport.sendMessage('a whole instruction')
    const pastes = wire.sent.filter(
      (m): m is Extract<ClientMessage, { type: 'paste' }> => m.type === 'paste',
    )
    expect(pastes.map((p) => p.text)).toEqual(['x', 'y', 'a whole instruction'])
    expect(pastes[pastes.length - 1]?.submit).toBe(true)
  })

  it('delivers characters to the agent they were typed for', async () => {
    const wire = await wireUp('agent-a')
    wire.transport.sendText('a') // goes out at once
    wire.transport.sendText('b') // buffered behind it
    wire.transport.focusAgent('agent-b')

    const forA = wire.sent.filter((m) => 'sessionId' in m && m.sessionId === 'agent-a')
    // 'b' was typed while agent-a was open. Switching must not carry it over.
    expect(
      forA
        .filter((m): m is Extract<ClientMessage, { type: 'paste' }> => m.type === 'paste')
        .map((p) => p.text)
        .join(''),
    ).toBe('ab')
  })
})

describe('when the connection goes', () => {
  it('does not replay buffered input on reconnect', async () => {
    vi.useFakeTimers()
    try {
      const wire = await wireUp()
      wire.transport.sendText('a') // on the wire
      wire.transport.sendText('secret') // buffered behind it, never sent
      wire.drop()
      const beforeReconnect = wire.sent.length
      wire.reconnect()

      // INV-2's one prohibition. Input that never left is dropped, not resent:
      // replaying it would be this app typing into a live agent with nobody
      // behind the keystrokes.
      expect(wire.sent.slice(beforeReconnect).filter((m) => m.type === 'paste')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets typing resume rather than wedging on the ack that never came', async () => {
    vi.useFakeTimers()
    try {
      const wire = await wireUp()
      wire.transport.sendText('a')
      wire.drop()
      wire.reconnect()

      // The gate was held by a paste whose ack died with the socket. If the
      // close did not release it, the Attach view would be typeable-into
      // exactly once per page load.
      wire.transport.sendText('b')
      expect(wire.pastes()).toEqual(['a', 'b'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the gate when an acknowledgement simply never arrives', async () => {
    vi.useFakeTimers()
    try {
      const wire = await wireUp()
      wire.transport.sendText('a')
      wire.transport.sendText('b')
      expect(wire.pastes()).toEqual(['a'])
      // A lost ack on a socket that is still up. The timeout releases the
      // gate; it does not re-send 'a', which was already delivered once.
      vi.advanceTimersByTime(2_500)
      expect(wire.pastes()).toEqual(['a', 'b'])
    } finally {
      vi.useRealTimers()
    }
  })
})
