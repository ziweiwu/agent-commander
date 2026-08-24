/**
 * The control-mode framing.
 *
 * This is the parser that decides which command a given lump of tmux output is
 * the answer to. Getting it wrong is not a cosmetic failure: hand a block to
 * the wrong waiter and every reply after it is shifted by one, so the Attach
 * view draws another agent's pane and the geometry it is sized from belongs to
 * a third. That is worth a test that does not need a tmux server to run.
 */
import { describe, expect, it } from 'vitest'
import { ControlStream } from '../src/server/tmux-client.ts'

function collect(): { stream: ControlStream; blocks: Array<[string, string | null]> } {
  const blocks: Array<[string, string | null]> = []
  const stream = new ControlStream((output, err) => blocks.push([output, err?.message ?? null]))
  return { stream, blocks }
}

describe('reply framing', () => {
  it('reads one command reply', () => {
    const { stream, blocks } = collect()
    stream.push('%begin 1712 3 1\n150|47|2|21|0|0\n%end 1712 3 1\n')
    expect(blocks).toEqual([['150|47|2|21|0|0', null]])
  })

  it('keeps every line of a multi-line reply, blank ones included', () => {
    const { stream, blocks } = collect()
    stream.push('%begin 1 1 1\nrow one\n\nrow three\n%end 1 1 1\n')
    expect(blocks[0]?.[0]).toBe('row one\n\nrow three')
  })

  it('reports %error as a failure rather than as output', () => {
    const { stream, blocks } = collect()
    stream.push("%begin 1 4 1\ncan't find pane %999\n%error 1 4 1\n")
    expect(blocks).toEqual([['', "can't find pane %999"]])
  })

  /*
   * The reason the block id is carried around. tmux does not escape command
   * output, and `capture-pane` on a pane that happens to be showing this
   * protocol -- a developer with the control stream on screen, this project's
   * own benchmark output -- contains lines that look exactly like terminators.
   * Ending the block there would return a truncated pane and leave the real
   * terminator to be read as the *next* command's reply.
   */
  it('is not ended early by captured output that looks like a terminator', () => {
    const { stream, blocks } = collect()
    stream.push('%begin 900 7 1\n')
    stream.push('%end 900 6 1\n') // a different command's id, captured as text
    stream.push('%end\n') // and a bare one
    stream.push('still mine\n')
    stream.push('%end 900 7 1\n')
    expect(blocks).toEqual([['%end 900 6 1\n%end\nstill mine', null]])
  })

  it('ignores notifications that arrive between replies', () => {
    const { stream, blocks } = collect()
    stream.push('%session-changed $2 work\n')
    stream.push('%begin 5 1 1\nok\n%end 5 1 1\n')
    stream.push('%window-add @9\n')
    stream.push('%begin 5 2 1\nfine\n%end 5 2 1\n')
    expect(blocks.map((b) => b[0])).toEqual(['ok', 'fine'])
  })
})

describe('chunk boundaries', () => {
  /*
   * A pipe splits wherever it likes. A 47-row capture arrives in several
   * chunks, and a chunk can end mid-line -- including in the middle of the
   * terminator itself.
   */
  it('reassembles a reply split across arbitrary chunks', () => {
    const whole = '%begin 3 9 1\nalpha\nbeta\ngamma\n%end 3 9 1\n'
    for (const size of [1, 3, 7, 13]) {
      const { stream, blocks } = collect()
      for (let i = 0; i < whole.length; i += size) stream.push(whole.slice(i, i + size))
      expect(blocks, `chunk size ${size}`).toEqual([['alpha\nbeta\ngamma', null]])
    }
  })

  it('holds an incomplete reply back rather than emitting half of it', () => {
    const { stream, blocks } = collect()
    stream.push('%begin 3 9 1\nalpha\n')
    expect(blocks).toEqual([])
    stream.push('%end 3 9 1\n')
    expect(blocks).toHaveLength(1)
  })

  it('drops a half-read block on reset', () => {
    const { stream, blocks } = collect()
    stream.push('%begin 3 9 1\nalpha\n')
    stream.reset()
    stream.push('%end 3 9 1\n')
    expect(blocks).toEqual([])
  })
})

/**
 * The reply accounting, against a fake tmux.
 *
 * A command *line* is not one reply. tmux answers once per command in the
 * sequence, and this is the part of the client that fails silently if that is
 * got wrong: the first block resolves the call, the rest are handed to
 * whatever is asked next, and every reply from then on is shifted by one. What
 * the user sees is one pane's contents drawn into another pane's geometry —
 * never an error. So the awkward cases are forced here rather than waited for.
 *
 * The block counts and the abort-on-error behaviour below were measured
 * against tmux 3.6a before being written down.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { TmuxControl } from '../src/server/tmux-client.ts'

/** A tmux that says exactly what the test tells it to. */
class FakeTmux extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void }
  readonly stderr = new EventEmitter() as EventEmitter & { resume: () => void }
  readonly written: string[] = []
  readonly stdin = {
    writable: true,
    write: (line: string) => {
      this.written.push(line.trimEnd())
      return true
    },
  }
  #seq = 0

  constructor() {
    super()
    this.stdout.setEncoding = () => {}
    this.stderr.resume = () => {}
  }

  /** Emit one complete reply block. */
  reply(output: string, error = false): void {
    this.#seq += 1
    const id = `100 ${this.#seq}`
    const body = output.length > 0 ? `${output}\n` : ''
    this.stdout.emit('data', `%begin ${id} 1\n${body}%${error ? 'error' : 'end'} ${id} 1\n`)
  }

  kill(): void {
    this.emit('exit', 0)
  }
}

