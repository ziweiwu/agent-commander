# Contributing

Thanks for working on agent-commander. This page is the short route from a
clone to a pull request. The reasoning behind most of it is in
[ARCHITECTURE.md](ARCHITECTURE.md) and [docs/HANDBOOK.md](docs/HANDBOOK.md);
the rules the app is held to are in [INVARIANTS.md](INVARIANTS.md).

## Prerequisites

- Node 20 or newer (`engines` in `package.json`; CI runs 20 and 22).
- A stable Rust toolchain. Every script reaches it through `scripts/cargo.sh`,
  so `~/.cargo/bin` need not be on the PATH of a non-interactive shell.
- `tmux`, which the New Agent flow and the end-to-end suite need.
- Python 3, for `scripts/gen-themes.py`, `scripts/audit-contrast.py` and the
  macOS bundle builder.
- For the end-to-end suite: `npx playwright install --with-deps chromium webkit`.

```sh
git clone https://github.com/ziweiwu/agent-commander.git
cd agent-commander
npm install
npm run mock        # a fixture fleet on http://127.0.0.1:4400, touching nothing real
```

## Where things live

The app is two languages, and which is which matters.

- **`rust/`** is the server. `rust/src/types.rs` is the wire contract.
- **`src/web/`** is the browser app: React, Vite, CSS modules.
- **`src/shared/wire.ts`** is *generated* from the Rust types by
  `npm run gen:types`. Edit the Rust, run the script, commit both. A checkout
  where they disagree fails `npm test`.
- **`src/shared/types.ts`** is the hand-written remainder around `wire.ts`.
- `test/` is vitest (the browser app), `e2e/` is Playwright, and the server's
  tests sit beside its modules in `rust/src/`.

## The gates

Run these before opening a pull request. The first five run in CI on every
push and pull request; the rest need a browser, a running server, or a real
tmux session, so they stay local.

```sh
npm run typecheck
npm run lint          # oxlint, then clippy with warnings as errors
npm test              # vitest, then cargo test
npm run build         # the Vite bundle, then cargo build --release
npm run e2e           # five projects: desktop/tablet/phone on Chromium,
                      # phone/tablet again on WebKit

npm run audit         # contrast, a11y, task flows, device layouts — needs npm run mock on 4400
npm run qa            # randomised exploration, deterministic per seed
npm run verify:inv1   # attaching never resizes a real pane — needs a live tmux session
```

Say which of these you ran in the pull request. If you did not run one, say so
rather than implying it passed.

## Ports

Never point a test, a fuzzer or an audit at **4317**. That is the production
port and it drives real agents; anything that types into what it finds there
types into somebody's session. The server refuses `--mock` on it.

| Port | What runs there |
|---|---|
| 4317 | Production. Real agents. `npm start`, `npm run serve`, the installed binary. |
| 4400 | Development. `npm run dev`, `npm run mock`, and what the audit scripts target. |
| 4500 | `npm run qa`. |
| 4599 / 4598 | The end-to-end suite's two mock servers: the fixture fleet and `--mock-empty`. |

`npm run mock` serves a deliberately awkward fleet: fourteen agents, one of
each blocked shape, a dead pane, a family of quiet delegates, a name too long
for its card. `agent-commander --mock-empty --port 4400` serves the same server
with no agents, for the first-run screen. Both run the real routes and the real
validation, so a failure seen in mock mode is the failure you would get for
real.

## The invariant contract

`INVARIANTS.md` numbers every property this app is built against, and each is
greppable from a test name on both sides of the wire:

```sh
cargo test --manifest-path rust/Cargo.toml inv3   # the server
npm run test:web -- -t INV-3                      # the browser
```

When you add behaviour worth relying on, add a numbered invariant and a test
carrying its number. When you change behaviour, update the invariant in the
same commit. `SPEC.md` is the fuller description of what the app should do;
where the two disagree, the invariant wins.

Two invariants shape almost everything else, and a change that makes either
less true is the wrong change however convenient it looks:

- **INV-1** — no tmux client this app creates may affect the size of a pane.
- **INV-2** — nothing reaches a live agent except from an explicit user action.

## Commits and pull requests

- One change per commit, and explain **why** in the body, not only what.
- No AI-attribution trailers.
- Do not commit secrets, `.env` files, or credentials.
- Never force-push a shared branch.

A pull request should say what changed and why, which gates you ran, and which
invariant or spec requirement it touches. If it changes the wire contract,
include the regenerated `src/shared/wire.ts`. If it changes what the app looks
like on a phone, say which viewport you checked it on.

## Reviewing a running app

Two review agents are documented in
[docs/HANDBOOK.md](docs/HANDBOOK.md#review-agents): `harness:ux-bar-raiser`
for UX and accessibility and `harness:qa-bar-raiser` for breaking things.
Point them at a `--mock` server on 4400, never at 4317. Both review only; they
never edit code.

## Releasing

Maintainers release by tag: `npm version patch` (or `minor` / `major`) and
`git push --follow-tags`. The publish workflow refuses a tag that disagrees
with `package.json`, builds one binary per platform, and publishes once. The
details are in [docs/HANDBOOK.md](docs/HANDBOOK.md#releasing).
