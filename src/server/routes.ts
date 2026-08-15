/**
 * HTTP + WebSocket surface.
 *
 * One WebSocket per browser tab. The tab declares which agent it is looking at
 * (`focus`) and whether the terminal view is open (`attach`); the server only
 * polls what is actually being watched (INV-4).
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  ALLOWED_KEYS,
  type Agent,
  type ClientMessage,
  type ServerMessage,
} from '../shared/types.ts'
import type { AgentSource, LimitsApi, PaneApi, TailApi } from './sources.ts'
import { SpawnError, SpawnOptionError, startAgent } from './spawn.ts'
import {
  clearGoal,
  closeAgent,
  ControlError,
  liveDeps,
  setGoal,
  setMode,
  setModel,
} from './control.ts'
import { BrowseError, listDirs } from './browse.ts'
import { readGoal, readPermissionMode } from './transcript.ts'
import type { PendingStore } from './pending.ts'
import type {
  ControlResponse,
  NewAgentRequest,
  NewAgentResponse,
  ServerEnv,
} from '../shared/types.ts'
import { buildFrame, isNoop } from './frames.ts'

const FRAME_MS = 140
const TIMELINE_MS = 1000
const MAX_PASTE = 100_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

const KEY_SET: ReadonlySet<string> = new Set(ALLOWED_KEYS)

export interface ServeOptions {
  source: AgentSource
  panes: PaneApi
  makeTail: (sessionId: string) => TailApi
  mock: boolean
  webRoot: string
  token?: string | undefined
  env: ServerEnv
  /** Injected so mock mode can offer the flow without spawning anything real. */
  spawn?: (req: NewAgentRequest) => Promise<{ tmuxSession: string; cwd: string }>
  /** Shows a just-started session until it registers itself. */
  pending?: PendingStore
  /** Root the folder browser is confined to; defaults to the home directory. */
  browseRoot?: string
  /** Injected by tests and by mock mode so no real agent is driven. */
  control?: import('./control.ts').ControlDeps
  /** Account-level quota. Absent in tests that only exercise the fleet. */
  limits?: LimitsApi
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** One browser tab's view state. */
class Viewer {
  focused: string | null = null
  attached = false
  tail: TailApi | null = null
  prevLines: string[] | null = null
  prevCursor: { x: number; y: number } | null = null
  frameTimer: NodeJS.Timeout | null = null
  tailTimer: NodeJS.Timeout | null = null
  frameBusy = false
  tailBusy = false

  constructor(readonly socket: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(msg))
  }

  clearTimers(): void {
    if (this.frameTimer) clearInterval(this.frameTimer)
    if (this.tailTimer) clearInterval(this.tailTimer)
    this.frameTimer = null
    this.tailTimer = null
  }

  resetPane(): void {
    this.prevLines = null
    this.prevCursor = null
  }
}

export function createAppServer(opts: ServeOptions): Server {
  const webRoot = resolve(opts.webRoot)

  const authorized = (url: URL, req: IncomingMessage): boolean => {
    if (!opts.token) return true
    const fromQuery = url.searchParams.get('token')
    const header = req.headers.authorization
    const fromHeader = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const supplied = fromQuery ?? fromHeader
    return typeof supplied === 'string' && safeEqual(supplied, opts.token)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!authorized(url, req)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized: append ?token=... to the URL')
      return
    }
    if (url.pathname === '/api/agents' && req.method !== 'POST') {
      res.writeHead(200, { 'content-type': MIME['.json'] as string })
      res.end(JSON.stringify({ agents: opts.source.list(), mock: opts.mock }))
      return
    }
    if (url.pathname === '/api/env') {
      res.writeHead(200, { 'content-type': MIME['.json'] as string })
      res.end(JSON.stringify(opts.env))
      return
    }
    if (url.pathname === '/api/agents' && req.method === 'POST') {
      void handleNewAgent(req, res, opts)
      return
    }
    if (url.pathname === '/api/dirs') {
      void handleBrowse(url, res, opts)
      return
    }
    const control = /^\/api\/agents\/([^/]+)\/(close|mode|model|goal)$/.exec(url.pathname)
    if (control && req.method === 'POST') {
      void handleControl(req, res, opts, decodeURIComponent(control[1] as string), control[2] as string)
      return
    }
    void serveStatic(webRoot, url.pathname, res, opts.mock)
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws' || !authorized(url, req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws) => {
    const viewer = new Viewer(ws)
    viewer.send({ type: 'fleet', agents: opts.source.list(), mock: opts.mock })
    const off = opts.source.onChange((agents: Agent[]) => {
      viewer.send({ type: 'fleet', agents, mock: opts.mock })
    })
    /*
     * Quota is account-level, so every tab gets the same reading and a fresh
     * tab needs the current one immediately -- waiting for the next statusline
     * render would leave the meters blank for however long the fleet is idle.
     */
    viewer.send({ type: 'limits', limits: opts.limits?.current() ?? null })
    const offLimits =
      opts.limits?.onChange((limits) => viewer.send({ type: 'limits', limits })) ?? (() => {})

    ws.on('message', (raw) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(String(raw)) as ClientMessage
      } catch {
        return
      }
      void handle(msg, viewer, opts)
    })

    ws.on('close', () => {
      off()
      offLimits()
      viewer.clearTimers()
    })
    ws.on('error', () => {
      off()
      offLimits()
      viewer.clearTimers()
    })
  })

  return server
}

