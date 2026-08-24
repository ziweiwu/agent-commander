/**
 * Drive a realistic WebSocket session against a backend, for `ab-bench.py`.
 *
 * "Realistic" means the shape the Attach view actually produces: one viewer,
 * focused on one agent, attached, receiving frames at the pane cadence, with
 * occasional typing going the other way. Hammering the socket with synthetic
 * traffic would measure something the app never does.
 *
 * Usage: node scripts/ws-load.mjs <port> <seconds> [viewers]
 */
import { WebSocket } from 'ws'

const port = Number(process.argv[2])
const seconds = Number(process.argv[3] ?? 20)
const viewers = Number(process.argv[4] ?? 1)

if (!port) {
  console.error('usage: node scripts/ws-load.mjs <port> <seconds> [viewers]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let framesSeen = 0

function viewer() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` })
    let typer = null
    const finish = () => {
      clearInterval(typer)
      try { ws.close() } catch {}
      resolve()
    }
    ws.on('message', (raw) => {
      // Parse every frame, exactly as the browser client would. Counting bytes
      // without parsing would let a backend look fast by shipping garbage.
      try {
        const m = JSON.parse(raw.toString())
        if (m.type === 'frame') framesSeen++
      } catch {}
    })
    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'focus', sessionId: 'mock-waiting' }))
      await sleep(200)
      ws.send(JSON.stringify({ type: 'attach', sessionId: 'mock-waiting', on: true }))
      // A person types a character every ~120 ms; INV-12 bounds this anyway.
      let seq = 0
      typer = setInterval(() => {
        ws.send(JSON.stringify({
          type: 'paste', sessionId: 'mock-waiting', text: 'a', submit: false, seq: seq++,
        }))
      }, 120)
      setTimeout(finish, seconds * 1000)
    })
    ws.on('error', finish)
    setTimeout(finish, seconds * 1000 + 5000)
  })
}

await Promise.all(Array.from({ length: viewers }, () => viewer()))
console.log(JSON.stringify({ framesSeen, seconds, viewers }))
