/**
 * Facts about this machine that the help page needs.
 *
 * The Tailscale hostname is detected rather than typed in, so the help page can
 * show the address that will actually work instead of a placeholder the user
 * has to translate.
 */
import { execFile } from 'node:child_process'
import type { ServerEnv } from '../shared/types.ts'
import { available as tmuxAvailable } from './pane.ts'

/** The Mac app keeps its CLI inside the bundle, so it is usually not on PATH. */
const TAILSCALE_PATHS = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
]

interface TailscaleStatus {
  BackendState?: string
  Self?: { DNSName?: string; TailscaleIPs?: string[] }
}

function run(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

async function detectTailscale(): Promise<ServerEnv['tailscale']> {
  for (const bin of TAILSCALE_PATHS) {
    const out = await run(bin, ['status', '--json'])
    if (!out) continue
    try {
      const status = JSON.parse(out) as TailscaleStatus
      const dnsName = (status.Self?.DNSName ?? '').replace(/\.$/, '')
      const ip = status.Self?.TailscaleIPs?.find((v) => v.includes('.')) ?? ''
      if (!dnsName && !ip) continue
      return {
        cliPath: bin,
        dnsName,
        ip,
        running: status.BackendState === 'Running',
      }
    } catch {
      // A CLI that answered but not with JSON we understand; try the next path.
    }
  }
  return null
}

/**
 * Probed once at startup. None of this changes while the server runs, and the
 * Tailscale probe costs a subprocess, so it is not worth repeating per request.
 */
export async function probeEnv(port: number): Promise<ServerEnv> {
  const [tailscale, tmux] = await Promise.all([detectTailscale(), tmuxAvailable()])
  return { tailscale, tmux, port, platform: process.platform }
}