async function handle(msg: ClientMessage, viewer: Viewer, opts: ServeOptions): Promise<void> {
  switch (msg.type) {
    case 'focus': {
      viewer.clearTimers()
      viewer.attached = false
      viewer.resetPane()
      viewer.focused = msg.sessionId
      viewer.tail = msg.sessionId ? opts.makeTail(msg.sessionId) : null
      if (!msg.sessionId) return
      await pumpTimeline(viewer, opts)
      viewer.tailTimer = setInterval(() => void pumpTimeline(viewer, opts), TIMELINE_MS)
      return
    }

    case 'attach': {
      if (viewer.focused !== msg.sessionId) return
      viewer.attached = msg.on
      viewer.resetPane()
      if (viewer.frameTimer) clearInterval(viewer.frameTimer)
      viewer.frameTimer = null
      if (!msg.on) return
      await pumpFrame(viewer, opts)
      viewer.frameTimer = setInterval(() => void pumpFrame(viewer, opts), FRAME_MS)
      return
    }

    case 'paste': {
      const agent = opts.source.get(msg.sessionId)
      if (!agent?.paneId) {
        viewer.send({
          type: 'error',
          sessionId: msg.sessionId,
          message: agent?.attachBlockedReason ?? 'agent is no longer available',
        })
        return
      }
      if (msg.text.length > MAX_PASTE) {
        viewer.send({ type: 'error', sessionId: msg.sessionId, message: 'input too large' })
        return
      }
      try {
        await opts.panes.paste(agent.paneId, msg.text, msg.submit)
      } catch (err) {
        viewer.send({ type: 'error', sessionId: msg.sessionId, message: reason(err) })
      }
      return
    }

    case 'key': {
      const agent = opts.source.get(msg.sessionId)
      if (!agent?.paneId) return
      // INV-2: only keys on the allowlist ever reach a live agent.
      if (!KEY_SET.has(msg.key)) {
        viewer.send({ type: 'error', sessionId: msg.sessionId, message: `key not allowed: ${msg.key}` })
        return
      }
      try {
        await opts.panes.key(agent.paneId, msg.key)
      } catch (err) {
        viewer.send({ type: 'error', sessionId: msg.sessionId, message: reason(err) })
      }
    }
  }
}

async function pumpTimeline(viewer: Viewer, opts: ServeOptions): Promise<void> {
  const sessionId = viewer.focused
  if (!sessionId || !viewer.tail || viewer.tailBusy) return
  viewer.tailBusy = true
  try {
    const { events, patch, first } = await viewer.tail.read()
    if (Object.keys(patch).length > 0) opts.source.enrich(sessionId, patch)
    if (events.length > 0 || first) {
      viewer.send({ type: 'timeline', sessionId, events, reset: first })
    }
  } catch {
    // INV-5: a transcript that cannot be read must not kill the session view.
  } finally {
    viewer.tailBusy = false
  }
}

async function pumpFrame(viewer: Viewer, opts: ServeOptions): Promise<void> {
  const sessionId = viewer.focused
  if (!sessionId || !viewer.attached || viewer.frameBusy) return
  const agent = opts.source.get(sessionId)
  if (!agent?.paneId) return
  viewer.frameBusy = true
  try {
    const meta = await opts.panes.meta(agent.paneId)
    if (meta.dead) {
      viewer.send({ type: 'error', sessionId, message: 'pane has exited' })
      viewer.attached = false
      viewer.clearTimers()
      return
    }
    const lines = await opts.panes.capture(agent.paneId, meta.rows)
    const prev = viewer.prevLines && viewer.prevLines.length === lines.length ? viewer.prevLines : null
    const frame = buildFrame(sessionId, prev, lines, meta)
    if (!isNoop(frame, viewer.prevCursor)) viewer.send({ type: 'frame', frame })
    viewer.prevLines = lines
    viewer.prevCursor = { x: meta.cursorX, y: meta.cursorY }
  } catch (err) {
    viewer.send({ type: 'error', sessionId, message: reason(err) })
    viewer.attached = false
    viewer.clearTimers()
  } finally {
    viewer.frameBusy = false
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function serveStatic(
  root: string,
  pathname: string,
  res: ServerResponse,
  mock = false,
): Promise<void> {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '')
  const file = join(root, rel)
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden')
    return
  }
  // `normalize('/index.html')` keeps its leading slash, so match both forms.
  const isDocument = rel === 'index.html' || rel === '/index.html'
  if (await sendFile(file, res, isDocument && mock)) return

  // Single-page app fallback: /agent/<id> is a client route, not a file. Only
  // extensionless paths fall through, so a genuinely missing asset still 404s.
  if (extname(rel) === '') {
    if (await sendFile(join(root, 'index.html'), res, mock)) return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found — run `npm run build:web` first')
}

async function sendFile(file: string, res: ServerResponse, stampMock = false): Promise<boolean> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return false

    /*
     * The mock banner used to arrive with the first WebSocket frame, after the
     * page had already painted, and inserting it pushed the entire layout down
     * 28px — a measured CLS of 0.121, all of it from that one shift. Stamping
     * the mode into the document means React's first render already has the
     * banner, so nothing moves. The document is ~3KB, so reading it to rewrite
     * one attribute costs nothing next to streaming it.
     */
    if (stampMock) {
      const html = (await readFile(file, 'utf8')).replace('<html ', '<html data-mock="true" ')
      const body = Buffer.from(html, 'utf8')
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': body.byteLength })
      res.end(body)
      return true
    }

    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
    })
    createReadStream(file).pipe(res)
    return true
  } catch {
    return false
  }
}

