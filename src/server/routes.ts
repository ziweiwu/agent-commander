/**
 * HTTP + WebSocket surface.
 *
 * One WebSocket per browser tab. The tab declares which agent it is looking at
 * (`focus`) and whether the terminal view is open (`attach`); the server only
 * polls what is actually being watched (INV-4).
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
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
import type { AgentSource, PaneApi, TailApi } from './sources.ts'
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
    if (url.pathname === '/api/agents') {
      res.writeHead(200, { 'content-type': MIME['.json'] as string })
      res.end(JSON.stringify({ agents: opts.source.list(), mock: opts.mock }))
      return
    }
    void serveStatic(webRoot, url.pathname, res)
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
      viewer.clearTimers()
    })
    ws.on('error', () => {
      off()
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

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '')
  const file = join(root, rel)
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
    })
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found — run `npm run build:web` first')
  }
}
