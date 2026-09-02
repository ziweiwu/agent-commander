# Working on agent-commander

Instructions for Claude Code and any other agent working in this repository.
Read this before changing anything.

## What this is

A local web dashboard over every Claude Code and Kiro CLI session on the
machine — status, folder, what each one is doing — with a terminal you can
answer a blocked agent from, including from a phone over Tailscale.

It is an observer of somebody else's work in progress. That is the whole design
pressure: the sessions on screen are real, and this app is never allowed to
disturb one.

The fleet has **one rendering**: `FleetList`, the grouped card list. There were
two — a `ForestView` drew each session as a family on a shared time axis — and
the split cost more than it returned. Every property that had to be true of the
fleet had to be proved twice, and the forest's own question ("is anything in
this family still moving?") turned out to be answerable on the card itself, from
the same delegation trees the forest was reading. So the trees moved onto the
card: `AgentCard` rolls each agent's delegates into a line and opens them in
`DelegationTree`, and the reasoning that has to survive that move is INV-13 and
INV-15. The pure parts — what a card may claim about delegates, and the two
lengths of its activity trail — live in `src/web/lib/delegation.ts` and
`src/web/lib/trail.ts` so they can be tested without a DOM.

## Two languages, and which is which

**The server is Rust, in `rust/`. The browser app is TypeScript, in `src/web/`.**
`rust/src/types.rs` is the wire contract, and `src/shared/wire.ts` is
**generated from it** by `npm run gen:types` — types and the option lists both,
because `ALLOWED_KEYS`, `MODEL_ALIASES` and friends are what make "the server
validates against them and the browser offers exactly them" true, and a
type-only export would have left that half to drift. Edit the Rust, run the
script, commit both. `types::tests::the_checked_in_wire_contract_is_current`
fails `npm test` on a checkout where they disagree, so forgetting the second
step is a red gate rather than a browser bug. `src/shared/types.ts` is the
hand-written remainder: it re-exports `wire.ts` and adds the two union types
the browser derives from the lists. The derive is `cfg_attr(test)` and `ts-rs`
is a dev-dependency, so none of it reaches the release binary.

There is no `src/server/` any more. It was ~6,600 lines of TypeScript and it is
preserved, working, on the **`old-node-backend-branch`** branch. Reach for it
when you want to know what the old code did; do not reach for it to copy code
back.

The port is verified by three things rather than by reading:

- `rust/tests/golden/*.json` — real responses captured from the Node server on
  the mock fleet. `mock.rs`'s tests assert the Rust bytes still match them, so a
  drift in any wire field fails a unit test rather than a browser.
- The **233 Playwright tests**, unchanged. They drive HTTP and WebSocket and
  never imported the server, so they arbitrate the port without knowing it
  happened.
- `cargo test`, which carries the invariant numbers the same way the TypeScript
  did: `cargo test --manifest-path rust/Cargo.toml inv13`.

