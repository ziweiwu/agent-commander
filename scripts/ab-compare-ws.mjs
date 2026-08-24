/**
 * Differential test for the WebSocket surface.
 *
 * The HTTP half lives in `ab-compare.py`; this covers the half that actually
 * carries the app — fleet broadcasts out, pastes and keys in. Both servers run
 * in `--mock` mode on a frozen clock, so the fleet payload is directly
 * comparable.
 *
 * Frame *content* is deliberately NOT compared byte for byte: both servers
 * generate mock frames on their own clock, so frame N from one is not
 * necessarily frame N from the other. What must match is the shape — geometry,
 * row count, the full-then-sparse sequence — and, above all, the refusal
 * behaviour: INV-2 and INV-6 are enforced on this socket, and a Rust server
 * that accepted an unconfirmed Ctrl-C would be a security regression however
 * fast it was.
 *
 * Usage: node scripts/ab-compare-ws.mjs <nodePort> <rustPort>
 */
import { WebSocket } from 'ws'

const [nodePort, rustPort] = process.argv.slice(2).map(Number)
if (!nodePort || !rustPort) {
  console.error('usage: node scripts/ab-compare-ws.mjs <nodePort> <rustPort>')
  process.exit(2)
}

const results = []
const add = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? `\n         ${detail}` : ''}`)
}

/** Open a socket, run a script against it, and collect everything it said. */
function session(port, drive, ms = 1500) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` })
    const msgs = []
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      resolve(msgs)
    }
    ws.on('message', (raw) => {
      try { msgs.push(JSON.parse(raw.toString())) } catch { msgs.push({ type: '<unparseable>' }) }
    })
    ws.on('open', async () => {
      try { await drive(ws, msgs) } catch (e) { msgs.push({ type: '<drive-error>', error: String(e) }) }
      setTimeout(done, ms)
    })
    ws.on('error', (e) => { msgs.push({ type: '<socket-error>', error: String(e) }); done() })
    setTimeout(done, ms + 4000)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const send = (ws, o) => ws.send(JSON.stringify(o))

