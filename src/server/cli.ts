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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry } from './registry.ts'
import { TranscriptTail } from './transcript.ts'
import * as panes from './pane.ts'
import { MockPanes, MockSource, MockTail } from './mock.ts'
import { createAppServer } from './routes.ts'
import { FleetEnricher } from './enrich.ts'
import type { AgentSource, PaneApi, TailApi } from './sources.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

interface Options {
  port: number
  host: string
  token?: string | undefined
  mock: boolean
  mockTransitions: boolean
  webRoot: string
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
    port: 4317,
    host: '127.0.0.1',
    mock: false,
    mockTransitions: false,
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

function printHelp(): void {
  process.stdout.write(
    [
      'agent-commander — see and steer every Claude Code agent on this machine',
      '',
      'Usage: agent-commander [options]',
      '',
      '  -p, --port <n>     port to listen on (default 4317)',
      '      --host <addr>  bind address (default 127.0.0.1; requires --token if not loopback)',
      '      --token <s>    require this token; "auto" generates one',
      '      --mock         serve fixture agents, touching nothing real',
      '      --mock-transitions  like --mock, but statuses change on a timer',
      '      --web-root <d> directory of built web assets',
      '  -h, --help         show this help',
      '',
    ].join('\n'),
  )
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

  let source: AgentSource
  let paneApi: PaneApi
  let makeTail: (sessionId: string) => TailApi

  if (opts.mock) {
    source = new MockSource(opts.mockTransitions)
    paneApi = new MockPanes()
    makeTail = (id) => new MockTail(id)
  } else {
    source = new Registry()
    paneApi = panes
    makeTail = (id) => new TranscriptTail(id)
    if (!(await panes.available())) {
      process.stderr.write(
        'warning: no tmux server reachable — agents will list but cannot be attached to.\n',
      )
    }
  }

  await source.start()

  // Keeps the activity line on every card current, not just the open one.
  const enricher = new FleetEnricher(source, makeTail)
  enricher.start()

  const server = createAppServer({
    source,
    panes: paneApi,
    makeTail,
    mock: opts.mock,
    webRoot: opts.webRoot,
    token: opts.token,
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
    source.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
    resolve(process.argv[1]) === join(HERE, 'cli.ts'))

if (invokedDirectly) void main()
