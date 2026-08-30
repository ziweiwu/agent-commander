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
import { createHash, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  ALLOWED_KEYS,
  DESTRUCTIVE_KEYS,
  type Agent,
  type ClientMessage,
  type ServerMessage,
} from '../shared/types.ts'
import type { AgentSource, LimitsApi, PaneApi, TailApi } from './sources.ts'
import { SpawnError, SpawnOptionError, startAgent } from './spawn.ts'
import {
  clearContext,
  clearGoal,
  closeAgent,
  compactContext,
  ControlError,
  cycleMode,
  liveDeps,
  setGoal,
  setModel,
} from './control.ts'
import { BrowseError, isInside, listDirs } from './browse.ts'
import { readGoal, readPermissionMode } from './transcript.ts'
import type { PendingStore } from './pending.ts'
import type {
  AgentTree,
  ControlResponse,
  FleetTree,
  NewAgentRequest,
  NewAgentResponse,
  ServerEnv,
} from '../shared/types.ts'
import { buildFrame, isNoop } from './frames.ts'
import { PaneHub } from './pane-hub.ts'
import { Poller } from './poll.ts'

/** Accepted; the body's `detail` says what actually happened. */
const HTTP_OK = 200
const HTTP_NOT_MODIFIED = 304

const TIMELINE_MS = 1000
const MAX_PASTE = 100_000

/**
 * How often each socket is pinged, and how long a silent one is kept.
 *
 * A tab that closes sends a close frame and everything it was driving stops.
 * A phone that goes to sleep on the far side of Tailscale, or a laptop whose
 * Wi-Fi drops, sends nothing at all: the TCP connection is half open, `ws`
 * reports no `close`, and the `Viewer` lives on — still tailing that agent's
 * transcript once a second, and if the terminal was open, still holding a
 * `PaneHub` subscription that makes real tmux round trips. Nothing on this
 * machine is watching any of it, which is precisely what INV-4's first rule
 * forbids, and the connection can sit like that for as long as the OS keepalive
 * takes to notice — hours.
 *
 * A ping answers that in the only way the protocol offers. Two missed rounds
 * rather than one, because a phone that is merely busy for thirty seconds is
 * not a phone that has gone away.
 */
const HEARTBEAT_MS = 30_000

/**
 * How many reads in a row may fail before the terminal gives up.
 *
 * It used to be one. A pane read fails for two very different reasons — the
 * pane is gone, or this machine could not spare a process to ask about it —
 * and treating them the same meant a transient `spawn tmux EAGAIN`, which is
 * ordinary on a machine at its process cap, stopped the user's terminal until
 * they thought to close and re-open it. A dead pane is still reported at once,
 * because that is answered from the pane's own `dead` flag rather than from a
 * failure.
 */
const FRAME_FAIL_LIMIT = 5

/**
 * The most a single WebSocket frame may be.
 *
 * `MAX_PASTE` already refuses oversized text, but it refuses it *after* `ws`
 * has buffered and `JSON.parse` has built the whole message: a 5MB paste was
 * accepted, parsed, and only then rejected, and `ws` defaults to allowing
 * 100MB. Bounding the frame means the memory is never committed. Sized well
 * above `MAX_PASTE` so the two limits cannot disagree about the same paste --
 * this one is about memory, that one is about intent.
 */
const MAX_FRAME_BYTES = 1024 * 1024

/**
 * How much a single tab may ask of a live agent, and how fast.
 *
 * INV-12. INV-2 governs whether input is intentional; nothing governed how
 * *much* of it there could be. Measured before this existed: 5,000 `key`
 * messages sent in 1.5s were all accepted, with no error and no backpressure,
 * and in a live fleet each one is a `send-keys` queued behind the last on that
 * pane's write queue. A key-repeat storm, a loop in a client, or anything that
 * got past the gate could bury a working agent in keystrokes.
 *
 * The bucket is sized for a person and not for a program. Sustained 30/s is
 * far above human typing -- the Attach view coalesces to roughly one write per
 * burst -- and the 120 burst absorbs a held-down arrow key without complaint.
 */
const WRITE_BURST = 120
const WRITE_PER_SECOND = 30

