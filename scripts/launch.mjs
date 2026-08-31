#!/usr/bin/env node
/**
 * The npm entry point for a server that is no longer JavaScript.
 *
 * `bin` has to name a file node can run, and the server is now a Rust binary.
 * This finds that binary and hands the process over to it — `execFileSync` with
 * inherited stdio rather than a spawn, so signals, exit codes and the terminal
 * all behave as if the binary had been invoked directly.
 *
 * Why one package carrying every binary rather than a package per platform:
 * the esbuild layout needs an optionalDependency per target published in
 * lockstep, and a half-published set resolves to an install with no server in
 * it. Everything ships here instead, under a directory named exactly
 * `${process.platform}-${process.arch}` so this lookup needs no mapping table
 * and cannot disagree with the one the release pipeline used.
 *
 * It fails loudly. A launcher that cannot find its binary and says nothing is
 * exactly the do-nothing install this project has shipped before.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(realpathSync(fileURLToPath(import.meta.url))), '..')
const host = `${process.platform}-${process.arch}`

/** What the published package carries, so a host outside it can be told why. */
const shippedPlatforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']

/** A published package first, then a built checkout, then `cargo install`. */
const candidates = [
  join(packageRoot, 'dist', 'bin', host, 'agent-commander'),
  join(packageRoot, 'rust', 'target', 'release', 'agent-commander'),
  join(packageRoot, 'bin', 'agent-commander'),
]

const found = candidates.find((candidate) => existsSync(candidate))
if (!found) {
  process.stderr.write(
    `agent-commander: could not find the server binary for ${host}.\n` +
      'Looked in:\n' +
      candidates.map((candidate) => `  ${candidate}\n`).join('') +
      `This package ships binaries for: ${shippedPlatforms.join(', ')}.\n` +
      'From a checkout, build one with `npm run build:server` (needs a Rust ' +
      'toolchain); otherwise `cargo install --path rust`.\n',
  )
  process.exit(1)
}

try {
  execFileSync(found, process.argv.slice(2), { stdio: 'inherit' })
} catch (err) {
  // The child's own exit code is the answer; a null status means a signal.
  process.exit(typeof err?.status === 'number' ? err.status : 1)
}
