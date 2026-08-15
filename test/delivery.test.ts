/**
 * The mock's paste was a no-op, so in mock mode a sent message could never be
 * confirmed — the send flow was the one thing that could not be exercised
 * without pointing at a live agent, and every QA pass saw the stuck state
 * rather than the real behaviour.
 */
import { describe, expect, it } from 'vitest'
import { MockPanes, MockTail } from '../src/server/mock.ts'

describe('mock transcript echo', () => {
  it('echoes a submitted message back as a user event', async () => {
    const panes = new MockPanes()
    const tail = new MockTail('mock-busy')
    await tail.read() // drain the seeded timeline

    await panes.paste('%77', 'ship it', true)
    const { events, first } = await tail.read()
    expect(first).toBe(false)
    expect(events.map((e) => [e.kind, e.text])).toEqual([['user', 'ship it']])
  })

  it('does not echo loose keystrokes the terminal view sends', async () => {
    const panes = new MockPanes()
    const tail = new MockTail('mock-idle-kb')
    await tail.read()

    await panes.paste('%72', 'not submitted', false)
    expect((await tail.read()).events).toEqual([])
  })

  it('delivers each echo exactly once to a given reader', async () => {
    const panes = new MockPanes()
    const tail = new MockTail('mock-long-name')
    await tail.read()

    await panes.paste('%79', 'once', true)
    expect((await tail.read()).events).toHaveLength(1)
    expect((await tail.read()).events).toEqual([])
  })

  /*
   * There is never one reader. The focused viewer polls its own tail every
   * second and the fleet enricher polls a separate tail per agent every five,
   * and the enricher throws away the events it reads. While the log was a queue
   * that `read()` drained, whichever polled first took the message and the
   * other never saw it — so a message the server had accepted was marked "not
   * delivered" in the browser.
   */
  it('gives every reader the same echo, whoever polls first', async () => {
    const panes = new MockPanes()
    const viewer = new MockTail('mock-busy-2')
    const enricher = new MockTail('mock-busy-2')
    await viewer.read()
    await enricher.read()

    await panes.paste('%75', 'both of you', true)

    // The enricher wins the race and discards what it read, as it really does.
    await enricher.read()

    const { events } = await viewer.read()
    expect(events.map((e) => e.text)).toEqual(['both of you'])
  })

  it('replays the whole log to a reader that arrives late', async () => {
    const panes = new MockPanes()
    const early = new MockTail('mock-idle-ce')
    await early.read()
    await panes.paste('%73', 'first', true)
    await early.read()

    const late = new MockTail('mock-idle-ce')
    await late.read() // seeded timeline
    expect((await late.read()).events.map((e) => e.text)).toEqual(['first'])
  })

  it('stamps an echo when it was sent, not when it was read', async () => {
    const panes = new MockPanes()
    const tail = new MockTail('mock-idle-db')
    await tail.read()

    const before = Date.now()
    await panes.paste('%78', 'timestamped', true)
    const after = Date.now()

    const { events } = await tail.read()
    const at = events[0]?.at ?? 0
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(after)
  })
})