/** A token bucket, refilled continuously rather than on a timer. */
class WriteBudget {
  #tokens = WRITE_BURST
  #last = Date.now()
  /** Whether the client has already been told; telling it per message amplifies. */
  #warned = false

  /** True when this message may proceed. */
  take(now = Date.now()): boolean {
    this.#tokens = Math.min(WRITE_BURST, this.#tokens + ((now - this.#last) / 1000) * WRITE_PER_SECOND)
    this.#last = now
    if (this.#tokens < 1) return false
    this.#tokens -= 1
    this.#warned = false
    return true
  }

  /** True the first time a refusal should be reported, false while it persists. */
  shouldWarn(): boolean {
    if (this.#warned) return false
    this.#warned = true
    return true
  }
}

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
  /**
   * Reads one agent's delegation tree. Injected so mock mode can stand in.
   *
   * Absent in tests that do not exercise the tree; `/api/tree` then reports
   * every agent as having no delegates rather than failing.
   */
  tree?: (agent: Agent) => Promise<AgentTree>
  /** Account-level quota. Absent in tests that only exercise the fleet. */
  limits?: LimitsApi
  /**
   * How many browser tabs are connected, reported whenever it changes.
   *
   * The server is the only thing that knows, and INV-4's first rule — nothing
   * polls what nobody is watching — needs someone to know. `cli.ts` uses it to
   * idle the fleet enricher while no tab is open.
   */
  onViewers?: (count: number) => void
  /**
   * How often to ping each socket. Shortened by the tests, because the thing
   * being tested is a timeout and thirty seconds of it is thirty seconds.
   */
  heartbeatMs?: number
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Pull the hostname out of an Origin or a Host header, brackets stripped. */
function hostnameOf(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    return url.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

/** This machine, addressed as itself (INV-3). */
function isLoopbackName(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * This machine addressed by its own Tailscale name, which is still this
 * machine (INV-3).
 *
 * `tailscale serve` terminates TLS and proxies to the loopback port, forwarding
 * the name the caller asked for. That name is not a loopback one, so the origin
 * check below refused it and a tokenless server was unreachable from the phone
 * it was reached from before the check existed -- the `--token` requirement was
 * the only way back in, for a request that never left the tailnet.
 *
 * Trusting it is narrower than it looks. It is one exact name, this host's own
 * `DNSName`, read from the Tailscale CLI at startup rather than from anything a
 * caller sends; a request only matches by being addressed to this machine on a
 * private network the user administers. A visited web page still cannot use it:
 * its `Origin` is its own domain, which is neither loopback nor this name. Nor
 * can a rebound host, which is refused for exactly the same reason.
 */
function isOwnTailnetName(hostname: string, tailnet: string | null): boolean {
  return tailnet !== null && hostname === tailnet
}

function isSelfName(hostname: string, tailnet: string | null): boolean {
  return isLoopbackName(hostname) || isOwnTailnetName(hostname, tailnet)
}

/** This host's Tailscale name, lowercased and trailing dot removed, if up. */
export function ownTailnetName(env: ServerEnv): string | null {
  const ts = env.tailscale
  if (!ts?.running) return null
  const name = ts.dnsName.replace(/\.$/, '').toLowerCase()
  return name === '' ? null : name
}

/**
 * INV-3's other half: a browser is not a stranger on the network.
 *
 * Binding 127.0.0.1 keeps the network out, but it does nothing about the one
 * program guaranteed to be running on this machine. WebSockets are exempt from
 * CORS entirely, and a POST with a `text/plain` content type is a CORS "simple
 * request" that is sent without a preflight -- so before this check, any page on
 * any origin could open `ws://127.0.0.1:4317/ws`, read the whole fleet, and
 * paste a command plus Enter into a live agent. That is arbitrary code
 * execution by way of a visited web page.
 *
 * Two headers, because they answer different questions:
 *
 *   - `Origin` names the page making the request. Browsers always send it on a
 *     WebSocket handshake and on any cross-origin request, and never let a page
 *     forge it. Absent means a non-browser client (curl, a test, a native app),
 *     which is not the threat this guards.
 *   - `Host` names what the client asked for. Checking it too is what stops DNS
 *     rebinding, where `evil.example` is re-pointed at 127.0.0.1 and the origin
 *     then matches the host perfectly -- both say `evil.example`, and only the
 *     fact that it is not a loopback name gives it away.
 *
 * Only tokenless servers are gated. A configured token is already proof of
 * intent that neither a cross-origin page nor a rebound name can produce: it
 * lives in the URL of the real origin, and an attacker who cannot read that
 * origin cannot supply it.
 *
 * Both headers are measured against the same set: the names that mean *this
 * machine* -- loopback, plus this host's own Tailscale name when Tailscale is
 * up. See `isOwnTailnetName` for why that second one belongs here rather than
 * behind a token.
 */
function sameOriginRequest(req: IncomingMessage, tailnet: string | null): boolean {
  const origin = req.headers.origin
  if (origin !== undefined) {
    // A sandboxed iframe or a file:// page sends the literal "null". It parses
    // as a hostname of that name, which is not one of ours, so it is refused by
    // the same line as anything else foreign.
    const from = hostnameOf(origin)
    if (from === null || !isSelfName(from, tailnet)) return false
  }
  const asked = hostnameOf(req.headers.host)
  return asked !== null && isSelfName(asked, tailnet)
}

/** One browser tab's view state. */
class Viewer {
  focused: string | null = null
  attached = false
  tail: TailApi | null = null
  prevLines: string[] | null = null
  prevCursor: { x: number; y: number } | null = null
  /** Releases this tab's share of the pane poller; see `PaneHub`. */
  unwatch: (() => void) | null = null
  /**
   * The transcript tail for this tab, self-pacing like every other loop.
   *
   * It was a `setInterval` with a `tailBusy` guard, which meant a transcript
   * read slower than a second dropped ticks rather than slowing down — and it
   * was the one server timer with no `unref`, so it also kept the process
   * alive on behalf of a tab that might no longer be there.
   */
  tailLoop: Poller | null = null
  tailBusy = false
  /** Consecutive failed reads, reset by any successful one. */
  frameFails = 0
  /**
   * Answered the last heartbeat.
   *
   * Set by the socket's `pong`, cleared when a ping goes out. A viewer that is
   * still false on the next sweep has missed two rounds and is dropped.
   */
  alive = true
  /** INV-12: how much this tab may still ask of a live agent. */
  readonly budget = new WriteBudget()

  constructor(readonly socket: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(msg))
  }

  clearTimers(): void {
    this.clearFrameTimer()
    this.tailLoop?.stop()
    this.tailLoop = null
  }

  /**
   * Stop polling the pane, and only the pane.
   *
   * The terminal and the conversation are independent: one reads tmux, the
   * other reads a file on disk. A dead pane used to take the transcript timer
   * down with it, so answering "pane has exited" left the chat frozen for that
   * tab until the agent was re-opened -- and nothing said why.
   */
  clearFrameTimer(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  resetPane(): void {
    this.prevLines = null
    this.prevCursor = null
    this.frameFails = 0
  }
}

/**
 * The built bundle, which the token cannot reach and does not need to.
 *
 * A token only ever arrives on the URL the user opened. The `<script>` and
 * `<link>` in `index.html` are ordinary subresource requests carrying neither
 * it nor an `Authorization` header, so gating them 401s the app's own
 * JavaScript and the page hangs on its loading shell -- `--token`, and with it
 * every `--host` flow INV-3 requires a token for, could not start at all.
 *
 * Exempting them costs nothing this gate was protecting. These files are the
 * compiled front end, published verbatim on npm; no agent's directory, prompts
 * or output passes through them. Everything that does carry that -- `/`,
 * `/api/*`, `/ws`, and the client routes served the same shell -- stays gated,
 * so INV-3's guarantee is unchanged: reading or typing to an agent still costs
 * a token in the URL of the real origin. A missing file under this prefix 404s
 * rather than falling through to the shell, so it cannot be used to read one.
 *
 * Only the token gate is bypassed. A tokenless server was never broken here --
 * it has no gate to fail -- so its same-origin check still applies in full, and
 * a cross-origin page gets the same 403 for the bundle as for anything else.
 */
function isPublicAsset(req: IncomingMessage, pathname: string): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/assets/')
}

export function createAppServer(opts: ServeOptions): Server {
  const webRoot = resolve(opts.webRoot)
  // One poller per pane for the whole server, not one per tab (INV-4).
  const hub = new PaneHub(opts.panes)

  const authorized = (url: URL, req: IncomingMessage): boolean => {
    if (!opts.token) return true
    const fromQuery = url.searchParams.get('token')
    const header = req.headers.authorization
    const fromHeader = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const supplied = fromQuery ?? fromHeader
    return typeof supplied === 'string' && safeEqual(supplied, opts.token)
  }

  // Read once: the CLI probe is a subprocess, and this cannot change under us.
  const tailnet = ownTailnetName(opts.env)

  /** True when this request may act at all: the token, or this machine itself. */
  const permitted = (req: IncomingMessage): boolean => {
    return !!opts.token || sameOriginRequest(req, tailnet)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const publicAsset = isPublicAsset(req, url.pathname)
    if (!publicAsset && !authorized(url, req)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized: append ?token=... to the URL')
      return
    }
    if (!permitted(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end(
        'forbidden: this server answers only same-origin requests from localhost.\n' +
          'Reach it at http://127.0.0.1, or start it with --token to use another name.',
      )
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
    if (url.pathname === '/api/tree') {
      void handleTree(req, res, opts)
      return
    }
    const control = /^\/api\/agents\/([^/]+)\/(close|clear|compact|mode|model|goal)$/.exec(
      url.pathname,
    )
    if (control && req.method === 'POST') {
      void handleControl(req, res, opts, decodeURIComponent(control[1] as string), control[2] as string)
      return
    }
    void serveStatic(webRoot, url.pathname, res, opts.mock)
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws' || !authorized(url, req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    // The socket is the whole control surface -- fleet contents out, pastes and
    // keys in -- and CORS does not apply to it, so it gets the same gate.
    if (!permitted(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  /*
   * Every live tab. Two jobs: the heartbeat sweeps it, and its size is what
   * tells the fleet enricher whether anyone is watching (INV-4).
   */
  const viewers = new Set<Viewer>()
  const announce = (): void => opts.onViewers?.(viewers.size)

  const heartbeat = setInterval(() => {
    for (const viewer of viewers) {
      if (!viewer.alive) {
        // Missed two rounds. `terminate` is the abrupt one on purpose: a close
        // handshake needs an answer, and this socket has stopped giving any.
        // Its `close` fires from here, which is what releases the timers.
        viewer.socket.terminate()
        continue
      }
      viewer.alive = false
      try {
        viewer.socket.ping()
      } catch {
        viewer.socket.terminate()
      }
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref?.()
  server.on('close', () => clearInterval(heartbeat))

  wss.on('connection', (ws) => {
    const viewer = new Viewer(ws)
    viewers.add(viewer)
    announce()
    ws.on('pong', () => {
      viewer.alive = true
    })
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
      void handle(msg, viewer, opts, hub)
    })

    const release = (): void => {
      off()
      offLimits()
      viewer.clearTimers()
      if (viewers.delete(viewer)) announce()
    }
    ws.on('close', release)
    ws.on('error', release)
  })

  return server
}

/**
 * One message from one tab.
 *
 * A switch with the four bodies inline came to 108 lines and five levels deep,
 * which is a poor shape for the one function in this server that decides
 * whether something reaches a live agent. Each case is its own function now;
 * the switch is the routing table and nothing else.
 */
async function handle(
  msg: ClientMessage,
  viewer: Viewer,
  opts: ServeOptions,
  hub: PaneHub,
): Promise<void> {
  switch (msg.type) {
    case 'focus':
      return handleFocus(msg, viewer, opts)
    case 'attach':
      return handleAttach(msg, viewer, opts, hub)
    case 'paste':
      return handlePaste(msg, viewer, opts, hub)
    case 'key':
      return handleKey(msg, viewer, opts, hub)
  }
}

/** Point this tab at an agent, and start tailing its transcript. */
async function handleFocus(
  msg: Extract<ClientMessage, { type: 'focus' }>,
  viewer: Viewer,
  opts: ServeOptions,
): Promise<void> {
  viewer.clearTimers()
  viewer.attached = false
  viewer.resetPane()
  viewer.focused = msg.sessionId
  viewer.tail = msg.sessionId ? opts.makeTail(msg.sessionId) : null
  if (!msg.sessionId) return
  await pumpTimeline(viewer, opts)
  viewer.tailLoop = new Poller(TIMELINE_MS, () => pumpTimeline(viewer, opts))
  viewer.tailLoop.start()
}

/** Open or close the terminal for the agent this tab is already focused on. */
function handleAttach(
  msg: Extract<ClientMessage, { type: 'attach' }>,
  viewer: Viewer,
  opts: ServeOptions,
  hub: PaneHub,
): void {
  if (viewer.focused !== msg.sessionId) return
  viewer.attached = msg.on
  viewer.resetPane()
  viewer.clearFrameTimer()
  if (!msg.on) return
  const agent = opts.source.get(msg.sessionId)
  if (!agent?.paneId) return
  watchPane(viewer, hub, agent.paneId, msg.sessionId)
}

/** Text typed at an agent. INV-2 and INV-12 both live on this path. */
async function handlePaste(
  msg: Extract<ClientMessage, { type: 'paste' }>,
  viewer: Viewer,
  opts: ServeOptions,
  hub: PaneHub,
): Promise<void> {
  if (!afford(viewer, msg.sessionId)) return
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
  } finally {
    // Woken *after* the write, not before. tmux has the text now, so the
    // read this starts is the one that can actually catch the echo --
    // starting it beforehand only bought a read of the pane as it was, and
    // an unchanged read is exactly what makes the loop decide to slow down.
    hub.wake(agent.paneId)
    // Acknowledged either way. The ack means "the write is over, send the
    // next chunk", not "the write worked" -- a failed paste that never
    // acked would wedge the Attach view's typing for good.
    if (msg.seq !== undefined) {
      viewer.send({ type: 'paste-ack', sessionId: msg.sessionId, seq: msg.seq })
    }
  }
}

/** A control key. INV-2's allowlist and INV-6's confirmation are both here. */
async function handleKey(
  msg: Extract<ClientMessage, { type: 'key' }>,
  viewer: Viewer,
  opts: ServeOptions,
  hub: PaneHub,
): Promise<void> {
  if (!afford(viewer, msg.sessionId)) return
  const agent = opts.source.get(msg.sessionId)
  if (!agent?.paneId) return
  // INV-2: only keys on the allowlist ever reach a live agent.
  if (!KEY_SET.has(msg.key)) {
    viewer.send({ type: 'error', sessionId: msg.sessionId, message: `key not allowed: ${msg.key}` })
    return
  }
  /*
   * INV-6, enforced here rather than only in the browser.
   *
   * `C-c`, `C-d` and `Escape` are on the allowlist because they are keys a
   * user legitimately sends -- interrupting an agent is half the point of
   * the Attach view. What made them different was a confirmation dialog in
   * `Terminal.tsx`, and nothing else: the server forwarded them to a live
   * agent for anyone who could open a WebSocket, discarding whatever that
   * agent had in flight. That is the exact inversion of INV-2's posture,
   * which says the client's allowlist is a convenience and not the
   * boundary. The flag is not proof a human answered -- nothing on this
   * wire can be -- but it makes sending one deliberate rather than
   * incidental, and it puts the rule where the other rules are.
   */
  if (DESTRUCTIVE_KEYS.has(msg.key) && msg.confirmed !== true) {
    viewer.send({
      type: 'error',
      sessionId: msg.sessionId,
      message: `${msg.key} discards work in progress and needs confirmation`,
    })
    return
  }
  try {
    await opts.panes.key(agent.paneId, msg.key)
  } catch (err) {
    viewer.send({ type: 'error', sessionId: msg.sessionId, message: reason(err) })
  } finally {
    hub.wake(agent.paneId)
  }
}

/**
 * INV-12: spend one unit of this tab's budget, or refuse.
 *
 * `focus` and `attach` are deliberately not charged. They cost this server
 * work, but they do not reach the agent, and a tab switching views quickly is
 * not the thing being guarded against.
 */
function afford(viewer: Viewer, sessionId: string): boolean {
  if (viewer.budget.take()) return true
  // Reported once per burst. An error per refused message would turn a flood
  // into a flood in both directions.
  if (viewer.budget.shouldWarn()) {
    viewer.send({
      type: 'error',
      sessionId,
      message: 'too much input at once — slowing down',
    })
  }
  return false
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

/**
 * Point this tab at a pane and turn shared reads into frames only it can use.
 *
 * The read is shared; the diff is not. `prevLines` is per-viewer because two
 * tabs that attached at different moments have drawn different things, and a
 * delta against rows this tab never drew is a delta against nothing.
 */
function watchPane(viewer: Viewer, hub: PaneHub, paneId: string, sessionId: string): void {
  viewer.unwatch = hub.subscribe(paneId, (event) => {
    if (!viewer.attached || viewer.focused !== sessionId) return

    if (event.error) {
      viewer.frameFails += 1
      if (viewer.frameFails < FRAME_FAIL_LIMIT) return
      viewer.send({ type: 'error', sessionId, message: reason(event.error) })
      // Same as a dead pane: the frames stop, the conversation does not. The
      // transcript is on disk and is still the record of what this agent did.
      viewer.attached = false
      viewer.clearFrameTimer()
      return
    }

    viewer.frameFails = 0
    const { meta, lines } = event.sample
    if (meta.dead) {
      viewer.send({ type: 'error', sessionId, message: 'pane has exited', kind: 'pane-exited' })
      viewer.attached = false
      viewer.clearFrameTimer()
      return
    }

    const prev =
      viewer.prevLines && viewer.prevLines.length === lines.length ? viewer.prevLines : null
    const frame = buildFrame(sessionId, prev, lines, meta)
    if (!isNoop(frame, viewer.prevCursor)) viewer.send({ type: 'frame', frame })
    viewer.prevLines = lines
    viewer.prevCursor = { x: meta.cursorX, y: meta.cursorY }
  })
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
  /*
   * A path-segment check, not a string prefix -- the same standard INV-9 holds
   * the folder browser to. `startsWith` says `/app/dist/web-backup` is inside
   * `/app/dist/web`, and a web root with a sibling that shares its name as a
   * prefix is not an exotic arrangement.
   */
  if (!isInside(root, file)) {
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
  const raw = Buffer.concat(chunks).toString('utf8')
  /*
   * An empty body is a request that carries no value, not a malformed one.
   * `JSON.parse('')` throws, and the error it throws — "Unexpected end of JSON
   * input" — reached the user as a toast reading "that did not take effect"
   * about a control that had never been called. Actions that take no value are
   * now the majority here: close, clear, compact and mode.
   */
  if (raw.length === 0) return undefined
  return JSON.parse(raw)
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
    // Model and mode travel with the request. Dropping them here meant a user
    // who chose "plan" and "opus" got a default agent with no error at all --
    // and silently starting a session in a *different* permission mode than
    // the one asked for is the wrong way round to be wrong.
    const result = await spawn({
      cwd: body.cwd,
      name: body.name,
      model: body.model,
      permissionMode: body.permissionMode,
    })
    opts.pending?.add({ ...result, name: body.name })
    reply(200, { ok: true, ...result })
  } catch (err) {
    const message = err instanceof SpawnError || err instanceof Error ? err.message : String(err)
    // A rejected model or mode is the caller's mistake, not the server's, and
    // the dialog renders a 400 as a reason it can show next to the field.
    const known = err instanceof SpawnError || err instanceof SpawnOptionError
    reply(known ? 400 : 500, { ok: false, error: message })
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

/**
 * The whole fleet's delegation graph.
 *
 * Plain HTTP rather than a fifth socket message, and polled by the forest view
 * only while it is open. That satisfies INV-4's first rule — nothing polls what
 * nobody is watching — without adding a subscription lifecycle to the wire,
 * which is deliberately four messages up and six down. The data is neither hot
 * nor pushed: it is a `readdir` and a few cached sidecar reads per agent.
 */
async function handleTree(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServeOptions,
): Promise<void> {
  const read = opts.tree
  const agents = opts.source.list()
  const trees: AgentTree[] = read
    ? await Promise.all(agents.map((agent) => read(agent)))
    : agents.map((agent) => ({ sessionId: agent.sessionId, children: [] }))
  const body = JSON.stringify({ trees } satisfies FleetTree)
  const etag = `"${createHash('sha1').update(body).digest('base64url')}"`

  /*
   * A delegation graph changes on the order of a minute; this route is polled
   * every three seconds. Measured against 53 real sessions the payload is
   * 54.6 KB and *byte-identical* between consecutive polls — 64 MB an hour
   * re-sent to a phone on Tailscale, which is the connection this app was
   * written for.
   *
   * The pane path has always been careful about exactly this: `buildFrame`
   * sends only the rows that changed and `isNoop` drops a frame with no visual
   * change. This is that rule applied to the graph.
   *
   * The read above still happens — it is a `readdir` and a few cached sidecars,
   * ~3ms for the whole fleet, and skipping it would mean caching state that
   * something else owns. What is saved is the transfer and, because the client
   * keeps its previous array on a 304, the re-render of every node behind it.
   */
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(HTTP_NOT_MODIFIED, { etag })
    res.end()
    return
  }
  res.writeHead(HTTP_OK, { 'content-type': MIME['.json'] as string, etag })
  res.end(body)
}

/**
 * Close, clear, compact, mode, model and goal.
 *
 * Each refuses a busy agent inside control.ts (INV-8), except mode: it sends a
 * control key rather than typing, so it stays available mid-run.
 */
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
  /**
   * The action was accepted. `detail` says *what* happened, which for these is
   * not always "it is done": a model switch made mid-turn is `queued`, and a
   * mode press the session never confirmed is `unverified`.
   */
  const accepted = (detail: string): void => reply(HTTP_OK, { ok: true, detail })

  try {
    const agent = opts.source.get(sessionId)
    const deps =
      opts.control ?? liveDeps(() => readPermissionMode(sessionId), () => readGoal(sessionId))

    if (action === 'close') {
      const result = await closeAgent(agent, deps)
      reply(200, { ok: true, detail: result.forced ? 'forced' : 'exited' })
      return
    }

    /*
     * `/clear` replaces the session rather than editing it, so the new id is
     * the answer and not decoration on it: every URL, socket focus and route
     * naming the old one is dead the moment this returns, and a client that
     * does not follow it loses the agent the user was looking at.
     */
    if (action === 'clear') {
      const result = await clearContext(agent, deps)
      accepted(result.unobserved ? 'unverified' : (result.sessionId ?? 'unverified'))
      return
    }

    // Compaction runs for minutes. Nothing waits on it — see `compactContext`.
    if (action === 'compact') {
      await compactContext(agent, deps)
      accepted('requested')
      return
    }

    /*
     * Mode takes no value either. It advances one Shift+Tab and reports where
     * the session says it landed — there is no target to miss, which is the
     * whole point of the change (see `cycleMode`).
     *
     * `unverified` means the press went out and the session has not written its
     * mode down yet, which a busy one does only at the end of its turn. That is
     * a success the interface qualifies, not an error the user can act on
     * (INV-11).
     */
    if (action === 'mode') {
      const result = await cycleMode(agent, deps)
      accepted(result.unobserved ? 'unverified' : (result.mode ?? 'unverified'))
      return
    }

    const body = (await readJson(req)) as { value?: string | null }
    const value = String(body?.value ?? '')

    if (action === 'goal') {
      // An empty value is the toggle being turned off, not a malformed set.
      if (value.trim().length === 0) {
        await clearGoal(agent, deps)
        // Nothing records a cleared goal, so this is the only place that knows
        // it happened — see clearGoal.
        opts.source.enrich(sessionId, { goal: undefined })
        opts.source.notify?.()
        reply(200, { ok: true, detail: 'cleared' })
        return
      }
      const result = await setGoal(agent, value, deps)
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

    const { queued } = await setModel(agent, value, deps)
    // The agent was mid-turn, so the CLI will read this when the turn ends.
    // Saying `ok` without saying that would claim a switch that has not
    // happened yet (INV-11).
    accepted(queued ? 'queued' : value)
  } catch (err) {
    const known = err instanceof ControlError || err instanceof SpawnOptionError
    reply(known ? 400 : 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
