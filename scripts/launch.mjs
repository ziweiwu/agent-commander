#!/usr/bin/env node
/**
 * The npm entry point for a server that is no longer JavaScript.
 *
 * `bin` has to name a file node can run, and the server is now a Rust binary.
 * This finds that binary and hands the process over to it — `execFileSync` with
 * inherited stdio rather than a spawn, so signals, exit codes and the terminal
 * all behave as if the binary had been invoked directly.
 *
 * Why a shim and not a per-platform package: publishing prebuilt binaries the
 * way esbuild does needs one npm package per platform plus a release pipeline
 * to fill them, which is a distribution decision rather than a porting one.
 * Until that exists this supports the two cases that work today — a checkout
 * that has run `npm run build:server`, and a `cargo install`ed binary on PATH.
 *
 * It fails loudly. A launcher that cannot find its binary and says nothing is
 * exactly the do-nothing install this project has shipped before.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(realpathSync(fileURLToPath(import.meta.url)))

/** Built output first, then anything already on PATH. */
const candidates = [
  join(here, '..', 'rust', 'target', 'release', 'agent-commander'),
  join(here, '..', 'bin', 'agent-commander'),
]

const found = candidates.find((p) => existsSync(p))
if (!found) {
  process.stderr.write(
    'agent-commander: could not find the server binary.\n' +
      'Looked in:\n' +
      candidates.map((p) => `  ${p}\n`).join('') +
      'Build it with `npm run build:server` (needs a Rust toolchain), ' +
      'or install it with `cargo install --path rust`.\n',
  )
  process.exit(1)
}

try {
  execFileSync(found, process.argv.slice(2), { stdio: 'inherit' })
} catch (err) {
  // The child's own exit code is the answer; a null status means a signal.
  process.exit(typeof err?.status === 'number' ? err.status : 1)
}