async function connected(): Promise<{ tmux: FakeTmux; client: TmuxControl }> {
  let tmux!: FakeTmux
  const client = new TmuxControl({
    spawn: () => {
      tmux = new FakeTmux()
      // The probe is answered once it has actually been asked for. Polled on a
      // timer rather than a microtask: a microtask that re-queues itself never
      // yields, so the client never gets to write anything at all.
      const answer = (): void => {
        if (tmux.written.length > 0) tmux.reply('ok')
        else setTimeout(answer, 1)
      }
      setTimeout(answer, 1)
      return tmux as unknown as ChildProcess
    },
    firstSession: async () => 'work',
  })
  client.settleMs = 0
  client.start()
  for (let i = 0; i < 200 && !client.ready; i += 1) await new Promise((r) => setTimeout(r, 5))
  expect(client.ready).toBe(true)
  tmux.written.length = 0
  return { tmux, client }
}

describe('one reply block per command', () => {
  it('joins the replies of a two-command line', async () => {
    const { tmux, client } = await connected()
    const pending = client.run(['display-message -p X', 'capture-pane -e -p -t %1'])
    expect(tmux.written).toEqual(['display-message -p X ; capture-pane -e -p -t %1'])

    tmux.reply('80|24|0|0|0|0')
    tmux.reply('row one\nrow two')
    await expect(pending).resolves.toBe('80|24|0|0|0|0\nrow one\nrow two')
    client.stop()
  })

  it('does not resolve a two-command line on the first block alone', async () => {
    const { tmux, client } = await connected()
    let settled = false
    const pending = client.run(['a', 'b']).then(() => (settled = true))
    tmux.reply('first')
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    tmux.reply('second')
    await pending
    expect(settled).toBe(true)
    client.stop()
  })

  /*
   * The failure this whole design exists to prevent. If a three-command line
   * consumed one block, the two left over would answer the next two calls --
   * so a paste would be followed by a read that returned a paste's empty reply
   * as if it were a pane.
   */
  it('keeps later commands aligned after a multi-command line', async () => {
    const { tmux, client } = await connected()
    const paste = client.run(['load-buffer -b b1 /tmp/x', 'paste-buffer -b b1 -t %1 -p -d', 'send-keys -t %1 Enter'])
    tmux.reply('')
    tmux.reply('')
    tmux.reply('')
    await expect(paste).resolves.toBe('')

    const read = client.run(['display-message -p 80|24|0|0|0|0'])
    tmux.reply('80|24|0|0|0|0')
    // The read gets the read's answer, not a leftover from the paste.
    await expect(read).resolves.toBe('80|24|0|0|0|0')
    client.stop()
  })

  it('drops the empty replies of commands that say nothing', async () => {
    const { tmux, client } = await connected()
    const pending = client.run(['load-buffer -b b1 /tmp/x', 'capture-pane -p -t %1'])
    tmux.reply('')
    tmux.reply('only this')
    // A blank line joined in from `load-buffer` would become a phantom first
    // row of the pane.
    await expect(pending).resolves.toBe('only this')
    client.stop()
  })
})

describe('a sequence that fails', () => {
  /*
   * Measured: a sequence that cannot resolve a target -- `paste-buffer` of a
   * buffer that is gone, `send-keys` to a pane that has exited -- and one that
   * cannot be parsed both produce exactly one `%error` block and run nothing
   * further. So an error ends the line, and there is no remainder to skip.
   */
  it('rejects on an error block and stays aligned', async () => {
    const { tmux, client } = await connected()
    const failing = client.run(['paste-buffer -b gone -t %1 -p -d', 'send-keys -t %1 Enter'])
    tmux.reply('no buffer gone', true)
    await expect(failing).rejects.toThrow(/no buffer gone/)

    const next = client.run(['display-message -p fine'])
    tmux.reply('fine')
    await expect(next).resolves.toBe('fine')
    client.stop()
  })

  it('rejects a mid-sequence error without consuming a later reply', async () => {
    const { tmux, client } = await connected()
    const failing = client.run(['load-buffer -b b1 /tmp/x', 'paste-buffer -b b1 -t %1 -p -d'])
    tmux.reply('') // the load succeeded
    tmux.reply("can't find pane: %1", true) // the paste did not
    await expect(failing).rejects.toThrow(/can't find pane/)

    const next = client.run(['display-message -p still-here'])
    tmux.reply('still-here')
    await expect(next).resolves.toBe('still-here')
    client.stop()
  })
})

describe('when the client dies', () => {
  it('rejects what was in flight and reports itself unusable', async () => {
    const { tmux, client } = await connected()
    const pending = client.run(['display-message -p X'])
    tmux.kill()
    await expect(pending).rejects.toThrow(/exited/)
    expect(client.ready).toBe(false)
    client.stop()
  })

  it('refuses new commands rather than queueing them against nothing', async () => {
    const { tmux, client } = await connected()
    tmux.kill()
    await expect(client.run(['display-message -p X'])).rejects.toThrow(/not ready/)
    client.stop()
  })
})
