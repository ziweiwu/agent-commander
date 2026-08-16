/**
 * The incremental tailer, across the boundaries it actually meets.
 *
 * INV-4 makes this a byte-offset tail — a live transcript is megabytes and
 * re-reading it every second would be the most expensive thing this app does —
 * and every bug here comes from that offset landing somewhere awkward: in the
 * middle of a line, in the middle of a character, or on a file that has since
 * moved.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptTail } from '../src/server/transcript.ts'

const SESSION = 'sess-1'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function projects(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ac-tail-'))
  roots.push(root)
  const dir = join(root, '-Users-demo-project')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${SESSION}.jsonl`)
  await writeFile(file, '')
  return { root, file }
}

/** One user record, as Claude Code writes them. */
function said(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    timestamp: '2026-08-14T00:57:52.725Z',
    message: { content: text },
  })}\n`
}

describe('a character split across two reads', () => {
  /*
   * The offset is a byte count and the poll lands wherever the writer has got
   * to, so a three-byte character straddles the boundary sooner or later.
   * Decoding each chunk as its own string turned that into two U+FFFD
   * replacements — and this app ships a Chinese locale, so it is not an exotic
   * case.
   */
  it('reassembles it instead of replacing it with U+FFFD', async () => {
    const { root, file } = await projects()
    const tail = new TranscriptTail(SESSION, root)
    await tail.read()

    const record = Buffer.from(said('检查一下这个目录'), 'utf8')
    // Cut inside the first character: one byte of it lands in each read.
    const cut = record.indexOf(Buffer.from('检', 'utf8')) + 1
    await appendFile(file, record.subarray(0, cut))
    expect((await tail.read()).events).toHaveLength(0)

    await appendFile(file, record.subarray(cut))
    const { events } = await tail.read()
    expect(events).toHaveLength(1)
    expect(events[0]?.text).toBe('检查一下这个目录')
    expect(events[0]?.text).not.toContain('�')
  })

  it('handles a boundary inside every byte position of a character', async () => {
    for (const at of [1, 2]) {
      const { root, file } = await projects()
      const tail = new TranscriptTail(SESSION, root)
      await tail.read()

      const record = Buffer.from(said('日本語のテスト'), 'utf8')
      const cut = record.indexOf(Buffer.from('日', 'utf8')) + at
      await appendFile(file, record.subarray(0, cut))
      await tail.read()
      await appendFile(file, record.subarray(cut))

      expect((await tail.read()).events[0]?.text).toBe('日本語のテスト')
    }
  })
})

describe('a line split across two reads', () => {
  it('holds the torn half back until the rest arrives', async () => {
    const { root, file } = await projects()
    const tail = new TranscriptTail(SESSION, root)
    await tail.read()

    const record = said('finish the migration')
    await appendFile(file, record.slice(0, 20))
    expect((await tail.read()).events).toHaveLength(0)

    await appendFile(file, record.slice(20))
    expect((await tail.read()).events[0]?.text).toBe('finish the migration')
  })
})

describe('when the transcript moves', () => {
  /*
   * The path was resolved once and cached, so a rotated or relocated file left
   * every later read failing the same way: that agent's timeline was dead for
   * the life of the server, with nothing said about why.
   */
  it('finds it again rather than going dead', async () => {
    const { root, file } = await projects()
    const tail = new TranscriptTail(SESSION, root)
    await appendFile(file, said('before'))
    expect((await tail.read()).events).toHaveLength(1)

    const moved = join(root, '-Users-demo-elsewhere')
    await mkdir(moved, { recursive: true })
    await rename(file, join(moved, `${SESSION}.jsonl`))

    // The read that meets the gap reports nothing, and re-resolves for the next.
    expect((await tail.read()).events).toHaveLength(0)
    await appendFile(join(moved, `${SESSION}.jsonl`), said('after'))
    const { events } = await tail.read()
    expect(events.at(-1)?.text).toBe('after')
  })

  /*
   * `first` tells the browser to replace the conversation it is showing. A
   * transcript that has merely gone missing must not raise it again, or the
   * chat the user is reading is blanked once per poll.
   */
  it('does not claim a fresh backfill once one has been delivered', async () => {
    const { root, file } = await projects()
    const tail = new TranscriptTail(SESSION, root)
    await appendFile(file, said('hello'))
    expect((await tail.read()).first).toBe(true)

    await rm(file)
    expect((await tail.read()).first).toBe(false)
    expect((await tail.read()).first).toBe(false)
  })
})

describe('when the transcript is replaced', () => {
  it('reports a truncated file as a replacement, not a continuation', async () => {
    const { root, file } = await projects()
    const tail = new TranscriptTail(SESSION, root)
    await appendFile(file, said('one'))
    await appendFile(file, said('two'))
    expect((await tail.read()).events).toHaveLength(2)

    // Shorter than what has already been read: a different file at the same path.
    await writeFile(file, said('fresh'))
    const { events, first } = await tail.read()
    expect(first).toBe(true)
    expect(events.map((e) => e.text)).toEqual(['fresh'])
  })
})
