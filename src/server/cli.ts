#!/usr/bin/env node
/**
 * Entrypoint.
 *
 * INV-3: binds 127.0.0.1 unless `--host` is given, and `--host` without a token
 * is refused. This app can type into live agents and approve their permission
 * prompts, so an unauthenticated non-loopback bind would hand that to anyone on
 * the network.
 */
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry } from './registry.ts'
import { CompositeSource, TmuxProvider } from './tmux-source.ts'
import { findTranscript, TranscriptTail } from './transcript.ts'
import * as panes from './pane.ts'
import { tmuxControl } from './tmux-client.ts'
import { MockLimits, MockPanes, MockSource, MockTail, mockTree, SESSION_BY_PANE } from './mock.ts'
import { RateLimitWatcher } from './limits.ts'
import { createAppServer } from './routes.ts'
import { FleetEnricher } from './enrich.ts'
import { probeEnv } from './env.ts'
import { checkSpawnRequest } from './spawn.ts'
import { PendingStore } from './pending.ts'
import { readTree } from './subagents.ts'
import { MODE_CYCLE } from './options.ts'
import type { AgentSource, LimitsApi, PaneApi, TailApi } from './sources.ts'
import type { Agent, GoalState } from '../shared/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * The production port, and the only one that ever serves real agents.
 *
 * Nothing in development binds it: `npm run dev` and `npm run mock` pass
 * DEV_PORT explicitly, `qa-sweep.sh` refuses it outright, and the audits
 * default elsewhere. Keeping the two apart is what stops a fixture fleet from
 * appearing at the address the real one lives at.
 */
export const PROD_PORT = 4317

/** Where development serves instead. Also what the audit scripts target. */
export const DEV_PORT = 4400

interface Options {
  port: number
  host: string
  token?: string | undefined
  mock: boolean
  mockTransitions: boolean
  installStatusline: boolean
  webRoot: string
  browseRoot?: string | undefined
}

/**
 * Built assets always live in `dist/web`. Running compiled (`dist/server/cli.js`)
 * that is a sibling directory; running from source via tsx (`src/server/cli.ts`)
 * it is one level further up. Without this, `npm run serve` would hand the
 * browser the unbuilt source index.html.
 */
