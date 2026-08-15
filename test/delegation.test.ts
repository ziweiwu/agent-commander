/**
 * An agent that has handed work to a subagent goes completely quiet: its own
 * transcript stops growing until the subagent returns, which on a long run is
 * many minutes. On the evidence the card otherwise has, that is identical to an
 * agent that has silently died — and catching exactly that is what this
 * dashboard is for. The subagent's transcript is the only thing still moving,
 * so it is what the clock has to follow.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subagentActivityAt } from '../src/server/transcript.ts'

const made: string[] = []

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A project directory holding one session's transcript. */
async function project(sessionId: string): Promise<{ dir: string; transcript: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-delegation-'))
  made.push(dir)
  const transcript = join(dir, `${sessionId}.jsonl`)
  await writeFile(transcript, '')
  return { dir, transcript }
}

async function subagent(dir: string, sessionId: string, name: string, at: number): Promise<void> {
  const subs = join(dir, sessionId, 'subagents')
  await mkdir(subs, { recursive: true })
  const file = join(subs, name)
  await writeFile(file, '{}\n')
  await utimes(file, new Date(at), new Date(at))
}

describe('subagentActivityAt', () => {
  it('reports nothing for an agent that has never delegated', async () => {
    const { transcript } = await project('s1')
    expect(await subagentActivityAt(transcript, 's1')).toBeNull()
  })

  it('reports when the subagent last wrote', async () => {
    const { dir, transcript } = await project('s2')
    const at = Date.now() - 30_000
    await subagent(dir, 's2', 'agent-aaa.jsonl', at)
    const seen = await subagentActivityAt(transcript, 's2')
    expect(seen).not.toBeNull()
    expect(Math.abs((seen as number) - at)).toBeLessThan(2000)
  })

  // Several subagents can run at once; the fleet card only cares that *any* of
  // them is still moving, so the newest wins.
  it('takes the newest of several subagents', async () => {
    const { dir, transcript } = await project('s3')
    const older = Date.now() - 120_000
    const newer = Date.now() - 5_000
    await subagent(dir, 's3', 'agent-old.jsonl', older)
    await subagent(dir, 's3', 'agent-new.jsonl', newer)
    const seen = (await subagentActivityAt(transcript, 's3')) as number
    expect(Math.abs(seen - newer)).toBeLessThan(2000)
  })

  it('ignores files that are not transcripts', async () => {
    const { dir, transcript } = await project('s4')
    const subs = join(dir, 's4', 'subagents')
    await mkdir(subs, { recursive: true })
    await writeFile(join(subs, 'notes.txt'), 'scratch')
    expect(await subagentActivityAt(transcript, 's4')).toBeNull()
  })

  // INV-5: a directory that cannot be read downgrades this one signal, it does
  // not throw and take the fleet view down with it.
  it('degrades to null rather than throwing on an unreadable path', async () => {
    await expect(subagentActivityAt('/nonexistent/path/s5.jsonl', 's5')).resolves.toBeNull()
  })

  it('does not confuse one session with another', async () => {
    const { dir, transcript } = await project('s6')
    await subagent(dir, 'someone-else', 'agent-aaa.jsonl', Date.now())
    expect(await subagentActivityAt(transcript, 's6')).toBeNull()
  })
})
