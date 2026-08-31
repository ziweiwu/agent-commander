import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test'

/**
 * End-to-end tests, against a real browser and a real server.
 *
 * What these are for, and what they are not for. Vitest already covers the
 * server's modules and the components in jsdom, and the four scripts under
 * `scripts/audit-*` already judge how the app looks and reads. Neither can see
 * the joins: a message crossing the WebSocket, being written by the server,
 * coming back through a transcript tail and settling the optimistic copy the
 * browser drew — five modules and two processes, each individually tested, and
 * every bug this app has had at that seam lived between them.
 *
 * They run against `--mock`, always. Mock mode is the same server, the same
 * routes and the same `checkSpawnRequest` (INV-7), with the four provider
 * interfaces swapped for fixtures — so an e2e run exercises the real paths
 * while being unable to reach a real agent. That is what makes it safe to have
 * a browser typing and pressing Ctrl-C in a loop.
 *
 * The port is deliberately not 4317. `cli.ts` refuses to serve fixtures there
 * and `qa-sweep.sh` refuses to fuzz it, for the same reason: a fixture fleet at
 * the production address is indistinguishable from your real one having
 * vanished.
 */
const PORT = Number(process.env.E2E_PORT ?? 4599)

/*
 * Three shapes, because the layout genuinely has three.
 *
 * The breakpoint is 900px: above it the fleet list and the detail sit side by
 * side, below it the detail becomes a sheet that covers the list and the URL
 * is what closes it. A phone is always below and a desktop always above — but
 * a tablet is on both sides of it depending on which way it is being held,
 * which makes it the only shape that crosses the boundary in normal use, and
 * therefore the one where the two layouts have to agree about what is open.
 *
 * Most specs are true everywhere and run everywhere. The ones that are about
 * one shape say so with a tag, and the tag is what excludes them from the
 * others — a tag that only documented the intention would let a
 * hardware-keyboard test go on running on a phone.
 *
 *   @desktop — needs a pointer, a hardware keyboard, or a resizable window
 *   @phone   — only meaningful on a phone-sized screen
 *   @tablet  — about the breakpoint itself, so only meaningful on a tablet
 *   @once    — destroys the fixture it uses, so only one project may run it
 *
 * `@once` is about the server rather than the screen, and it is the odd one
 * out for that reason. All five projects share a single `--mock` server, so a
 * test whose whole subject is a destructive action — `/clear` rotates a
 * session's id, exactly as the real one does — removes its own fixture and
 * every later project finds an agent that is no longer there. Running it in one
 * project is not reduced coverage: what it checks has nothing to do with the
 * viewport.
 */
/**
 * One engine, said out loud.
 *
 * A device descriptor carries a `defaultBrowserType`, and both of the ones used
 * below name WebKit — so on a laptop with every browser installed these ran on
 * WebKit while the desktop project ran on Chromium, and CI, which installs only
 * Chromium, could not launch them at all. Local and CI silently testing
 * different engines is worse than either choice of engine.
 *
 * Chromium is therefore named explicitly rather than inherited, so local and CI
 * run the same engine.
 *
 * WebKit is now a deliberate addition alongside it, not instead of it, and CI
 * installs it to match. Every phone and tablet result this project produced for
 * its first five releases was Chromium wearing an iPhone user-agent — which is
 * a strange thing for an app whose headline feature is reaching it from a phone
 * over Tailscale, where every browser on the device is WebKit. A sweep found no
 * defects in Safari 26.5; these projects are what keeps that true, since the
 * one thing nobody would notice is the day it stops being.
 */
const CHROMIUM = { browserName: 'chromium' } as const
const WEBKIT = { browserName: 'webkit' } as const

const PROJECTS = [
  {
    name: 'desktop',
    use: { ...devices['Desktop Chrome'] },
    // The one project that runs `@once`, because it runs first.
    grepInvert: /@phone|@tablet/,
  },
  {
    name: 'tablet',
    // Portrait: 834px wide, which is *below* the breakpoint. The landscape
    // half is driven inside the specs, because rotating is the point.
    use: { ...devices['iPad Pro 11'], ...CHROMIUM },
    grepInvert: /@phone|@desktop|@once/,
  },
  {
    name: 'phone',
    use: { ...devices['iPhone 13'], ...CHROMIUM },
    grepInvert: /@desktop|@tablet|@once/,
  },
  {
    name: 'phone-safari',
    use: { ...devices['iPhone 13'], ...WEBKIT },
    grepInvert: /@desktop|@tablet|@once/,
  },
  {
    name: 'tablet-safari',
    use: { ...devices['iPad Pro 11'], ...WEBKIT },
    grepInvert: /@phone|@desktop|@once/,
  },
]

const MOCK_SERVER: PlaywrightTestConfig['webServer'] = {
  // Built first: `--mock` serves whatever is in dist/web, and a stale bundle
  // is a test run that passed for the wrong version of the app.
  /*
   * The Rust backend, which is now the only one. Built first for the same
   * reason the bundle is: a stale binary is a test run that passed for the
   * wrong version of the server.
   */
  command:
    `npm run build:web && ` +
    `./scripts/cargo.sh build --release --manifest-path rust/Cargo.toml && ` +
    `rust/target/release/agent-commander --mock --port ${PORT}`,
  url: `http://127.0.0.1:${PORT}/`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  stdout: 'ignore',
  stderr: 'pipe',
}

export default defineConfig({
  testDir: './e2e',
  // The specs share one server, and several of them send messages into the
  // mock's echo log, so they are ordered rather than raced within a file.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A flake that only ever fails once is still worth knowing about, so the
  // retry is one and the trace is kept.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    trace: 'retain-on-failure',
    video: 'off',
  },

  projects: PROJECTS,

  webServer: MOCK_SERVER,
})