export function defaultWebRoot(here = HERE): string {
  const fromSource = here.endsWith(join('src', 'server'))
  return fromSource ? resolve(here, '..', '..', 'dist', 'web') : resolve(here, '..', 'web')
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    port: PROD_PORT,
    host: '127.0.0.1',
    mock: false,
    mockTransitions: false,
    installStatusline: false,
    webRoot: defaultWebRoot(),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    const [flag, inlineValue] = arg.includes('=') ? splitOnce(arg, '=') : [arg, undefined]
    const value = (): string => {
      const next = inlineValue ?? argv[++i]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    switch (flag) {
      case '--mock':
        opts.mock = true
        break
      case '--browse-root':
        opts.browseRoot = resolve(value())
        break
      case '--mock-transitions':
        opts.mock = true
        opts.mockTransitions = true
        break
      case '--port':
      case '-p':
        opts.port = Number.parseInt(value(), 10)
        break
      case '--host':
        opts.host = value()
        break
      case '--token':
        opts.token = value()
        break
      case '--web-root':
        opts.webRoot = resolve(value())
        break
      case '--install-statusline':
        opts.installStatusline = true
        break
      case '--dev':
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`)
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`invalid port: ${opts.port}`)
  }
  /*
   * Fixtures must never be served at the address the real fleet lives at.
   * Someone who opens 4317 out of habit and finds nine invented agents has no
   * way to tell that from their own having vanished -- and the composer on that
   * page would then be typing into nothing. qa-sweep.sh already refuses this
   * port for the same reason; this closes the same hole one level down.
   */
  if (opts.mock && opts.port === PROD_PORT) {
    throw new Error(
      `refusing to serve mock fixtures on ${PROD_PORT} -- that is the production port.\n` +
        `Use --port ${DEV_PORT} for development.`,
    )
  }
  if (opts.token === 'auto') opts.token = randomBytes(16).toString('hex')
  // INV-3
  if (!LOOPBACK.has(opts.host) && !opts.token) {
    throw new Error(
      `refusing to bind ${opts.host} without --token.\n` +
        'This app can send input to live agents and answer their permission prompts.\n' +
        'Use --token auto to generate one, or --token <secret> to set your own.',
    )
  }
  return opts
}

function splitOnce(input: string, sep: string): [string, string] {
  const at = input.indexOf(sep)
  return [input.slice(0, at), input.slice(at + 1)]
}

/**
 * Wire the quota bridge into Claude Code.
 *
 * The 5-hour and 7-day windows are not in any transcript -- Claude Code hands
 * them to a statusLine command and nowhere else -- so the dashboard cannot show
 * quota until `scripts/statusline-bridge.mjs` is running as that command. This
 * does the edit rather than leaving the user to hand-merge JSON.
 *
 * It never overwrites an existing statusLine. Someone who already has one has
 * put work into it, and silently replacing it would be the worst possible
 * outcome of a flag whose name promises only an addition.
 */
function installStatusline(): boolean {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  const bridge = resolve(HERE, '..', '..', 'scripts', 'statusline-bridge.mjs')
  const snippet = { type: 'command', command: `node ${bridge}` }

  if (!existsSync(bridge)) {
    process.stderr.write(`cannot find the bridge script at ${bridge}\n`)
    return false
  }

  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      process.stderr.write(`${settingsPath} is not valid JSON — fix it, or add this by hand:\n`)
      process.stderr.write(`${JSON.stringify({ statusLine: snippet }, null, 2)}\n`)
      return false
    }
  }

  if (settings.statusLine) {
    process.stdout.write(
      `${settingsPath} already has a statusLine, which this will not overwrite.\n` +
        `To bridge quota from it, have your command also run:\n  node ${bridge}\n`,
    )
    return false
  }

  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak`)
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify({ ...settings, statusLine: snippet }, null, 2)}\n`)
  process.stdout.write(
    `added statusLine to ${settingsPath} (backup at ${settingsPath}.bak).\n` +
      'Start a new Claude Code session and send one prompt; quota appears once it has an API response.\n',
  )
  return true
}

function printHelp(): void {
  process.stdout.write(
    [
      'agent-commander — see and steer every Claude Code agent on this machine',
      '',
      'Usage: agent-commander [options]',
      '',
      `  -p, --port <n>     port to listen on (default ${PROD_PORT})`,
      '      --host <addr>  bind address (default 127.0.0.1; requires --token if not loopback)',
      '      --token <s>    require this token; "auto" generates one',
      '      --mock         serve fixture agents, touching nothing real',
      '      --mock-transitions  like --mock, but statuses change on a timer',
      '      --browse-root <d>  root the folder picker is confined to (default: home)',
      '      --install-statusline  add the quota bridge to ~/.claude/settings.json and exit',
      '      --web-root <d> directory of built web assets',
      '  -h, --help         show this help',
      '',
    ].join('\n'),
  )
}

/**
 * One agent's delegates, read from the sidecars beside its transcript.
 *
 * The transcript is located per call rather than cached here because
 * `findTranscript` already caches nothing and the forest polls only while
 * somebody has the view open (INV-4). The sidecars themselves are cached in
 * `subagents.ts`, which is where the repeated cost would otherwise be.
 */
async function readAgentTree(agent: Agent) {
  return readTree(agent, await findTranscript(agent.sessionId))
}

async function main(): Promise<void> {
  let opts: Options
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
    return
  }

  if (opts.installStatusline) {
    process.exit(installStatusline() ? 0 : 1)
    return
  }

  const pending = new PendingStore()
  // Mock mode reports whatever mode was last asked for, so the UI round-trips.
  let mockMode: string = 'auto'
  let mockGoal: GoalState | undefined
  /*
   * The fake session's id, and it has to be a variable for one control only.
   * `/clear` does not edit a session, it replaces one — Claude Code opens a
   * fresh transcript under a new id — so a mock that kept a fixed id would
   * exercise the *unverified* path every time and never the one a user gets.
   */
  /*
   * Which session id each fake process is running *now*, keyed by pid because
   * that is what `clearContext` asks with. Seeded from the fleet on first use
   * so it starts out agreeing with the fixtures.
   */
  const mockSessionIds = new Map<number, string>()
  const mockSessionOf = (pid: number): string => {
    const known = mockSessionIds.get(pid)
    if (known !== undefined) return known
    const found = source.list().find((a) => a.pid === pid)?.sessionId ?? `mock-session-${pid}`
    mockSessionIds.set(pid, found)
    return found
  }

  let source: AgentSource
  let paneApi: PaneApi
  let makeTail: (sessionId: string) => TailApi
  let limits: LimitsApi

  if (opts.mock) {
    source = new MockSource(opts.mockTransitions)
    paneApi = new MockPanes()
    makeTail = (id) => new MockTail(id)
    limits = new MockLimits(opts.mockTransitions)
  } else {
    // Claude first: what it reports about itself always beats what this app can
    // infer from a pane, and `CompositeSource` resolves a clash that way.
    source = new CompositeSource([new Registry(undefined, pending), new TmuxProvider()])
    paneApi = panes
    makeTail = (id) => new TranscriptTail(id)
    limits = new RateLimitWatcher()
    if (!(await panes.available())) {
      process.stderr.write(
        'warning: no tmux server reachable — agents will list but cannot be attached to.\n',
      )
    } else {
      /*
       * Brought up in the background, never awaited. Once it answers, every
       * pane read and write goes down one pipe instead of forking a fresh
       * tmux client, which is the difference between p50 ~70ms and p50 ~20ms
       * per round trip — and, on a machine at its process cap, the difference
       * between working and `spawn tmux EAGAIN`. It is attached with
       * `ignore-size`, so INV-1 holds; see tmux-client.ts.
       */
      tmuxControl.start()
      // Clear staging directories left by runs that were killed rather than
      // asked to stop. Nothing waits on this.
      void panes.sweepStaleStaging()
    }
  }

  await source.start()
  limits.start()

  // Keeps the activity line on every card current, not just the open one.
  const enricher = new FleetEnricher(source, makeTail)
  // One pass now, so the first page load and `GET /api/agents` already carry
  // activity lines, and then nothing until a browser actually connects: this
  // is the most expensive loop in the app — one transcript tail per agent —
  // and with no tab open there is nobody for it to feed (INV-4).
  enricher.start()
  enricher.setWatched(false)

  const env = await probeEnv(opts.port)

  /** See the `tree` option below: the mock fleet's ages are fixed, as real ones are. */
  const mockEpoch = Date.now()

  const server = createAppServer({
    source,
    panes: paneApi,
    makeTail,
    mock: opts.mock,
    webRoot: opts.webRoot,
    token: opts.token,
    env,
    pending,
    limits,
    onViewers: (count) => enricher.setWatched(count > 0),
    // Real trees are read off disk from the sidecars Claude Code writes; mock
    // mode substitutes its own below, through the same route.
    ...(opts.mock ? {} : { tree: (agent: Agent) => readAgentTree(agent) }),
    ...(opts.browseRoot ? { browseRoot: opts.browseRoot } : {}),
    // Mock mode advertises the flow but must never start a real process. It
    // still runs the same directory validation, so the error path a user hits
    // in mock mode is the one they would hit for real.
    ...(opts.mock
      ? {
          /*
           * Pinned to one instant for the life of the process, not `Date.now()`
           * per call.
           *
           * A real delegate's `lastWriteAt` is an mtime — a fixed point that
           * does not move once the delegate stops writing. Recomputing the
           * fixtures' ages on every poll slid them forward instead, so the
           * graph was a different graph three seconds later and the conditional
           * request in INV-4 could never produce a 304 in mock mode. That made
           * the mock fleet advertise a cost the real one does not have, which
           * is the opposite of what it is for.
           */
          tree: async (agent: Agent) => mockTree(agent, mockEpoch),
          spawn: async (req) => ({
            tmuxSession: 'mock-session',
            // The same checks the real path runs — directory, model and mode —
            // so an unknown alias fails here exactly as it would for real.
            cwd: await checkSpawnRequest(req),
          }),
          // Same guards and the same closed-loop shape, but nothing is typed
          // anywhere: the fake pane advances through the real cycle so the UI
          // round-trip can be exercised end to end.
          control: {
            paste: async (paneId: string, text: string) => {
              // The goal toggle is the one control whose state the fake pane
              // has to hold: without it the UI would set a goal and read back
              // nothing, which is the failure path, not the happy one.
              if (text === '/goal clear') {
                mockGoal = undefined
                return
              }
              /*
               * `/clear` is verified by the session id turning over, so the
               * fake session has to turn it over — and the fixture fleet has to
               * follow, or mock mode never exercises the path where the browser
               * has to find the agent again under its new id. That path is the
               * one with the sharp edge (INV-8), so it is the one mock mode
               * most needs to have.
               */
              if (text === '/clear') {
                const current = SESSION_BY_PANE.get(paneId)
                const agent = current ? source.get(current) : undefined
                if (agent && source instanceof MockSource) {
                  const next = `mock-session-${Date.now()}`
                  mockSessionIds.set(agent.pid, next)
                  source.rotate(agent.sessionId, next)
                }
                mockGoal = undefined
                return
              }
              // `/compact` is not verified at all and writes nothing here; the
              // real one is observed later through the transcript.
              if (text === '/compact') return
              const set = /^\/goal (.+)$/.exec(text)
              if (set) {
                mockGoal = { condition: set[1] as string, met: false, at: Date.now(), fresh: true }
              }
            },
            key: async () => {
              const i = MODE_CYCLE.indexOf(mockMode as (typeof MODE_CYCLE)[number])
              mockMode = MODE_CYCLE[(i + 1) % MODE_CYCLE.length] as string
            },
            readMode: async () => mockMode,
            readGoal: async () => mockGoal,
            readSessionId: async (pid: number) => mockSessionOf(pid),
            paneAlive: async () => false,
            killSession: async () => {},
            wait: async () => {},
          },
        }
      : {}),
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`port ${opts.port} is already in use — try --port ${opts.port + 1}\n`)
      process.exit(1)
    }
    throw err
  })

  server.listen(opts.port, opts.host, () => {
    const shown = opts.host === '::1' ? '[::1]' : opts.host
    const query = opts.token ? `?token=${opts.token}` : ''
    const count = source.list().length
    process.stdout.write(
      `agent-commander on http://${shown}:${opts.port}/${query}\n` +
        (opts.mock ? '  mock mode — no real agent is touched\n' : `  watching ${count} agent(s)\n`),
    )
  })

  const shutdown = (): void => {
    enricher.stop()
    limits.stop()
    source.stop()
    tmuxControl.stop()
    void panes.cleanup()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * Whether this file was run as the program, rather than imported by a test.
 *
 * Compared through `realpathSync`, because npm installs the `bin` as a symlink:
 * argv[1] is `<prefix>/bin/agent-commander` while `import.meta.url` is the real
 * `dist/server/cli.js` it points at. A plain string compare says those differ,
 * `main()` never runs, and the published binary starts a process that does
 * absolutely nothing -- no output, no port, no error. That is exactly what
 * shipped in 0.1.0 through 0.1.3.
 */
function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    // realpath can fail for reasons that are not "different file" -- EACCES on
    // an unreadable component of the install prefix, ENOENT/EPERM on some
    // container and network mounts. Falling back to false would resurrect the
    // silent no-op this function exists to prevent, so compare what we have.
    return resolve(a) === resolve(b)
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (sameFile(process.argv[1], fileURLToPath(import.meta.url)) ||
    resolve(process.argv[1]) === join(HERE, 'cli.ts'))

if (invokedDirectly) void main()