function deepDiff(a, b, path = '') {
  const out = []
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) out.push(`${path || '<root>'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
    return out
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [`${path}: array vs object`]
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of [...keys].sort()) {
    const p = path ? `${path}.${k}` : k
    if (!(k in a)) out.push(`${p}: absent in node, present in rust`)
    else if (!(k in b)) out.push(`${p}: present in node, absent in rust`)
    else out.push(...deepDiff(a[k], b[k], p))
  }
  return out
}

/* ---------------------------------------------------------------- probes */

// 1. The greeting: every connection is answered with the fleet immediately.
const greet = () => sleep(0)

// 2. Focus a mock agent and attach, which starts frames flowing.
const attach = async (ws) => {
  send(ws, { type: 'focus', sessionId: 'mock-waiting' })
  await sleep(250)
  send(ws, { type: 'attach', sessionId: 'mock-waiting', on: true })
}

// 3. INV-6: an unconfirmed destructive key must be refused by the SERVER.
const unconfirmedCtrlC = async (ws) => {
  send(ws, { type: 'focus', sessionId: 'mock-waiting' })
  await sleep(150)
  send(ws, { type: 'key', sessionId: 'mock-waiting', key: 'C-c' })
}

// 4. INV-2: a key outside the allow-list must be refused.
const bogusKey = async (ws) => {
  send(ws, { type: 'focus', sessionId: 'mock-waiting' })
  await sleep(150)
  send(ws, { type: 'key', sessionId: 'mock-waiting', key: 'C-z; rm -rf /' })
}

// 5. INV-12: input is bounded. A flood must be clamped, not absorbed.
const flood = async (ws) => {
  send(ws, { type: 'focus', sessionId: 'mock-waiting' })
  await sleep(150)
  for (let i = 0; i < 400; i++) {
    send(ws, { type: 'paste', sessionId: 'mock-waiting', text: `x${i}`, submit: false, seq: i })
  }
}

// 6. An oversized payload must not be absorbed.
const oversized = async (ws) => {
  send(ws, { type: 'focus', sessionId: 'mock-waiting' })
  await sleep(150)
  send(ws, { type: 'paste', sessionId: 'mock-waiting', text: 'z'.repeat(2_000_000), submit: false })
}


async function compare(label, drive, ms, check) {
  const [n, r] = await Promise.all([session(nodePort, drive, ms), session(rustPort, drive, ms)])
  check(label, n, r)
}

console.log('\n=== websocket differential ===')

// greeting
await compare('greeting', greet, 700, (label, n, r) => {
  const fn = n.find((m) => m.type === 'fleet')
  const fr = r.find((m) => m.type === 'fleet')
  if (!fn || !fr) {
    add(`${label}: fleet sent on connect`, false, `node=${!!fn} rust=${!!fr}`)
    return
  }
  add(`${label}: fleet sent on connect`, true)
  const d = deepDiff(fn, fr)
  add(`${label}: fleet payload identical`, d.length === 0, d.slice(0, 10).join('\n         '))
})

// attach / frames
await compare('attach', attach, 2200, (label, n, r) => {
  const fnl = n.filter((m) => m.type === 'frame')
  const frl = r.filter((m) => m.type === 'frame')
  add(`${label}: frames flow on both`, fnl.length > 0 && frl.length > 0,
    `node=${fnl.length} rust=${frl.length}`)
  if (!fnl.length || !frl.length) return
  const a = fnl[0].frame
  const b = frl[0].frame
  add(`${label}: first frame is a full repaint on both`,
    Array.isArray(a.lines) && Array.isArray(b.lines),
    `node lines=${Array.isArray(a.lines)} rust lines=${Array.isArray(b.lines)}`)
  add(`${label}: geometry matches`,
    a.cols === b.cols && a.rows === b.rows,
    `node ${a.cols}x${a.rows} vs rust ${b.cols}x${b.rows}`)
  add(`${label}: sessionId echoed`, a.sessionId === b.sessionId,
    `${a.sessionId} vs ${b.sessionId}`)
  const laterN = fnl.slice(1).some((m) => Array.isArray(m.frame.changed))
  const laterR = frl.slice(1).some((m) => Array.isArray(m.frame.changed))
  if (fnl.length > 1 && frl.length > 1) {
    add(`${label}: later frames are sparse on both`, laterN === laterR,
      `node sparse=${laterN} rust sparse=${laterR}`)
  }
})

// INV-6
await compare('INV-6 unconfirmed C-c', unconfirmedCtrlC, 1200, (label, n, r) => {
  const en = n.some((m) => m.type === 'error')
  const er = r.some((m) => m.type === 'error')
  add(`${label}: refused by both`, en && er, `node error=${en} rust error=${er}`)
  add(`${label}: neither silently accepted`, en === er, `node=${en} rust=${er}`)
})

// INV-2
await compare('INV-2 key outside allow-list', bogusKey, 1200, (label, n, r) => {
  const en = n.some((m) => m.type === 'error')
  const er = r.some((m) => m.type === 'error')
  add(`${label}: refused by both`, en && er, `node error=${en} rust error=${er}`)
})

// INV-12
await compare('INV-12 paste flood bounded', flood, 2500, (label, n, r) => {
  const an = n.filter((m) => m.type === 'paste-ack').length
  const ar = r.filter((m) => m.type === 'paste-ack').length
  add(`${label}: node clamped (<400 acks)`, an < 400, `acks=${an}`)
  add(`${label}: rust clamped (<400 acks)`, ar < 400, `acks=${ar}`)
  add(`${label}: both survived the flood`,
    n.some((m) => m.type) && r.some((m) => m.type), 'socket died')
})

// oversized
await compare('oversized payload', oversized, 1500, (label, n, r) => {
  const okn = !n.some((m) => m.type === 'paste-ack' && m.seq === undefined)
  const okr = !r.some((m) => m.type === 'paste-ack' && m.seq === undefined)
  add(`${label}: neither absorbed it`, okn && okr, `node=${okn} rust=${okr}`)
})

// cross-origin WS upgrade must be refused on a tokenless server
{
  const tryOrigin = (port) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://evil.example' })
    let settled = false
    const fin = (v) => { if (!settled) { settled = true; try { ws.close() } catch {}; resolve(v) } }
    ws.on('open', () => fin('accepted'))
    ws.on('error', () => fin('refused'))
    ws.on('unexpected-response', () => fin('refused'))
    setTimeout(() => fin('timeout'), 3000)
  })
  const [rn, rr] = await Promise.all([tryOrigin(nodePort), tryOrigin(rustPort)])
  add('INV-3 cross-origin WS upgrade refused by both',
    rn === 'refused' && rr === 'refused', `node=${rn} rust=${rr}`)
}

const failed = results.filter((r) => !r.ok).length
console.log('\n' + '='.repeat(66))
console.log(`  ${results.length - failed}/${results.length} websocket checks agree`)
console.log('='.repeat(66))
process.exit(failed ? 1 : 0)