What moved and what did not: every module in `src/server/*.ts` has a
same-named `rust/src/*.rs`, except that `tmux-client.ts` gained
`tmux_source.rs`/`tmux_agents.rs` beside it, `agent-kinds.ts` became
`agent_kinds.rs` on the server side while staying TypeScript for the browser,
and `cli.ts` split into `main.rs` (entry, statusline install) and `options.rs`
(argument parsing, the port guards, INV-3's bind refusal).

## The two constraints everything else follows from

`ARCHITECTURE.md` opens with these, and says explicitly that everything else is
downstream of them.

**INV-1 — no tmux client this app creates may affect the size of a pane.** It is
why the Attach view is `capture-pane` polled, diffed and replayed into xterm.js
rather than a pty. A pty means a client, a client has a size, and under
`window-size latest` with `aggressive-resize on` a browser-shaped client reflows
the pane a working agent is drawing into. The browser's own width only ever sets
a CSS transform.

**INV-2 — nothing reaches a live agent except from an explicit user action.** No
retries, no auto-send, no replay on reconnect. It is why the client carries four
separate duplicate-suppression mechanisms rather than one, why a paste is staged
through a file instead of a command line, and why every control action is
*verified by reading the transcript back* rather than assumed to have worked.

A change that makes either of those less true is the wrong change however
convenient it looks. `ARCHITECTURE.md` §"The two constraints everything else
follows from" carries the reasoning; `INVARIANTS.md` carries the contract.

## Before you say it works

Run these. If you did not run them, say so explicitly rather than implying
success.

```sh
npm run typecheck
npm run lint
npm test              # 1014 tests: 553 Rust (the server) + 461 vitest (the web app)
npm run build         # vite bundle, then `cargo build --release`
npm run e2e           # 263 end-to-end tests, five projects: desktop/tablet/phone on
                      # Chromium, and phone/tablet again on WebKit
npm run audit         # contrast, a11y, task flows, device layouts — needs a server
npm run qa            # randomised exploration, deterministic per seed
npm run verify:inv1   # attaching never resizes a real pane — server must be running
```

`ARCHITECTURE.md` §"How it is checked" is the table to read before touching any
of them: five gates, each answering a question the others cannot, and the note
on why the last three stay local habits rather than CI gates.

`npm test` and `npm run e2e` run on every push and pull request
(`.github/workflows/ci.yml`), which installs a stable Rust toolchain (cached
with `Swatinem/rust-cache`) alongside both Chromium and WebKit. The
second engine is not redundancy: every browser on iOS is WebKit, and for this
app's first five releases every "iPhone" and "iPad" result it produced was
Chromium wearing an iPhone user-agent. `ENGINE=webkit npm run audit:mobile`
runs the device audit on WebKit too. The rest are local.

The first three also run as a `Stop` hook, so a turn that leaves the tree
failing is refused rather than summarised. The hook lives in the `harness`
plugin and reads its list from **`.claude/gates.json`** here — `watch`
pathspecs, `gates` as `[name, argv]` pairs, and a per-gate `timeout`. It skips
when nothing under `src/`, `test/`, `scripts/` or the manifests has changed, and
blocks at most once per tree state so a failure it cannot fix never traps the
session.

`build`, `e2e`, `audit:*`, `qa`, `verify:inv1` and `app` are deliberately
**not** in that list. Measured on this machine: typecheck 5.0s, lint 0.9s, test ~40s,
build 3.4s — the three that are in it already cost ~46s, and a Stop hook slow
enough to resent is one that gets deleted. The others need a browser, a running
server, or a live tmux session with a real agent in it, none of which a hook can
assume. CI and a deliberate local run own them. `app` is the same argument in a
different key: it is macOS-only, it needs a full build first, and what it guards
is a local convenience rather than anything the app does — its three cheap
checks already ride in `npm test`, and `scripts/mac-app/` is covered by the
existing `scripts/` watch entry.

`watch` entries are git pathspecs, not prefixes — git matches whole path
components, so the manifests are spelled out individually. `scripts/` is on the
list because `test/scheme.test.ts` re-runs `scripts/gen-themes.py` and fails if
`tokens.css` no longer matches its output, and because `scripts/cargo.sh` is how
every gate reaches the Rust toolchain. `rust/` is on it for the obvious reason:
it is the server.

**Anything a gate shells out to must go through `scripts/cargo.sh`, never bare
`cargo`.** `~/.cargo/bin` is put on PATH by a line in your shell profile, so it
is present in a terminal and absent in every non-interactive shell — npm
scripts, git hooks, and the Stop hook that runs these gates. Bare `cargo` in a
package script passes locally and fails with `cargo: command not found` for
everyone and everything else, which is exactly how it was first written here.

## Ports, and why there are three

| Port | What runs there |
|---|---|
| 4317 | Production. Real agents. `npm start`, `npm run serve`, the installed binary. |
| 4400 | Development. `npm run dev`, `npm run mock`, and what the audit scripts target. |
| 4500 | `qa-sweep.sh`. |

Never point a fuzzer, an audit or a review agent at 4317. It drives real
agents, and anything that types into whatever it finds will type into someone's
session. `qa-sweep.sh` refuses that port outright and `--mock` on it is rejected.

`npm run mock` serves a deliberately awkward fixture fleet — ten agents, five
sharing a home directory, one name too long for its card, two never prompted,
and one Kiro session so the degraded card an agent with no transcript gets is
on screen rather than only in a test. The delegation trees behind them are
awkward on purpose too: a depth-3 chain, a delegate the user stopped, one node
in each of INV-13's three states, an orphan whose parent is not on disk, an
agent that has delegated nothing, and a CLI that cannot say either way.
Because the mock fleet runs the same server, routes and validation as the real
one (`rust/src/sources.rs` is the seam), a failure seen in mock mode is the
failure you would get for real.

## The invariant contract

`INVARIANTS.md` numbers every property this app is built against, INV-1 through
INV-16, and each is greppable from a test name:

```sh
cargo test --manifest-path rust/Cargo.toml inv3   # the server's half
npm run test:web -- -t INV-3                     # the browser's half
```

When you add behaviour worth relying on, add a numbered invariant and a test
carrying its number. When you change behaviour, update the invariant in the same
commit.

## Things that have already bitten

- **`bin` points at a launcher, not at the server.** The server is a Rust
  binary, and `bin` has to name something node can run, so
  `scripts/launch.mjs` finds `rust/target/release/agent-commander` and execs it.
  Source edits do nothing until `npm run build:server`. The launcher fails
  loudly when the binary is missing, and that is deliberate: every global
  install from 0.1.0 shipped a CLI that produced no output, opened no port and
  reported no error, and a silent launcher would be that bug again wearing a
  different hat. The published package now carries prebuilt binaries so the
  launcher has something to find — see **Shipping it to npm** below.
- **The do-nothing install has shipped twice, and the fat package is the third
  attempt to stop it.** First the `realpathSync` bug, where a symlinked `bin`
  made the CLI decide it had been imported and never call `main()`. Then the
  port, where `files` shipped `rust/src` and no binary. Neither failed with a
  message; both installed cleanly, ran, and produced nothing. That history is
  why `launch.mjs` prints every path it tried and the host it is on before
  exiting 1, why the release publishes one package instead of a matrix that has
  a window where a platform package is missing, and why `build-mac-app.py`
  smoke-tests the staged bundle. When you change anything on the path from a
  tag to an installed binary, the question to ask is not "does it work" but
  "how would I find out if it did not".
- **A token in the URL cannot reach a subresource.** `--token` 401'd the app's
  own bundle, because `index.html`'s `<script>` and `<link>` carry neither the
  token nor a header. `GET`/`HEAD` under `/assets/` skip the token gate and
  nothing else does — so nothing under that prefix may ever serve agent state.
  The same assumption broke the address bar: the router replaces the whole
  location, so navigation has to re-attach the token.
- **The two gates are independent, and the origin one is never skipped.**
  `permitted` is `same_origin_request(headers, &self.origin_names)`. A token no
  longer exempts a request from rebinding protection — it used to, which made
  the token the credential and the exemption at once. `origin_names` is empty
  without a token, so a tokenless server answers to loopback alone; the
  Tailscale name buys nothing on its own, because `tailscale serve` hands every
  tailnet peer the same name. The token still travels in the query string and
  is still printed in full by `announce`. See `ARCHITECTURE.md` §"Where it is
  fragile" 6 and 6a before touching either gate.
- **Development used to default to 4317.** A fixture fleet on the production
  port is indistinguishable from your real one having vanished, and the composer
  on that page types into nothing.
- **`Registry.changed()` does not watch enrichment fields** (`registry.ts:320`).
  `activity`, `goal` and `model` reach the browser only because the enricher
  calls `notify()` itself. Forget that and the UI lags indefinitely with nothing
  raising an error.
- **`Registry.enrich()` is a blind shallow merge** with two callers writing
  different field sets, and `undefined` overwrites. That is load-bearing for
  goal-clear and a trap for any new patch producer.
- **`tokens` is output tokens only**, accumulated per tail from a 256 KiB
  backfill — not the session's spend, despite being presented as cost and used
  as a sort key.
- **A half-open socket kept polling for a browser that was gone.** A phone
  asleep behind Tailscale held a transcript tail and a share of a pane poller.
  Fixed by the heartbeat; the general rule is that nothing polls what nobody is
  watching.
- **Widths break in the empty state, not the full one.** A 300-character search
  term echoed verbatim into "No agent matches …" forced the document to 2175px.
  The review agents found that one, plus an xterm use-after-dispose crash on
  every full-screen toggle and a sort that ranked unknown values as smallest.
- **A control whose success cannot be observed must not claim it failed.** The
  permission-mode button was reported broken three times across two rewrites,
  and the key was never at fault: `tmux send-keys BTab` emits `\033[Z`, and
  three presses walk a live session `auto` → `plan` exactly as the keyboard
  would. Claude Code writes its `permission-mode` record at the *end of a
  turn*, so an agent at its prompt — the one usually being switched — reports
  nothing back, and one that has not taken a turn has no transcript to report
  from. Verifying it meant a 2.5s window with the button dead, then
  `unverified`, then the old mode still on the label: three signals of failure
  about something that had worked. It now sends the key and says so. Before
  building verification onto a control, check that the CLI writes anything down
  when the thing happens.

- **A control action that carries no value still goes through `readJson`.**
  Mode, clear and compact take no argument, so the browser sends no body at all
  — and `JSON.parse('')` throws. Every unit test passed while pressing the mode
  button reported *"that did not take effect: Unexpected end of JSON input"*
  about a control the server had never called. The Rust port keeps both halves
  of that lesson: `routes::inv8_mode_and_clear_and_compact_carry_no_body` drives
  the real HTTP handler with an empty body, because `control::tests` calls the
  action functions directly and structurally cannot catch this.
- **`/clear` replaces the session; it does not edit it.** Claude Code opens a
  fresh transcript under a new session id and rewrites
  `~/.claude/sessions/<pid>.json`. Anything holding the old id — a URL, a socket
  focus, a mock fixture, an e2e test — is stale the moment it lands. That is
  also why one fixture (`AGENT.clearable`) is reserved for the clear spec: every
  e2e project shares one mock server, and clearing a fixture another test uses
  deletes that test's agent out from under it.
- **`npm test` is flaky under load, and `scheme` is not the only one.**
  `test/scheme.test.ts` (a 5s timeout around spawning `python3`) fails when the
  machine is busy and passes on a quiet one. `test/ui/token.test.tsx`
  ("keeps it when opening an agent" / "…closing one again") does the same:
  measured on a clean `main` with nothing else changed, it failed 3 runs out of
  6 back-to-back and passed 8 of 8 when run on its own. Both are load, not
  regressions — but check that way round before believing either, because a red
  run that names only these is the cheapest kind of false alarm to chase.
  A red Stop hook naming only that is worth re-running before believing. The
  INV-4 tail-count flake that used to sit beside it went away with the port:
  `enrich.rs`'s cadence re-arms after the work instead of on a wall clock, so a
  slow pass no longer drops a tick.
- **The e2e `/clear` follow test flakes on slow CI runners.** `control.spec.ts`
  "INV-8 follows the agent to the session it is now running" failed both
  attempts on one GitHub runner and passed on rerun with nothing changed. One
  red occurrence of exactly that test is worth a rerun before it is believed —
  and worth root-causing if it ever fails twice in a row on different runs.
- **The Mac bundle's path constraints went from four to one, and the one that
  survived changed shape.** The Node bundle needed `dist/web` beside
  `dist/server`, `scripts/statusline-bridge.mjs` two levels up, `dist/shared` as
  a sibling, and a `package.json` carrying `"type": "module"` — without that last
  one Node read the ESM output as CommonJS and died before printing a character,
  a do-nothing binary wearing a Dock icon. Three of those were Node's and left
  with it. What remains is the web root: the launcher passes `--web-root`
  explicitly, and `Resources/web` is laid out as a sibling of `Resources/bin` so
  `default_web_root()`'s own `../web` fallback lands in the same place for
  anyone running the staged binary by hand. `--help` returns before anything is
  served, so the smoke test cannot prove this one — `build-mac-app.py` checks for
  `web/index.html` directly instead.

- **`codesign` runs before the smoke test, not after.** The launched thing is a
  Mach-O now rather than a script, and on Apple silicon an *invalid* signature is
  a kernel kill rather than a warning. Signing first means the smoke test runs
  the exact bytes the user will. It stays non-fatal, so a benign codesign failure
  does not stop a build while a lethal one cannot slip past it.

- **The bundle ships no `statusline-bridge.mjs`, deliberately.** A bridge path
  written into `~/.claude/settings.json` that points inside a `.app` breaks the
  next time the app is replaced, so `--install-statusline` belongs to the npm
  package. Run from inside the bundle it now reports that it cannot find the
  bridge script rather than writing a path that will rot.

- **A bundled app keeps serving the code it started with.** The `.app` carries
  its own copy of the binary, so reinstalling replaces the bundle and changes
  nothing about the server already running — and the launcher's own
  already-running check then finds a healthy server and just opens the browser,
  so the update lands with no effect and no message. The launcher compares the
  bundled binary's mtime against the pid file's and restarts a server it started
  itself. **Timestamps rather than versions:** a version only moves on a
  release, so rebuilding at the same one all afternoon would defeat a version
  check in exactly the case that happens most. It replaces only a server whose
  pid file it wrote *and* whose command line names this bundle, so a copy you
  started from a clone is opened, never killed.

- **`actions/upload-artifact` does not preserve the executable bit.** It zips
  what it is given, and the zip carries no mode, so a binary that left the build
  job at 0755 comes back from `download-artifact` at 0644 and `execFileSync`
  raises `EACCES`. Nothing in the release job notices — the tarball is
  well-formed, the publish succeeds, and the first person to run `npx` gets the
  failure. `npm-publish.yml` therefore `chmod 755`es each binary as it lays it
  out and then asserts the mode came back 755 before publishing. Both lines are
  load-bearing rather than defensive. This is the one entry here that has not
  bitten yet; it is on the list because its failure mode is the do-nothing
  install for the third time, and because a `chmod` with no comment on it is
  exactly the line someone tidies away.
- **`npm pack --dry-run --json` does not have a stable shape, and it broke the
  first release it was guarding.** The publish job asserted the four binaries
  were really in the tarball by parsing that JSON as an array — verified locally
  against npm 11.17, where it is one. The workflow's own `npm install -g
  npm@latest` step then handed the runner a newer npm whose output it could not
  read, so `packed[0].files` threw and the job died *inside the guard*, with the
  package itself perfectly fine. It failed safe, which is the one good thing
  about it. The guard now runs `npm pack` for real and reads the archive with
  `tar -tzvf`: the tarball is the artifact being uploaded and its format does
  not move between npm releases, and the listing carries the executable bit
  directly. **A check that parses another tool's optional output format is a
  check that can fail for reasons unrelated to what it is checking.**

- **Piping a test run through `tail` eats the verdict.** `npm run e2e | tail`
  reports tail's exit code, not Playwright's, and the failure list scrolls out
  of the kept lines — a 92-failure run once read as "141 passed" that way.
  Redirect to a file and check the exit code, never pipe a gate. Backgrounding
  one has the same shape: `cmd > log &` followed by `echo $?` reports the
  *backgrounding*, not the run. Put the `echo` inside the backgrounded shell, or
  read the verdict out of the log — a 5-failure run read as "exit 0" that way.

- **A redirect can outlive the reason for it.** Opening a blocked agent jumped
  straight to the Attach tab, on the stated grounds that it was "the only tab
  that can answer its dialog". Once the Chat tab could answer one (INV-16), that
  premise was false and the redirect was actively carrying users away from the
  better surface — but it kept working, so nothing failed. Its own comment is
  what gave it away. When you add a capability, grep for the comments that
  assert it is impossible.

- **`openAgent` waits for a first message, and not every fixture has one.**
  `e2e/helpers.ts` blocks on `getByTestId('message')`, so it can never open the
  two fixtures that were never prompted — including `mock-waiting`, which is
  exactly the one a blocked-agent test wants. That is a real shape rather than a
  quirk: an agent asks for permission on its first tool call, before it has said
  anything. Navigate directly for those.

- **A `vi.fn(() => …)` cannot be `new`-ed.** Stubbing `globalThis.WebSocket`
  with an arrow function makes `new WebSocket(url)` throw "not a constructor"
  *before* the body runs, so the mock records zero calls while the code under
  test still sees a throw — which looks exactly like the code never calling it.
  Use `vi.fn(function () { … })` for anything constructed.

## Shipping it to npm

One package carries every binary:

```
dist/bin/darwin-arm64/agent-commander
dist/bin/darwin-x64/agent-commander
dist/bin/linux-x64/agent-commander
dist/bin/linux-arm64/agent-commander
dist/web/…                              the Vite bundle, unchanged
```

`.github/workflows/npm-publish.yml` builds one binary per matrix job and a final
job collects the four, marks them executable, and publishes once. Four binaries
is ~7.5 MB, and that is the deliberate trade: the `optionalDependencies` matrix
esbuild and Biome use would ship a quarter of the bytes but has a window during a
release where the platform package a user resolves is not on the registry yet,
and what they get is an install with no server in it. This is a global CLI
installed on purpose, not a transitive dependency; the bytes are cheap and that
window is not. One package also means one trusted-publisher configuration and
nothing to reconcile when a matrix job fails.

**The directory name is exactly `${process.platform}-${process.arch}`.** Not a
convention that happens to line up — `scripts/launch.mjs` interpolates those two
values and looks there, so there is no mapping table to maintain and no way for
the launcher's names and the release job's names to drift apart. Rust's target
triples (`aarch64-apple-darwin` and friends) appear only inside the workflow,
where the translation to a directory name is written down once. Adding a target
means adding a matrix row; nothing in the resolver changes.

**Windows is deliberately not a target, and not a gap to be closed later.** The
Attach tab is `tmux capture-pane` and `send-keys`, and the fleet is read out of
`~/.claude/sessions/<pid>.json`. A Windows build would install cleanly, start,
and command nothing. Adding one is not a matrix row, it is a second
implementation of INV-1.

**`npm run build:server` still writes `rust/target/release`, and must keep doing
so.** Eight things read the binary from that path: `npm run dev`, `mock`,
`start` and `serve`; `playwright.config.ts`'s `webServer`;
`scripts/build-mac-app.py`; `scripts/dist-bin.sh`; and `launch.mjs`'s own second
candidate, which is what makes a checkout runnable without a publish ever having
happened. `dist/bin` is a layout assembled out of four separate runners' output
— not something any one machine's build produces in full. Repointing
`build:server` at it would break all eight to save one copy.

`npm run build:dist-bin` (`scripts/dist-bin.sh`) assembles that layout from
whatever the local `rust/target` happens to hold, which is how a packaging
change gets verified without a tag: build, run it, `npm pack`, read the tarball.
Note the two shapes it handles — a cross-compile lands in
`rust/target/<triple>/release` while the host's own build lands in
`rust/target/release` with no triple at all.

**Delete `dist/bin` when you are done with it.** It is the launcher's *first*
candidate, so one left behind in a checkout shadows `rust/target/release`: from
then on `npm run build:server` changes the binary the e2e harness and every
`npm run` server use, while the one `bin` runs stays whatever you assembled that
afternoon, and nothing says so. `dist/` is gitignored, so git will not remind you — and `files`
ships `dist` wholesale, which is the same trap the `.gitignore` comment on
`build/` already names.

There is no `postinstall`, nothing is downloaded at install time, and a Rust
toolchain is needed only to work on the server. Never verify by publishing a
throwaway version: npm versions are immutable, so the only way to withdraw a bad
one is to burn the next number.

`npm-publish.yml` is commented at length and those comments are the reference,
not this section. Two of them decide things you would otherwise change by
accident: the Linux legs are pinned to `ubuntu-22.04` rather than
`ubuntu-latest` because a glibc-linked binary runs on the glibc it was built
against or newer and never older, so bumping the runner raises the floor under
every user at once — on their machine, after publish, where CI cannot see it.
And `darwin-x64` is the one target nothing in CI executes, because an arm64
macOS runner has no guaranteed Rosetta; it is built and shipped unrun, and the
publish job's mode and tarball checks are what stand in for a smoke test there.

## The macOS bundle

```sh
npm run build                      # the Vite bundle, then cargo build --release
python3 scripts/build-mac-app.py   # --out defaults to build/
```

One self-contained binary in `Contents/Resources/bin` plus the Vite bundle in
`Contents/Resources/web`; `Contents/MacOS/agent-commander` is `launcher.sh`,
which probes the port, detaches the server, opens a browser and exits. It
detaches rather than `exec`s because launchd kills the job's process group —
the Node bundle used `node`'s own `spawn()` for that and there is no interpreter
left to borrow, so it forks through `/usr/bin/perl` with a logged
plain-background fallback.

`build-mac-app.py` runs the staged binary with `--help` before promoting the
bundle. That check is why the do-nothing bundles above were caught rather than
shipped, and it is worth keeping whatever else changes.

**It is not covered by any gate.** `npm test` does not touch it, no e2e test
builds it, and `.claude/gates.json` reaches it only through the `scripts/`
watch entry, which triggers the three cheap gates rather than a bundle build.
Build it by hand after changing anything it stages.

## Review agents

Point `harness:qa-bar-raiser` and `harness:ux-bar-raiser` at a `--mock` server on
4400 and never at 4317. Both review only — they never edit code — and both are told to say
"nothing found" plainly rather than pad a list. `README.md` §"Review agents"
lists what they have caught.

## The two documents worth reading in full

- **`ARCHITECTURE.md`** — the module graph, the five planes, what is pushed
  versus polled, and §"Where it is fragile", which is ordered by how quietly
  each thing fails. Trim an entry when it is fixed; the record of trimmed ones
  is §"Fixed since this list was written". §"How it is checked" is the gate
  design.
- **`INVARIANTS.md`** — INV-1 … INV-16, each with the tests that prove it.

`README.md` is for the person using the app. These two are for the person
changing it.

`TODO.md` is queued work, written to be executed cold by whoever picks it up:
what the change is, the call sites as they stood, and what "done" is checked
against. Take an item or leave it, but read it before proposing one of your own
— it also records what was considered and deliberately rejected, so a rejected
idea does not get re-proposed as a new one.

## Commits

- Explain *why*, not just what. The body is where the reasoning goes.
- **Never add a `Co-Authored-By: Claude` or any AI-attribution trailer.**
- Commit or push only when asked.