const MAX_BODY = 8 * 1024

/** Read a small JSON body, refusing anything oversized. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(buf)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function handleNewAgent(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServeOptions,
): Promise<void> {
  const reply = (code: number, body: NewAgentResponse): void => {
    res.writeHead(code, { 'content-type': MIME['.json'] as string })
    res.end(JSON.stringify(body))
  }
  if (!opts.env.tmux) {
    reply(409, { ok: false, error: 'tmux is not available on this machine' })
    return
  }
  try {
    const body = (await readJson(req)) as NewAgentRequest
    if (!body || typeof body.cwd !== 'string') {
      reply(400, { ok: false, error: 'cwd is required' })
      return
    }
    const spawn = opts.spawn ?? startAgent
    const result = await spawn({ cwd: body.cwd, name: body.name })
    opts.pending?.add({ ...result, name: body.name })
    reply(200, { ok: true, ...result })
  } catch (err) {
    const message = err instanceof SpawnError || err instanceof Error ? err.message : String(err)
    reply(err instanceof SpawnError ? 400 : 500, { ok: false, error: message })
  }
}

async function handleBrowse(url: URL, res: ServerResponse, opts: ServeOptions): Promise<void> {
  try {
    const listing = await listDirs(url.searchParams.get('path') ?? undefined, {
      ...(opts.browseRoot ? { root: opts.browseRoot } : {}),
      includeHidden: url.searchParams.get('hidden') === '1',
    })
    res.writeHead(200, { 'content-type': MIME['.json'] as string })
    res.end(JSON.stringify(listing))
  } catch (err) {
    const status = err instanceof BrowseError ? 400 : 500
    res.writeHead(status, { 'content-type': MIME['.json'] as string })
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
}

/** Close, mode and model. Each refuses a busy agent inside control.ts (INV-8). */
async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServeOptions,
  sessionId: string,
  action: string,
): Promise<void> {
  const reply = (code: number, body: ControlResponse): void => {
    res.writeHead(code, { 'content-type': MIME['.json'] as string })
    res.end(JSON.stringify(body))
  }

  try {
    const agent = opts.source.get(sessionId)
    const deps =
      opts.control ?? liveDeps(() => readPermissionMode(sessionId), () => readGoal(sessionId))

    if (action === 'close') {
      const result = await closeAgent(agent as never, deps)
      reply(200, { ok: true, detail: result.forced ? 'forced' : 'exited' })
      return
    }

    const body = (await readJson(req)) as { value?: string | null }
    const value = String(body?.value ?? '')

    if (action === 'goal') {
      // An empty value is the toggle being turned off, not a malformed set.
      if (value.trim().length === 0) {
        await clearGoal(agent as never, deps)
        // Nothing records a cleared goal, so this is the only place that knows
        // it happened — see clearGoal.
        opts.source.enrich(sessionId, { goal: undefined })
        opts.source.notify?.()
        reply(200, { ok: true, detail: 'cleared' })
        return
      }
      const result = await setGoal(agent as never, value, deps)
      if (!result.ok) {
        reply(409, {
          ok: false,
          error: 'the session did not record the goal — it may not have been at its prompt',
        })
        return
      }
      if (result.goal) {
        // Publish it now rather than leaving the card a tick behind the toggle
        // that just set it.
        opts.source.enrich(sessionId, { goal: result.goal })
        opts.source.notify?.()
      }
      reply(200, { ok: true, detail: result.goal?.condition ?? value })
      return
    }

    if (action === 'model') {
      await setModel(agent as never, value, deps)
      reply(200, { ok: true, detail: value })
      return
    }

    const result = await setMode(agent as never, value, deps)
    if (!result.ok) {
      reply(409, {
        ok: false,
        error: `could not reach ${value}; the session is in ${result.mode ?? 'an unknown mode'}`,
      })
      return
    }
    reply(200, { ok: true, detail: result.mode ?? value })
  } catch (err) {
    const known = err instanceof ControlError || err instanceof SpawnOptionError
    reply(known ? 400 : 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
