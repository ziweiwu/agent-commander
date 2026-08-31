/**
 * One version, two manifests, and a binary that can be asked.
 *
 * `package.json` and `rust/Cargo.toml` describe the same release: npm ships the
 * binary that Cargo builds. They drifted the moment the port landed — the npm
 * package went to 0.8.0 and the crate stayed at 0.7.0 — and nothing noticed,
 * because the publish workflow checks the git tag against `package.json` and
 * never looks at Cargo.toml. A release would have shipped a package claiming
 * one version around a binary compiled with another.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const npmVersion = (): string =>
  (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version

/** The `version` of the `[package]` table, not of any dependency below it. */
const cargoVersion = (): string | undefined => {
  const manifest = readFileSync('rust/Cargo.toml', 'utf8')
  const table = manifest.slice(manifest.indexOf('[package]'))
  const upToNextTable = table.slice(0, table.indexOf('\n[', 1))
  return /^version\s*=\s*"([^"]+)"/m.exec(upToNextTable)?.[1]
}

describe('the two manifests describe one release', () => {
  it('agree on the version', () => {
    expect(cargoVersion()).toBe(npmVersion())
  })

  /*
   * The binary compiles its own version in from `CARGO_PKG_VERSION`, so it
   * cannot disagree with the crate that built it — which is only worth
   * anything while the crate agrees with the package it ships inside. That is
   * the whole chain: tag -> package.json -> Cargo.toml -> the running binary,
   * and the test above is the link nothing else checks.
   */
  it('reads a version out of the crate at all', () => {
    expect(cargoVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
