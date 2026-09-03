# Queued work

Picked up by whoever is next, in any order — these are independent.

Each entry is written to be executable cold: what the change is, why it is worth
doing *here* rather than in general, the exact call sites as they stood when it
was written, and what "done" is checked against. Read `AGENTS.md` first; the
gates named below are the ones it lists.

**Where these came from.** A review of `INVARIANTS.md` asked whether 16 numbered
properties were better served by a formal specification language. The conclusion
was that they are five different kinds of claim and no one language covers them
— and that the four invariants with the most leverage (INV-11, 13, 14, 15, the
"never assert more than you know" family) are not formally modellable at all and
should stay prose. What *is* worth mechanising is below, ordered by how much it
removes rather than how much it adds. **Two of these delete an invariant instead
of watching it, which is why they are first: an invariant that no longer exists
cannot rot, and INV-10 has already demonstrated what rot looks like here.**

---

## Tier 1 — remove the invariant rather than test it

### 1. Make illegal states unrepresentable, starting with INV-9

Turn runtime-checked properties into ones the compiler enforces. This is the
only technique here that costs nothing at runtime and cannot drift, and Rust is
already the language of the half that needs it.

Three candidates, smallest first. **INV-9 is done** — `browse::WithinRoot` is
constructible only by `resolve_inside_root`, the parent computation lost its
second containment check and the label lost its outside-the-root form, and
INV-9 in `INVARIANTS.md` now describes the type. The two below remain.

- **INV-6 — destructive keys need confirmation.** The `confirmed` flag on the
  `key` message is a `bool` checked at the boundary. A `Confirmed<Key>` that can
  only be built by the checking function moves the rule from "every call site
  remembers" to "no call site can forget". Note INV-6's own history: this was a
  browser-only obligation once, and the file calls that the one claim in it that
  was not true — a type would have made that state unwritable.
- **INV-2 — a write picks its path before a byte is sent and never changes its
  mind.** That sentence describes a typestate machine. The control-client path
  and the spawned-tmux path are currently a runtime choice that a later `?` could
  in principle re-take; encoded as types, retrying down the other path stops
  compiling.

**Done when:** `npm run lint` and `npm test` pass, and a runtime check is gone
because it is now unrepresentable rather than merely unobserved. Update the
invariant in `INVARIANTS.md` in the same commit.

### 2. Generate the wire contract instead of mirroring it — done

`src/shared/wire.ts` is rendered from `rust/src/types.rs` by `npm run gen:types`
(ts-rs, `cfg_attr(test)`, dev-dependency only), values included, and
`types::tests::the_checked_in_wire_contract_is_current` fails `npm test` on a
stale checkout. `src/shared/types.ts` re-exports it and adds `ModelAlias` and
`PermissionMode`. The remaining hand-held pair is `agent-kinds`, which
`ARCHITECTURE.md` §"What moved" now names as such.

---

## Tier 2 — model the thing that is genuinely a protocol

### 3. Stateful property tests for INV-2's write path — done

`rust/src/pane_props.rs`, `cfg(test)` only: `proptest-state-machine` over the
real `Panes` with a tmux in miniature whose single buffer table is reachable
down both paths. 96 cases of up to 10 steps run in well under a second, so it
rides in `npm test`; reverting the per-paste buffer name fails it on the
historical two-pane overlap, shrunk to exactly that. `INVARIANTS.md` INV-2
lists it.

### 4. Kani proofs for the pure predicates — attempted 2026-09-02, deferred

Tried, measured, and taken back out. `cargo-kani` 0.67 (`cargo install
--locked kani-verifier && cargo kani setup`, ~10 minutes) was pointed at five
`#[kani::proof]` harnesses: `is_inside` reflexive and the `/a`-vs-`/ab`
sibling case, `is_loopback_name` against an independently written byte
automaton for the regex it replaced, `is_self_name(h, &[])` equal to
`is_loopback_name(h)`, and `is_allowed_name` matching whole. Symbolic
`&str`s built from `kani::any::<u8>()` over a small alphabet, `str::from_utf8`,
`--default-unwind 18`.

**Cost, on an M-series Mac:** at 15-byte hostnames and 4-byte paths, five
harnesses in parallel (`-j`) had not finished *one* after 3h 30m. A single
harness alone, `is_allowed_name` at a 6-byte bound with `--default-unwind 9`,
generated 225,393 verification conditions (138,224 after simplification) and
was still in the SAT solver at 15 minutes. The expense is not the predicates,
it is the std code under them — `Path::components`, `str::split`, UTF-8
validation — each unrolled symbolically per byte. A run that takes hours is
not a habit, and it is nothing a Stop hook could hold.

**If it is picked up again**, two things would change the arithmetic: prove
byte-level re-implementations that the real functions are then tested equal
to on examples (cheap, but it is no longer a proof of the shipped code), or
model the inputs as component lists rather than strings so `Path` never runs
symbolically. Neither is obviously worth it against `browse::inv9_*` and
`routes::tests`, which already pin every branch by example. The harness text
is in this session's history if wanted; nothing of it is in the tree.

## Tier 3 — the surface that is hardest to read

### 5. The attach view: make it bigger, and make it re-fit when the window moves — done

All four causes addressed. `PaneTerm.mount` observes the terminal root's
*parent* — the detail panel's pane or the full-screen body, both bounded by the
layout — and coalesces a resize drag into one measurement at a time. The
height budget is that box less everything else in it (`heightBudget` in
`term.ts`: padding, the key bar, a dead pane's notice and caption), so an
enlarged pane can no longer push the Enter / Esc / Ctrl-C row out of the panel.
Enlarging re-renders xterm at a bigger whole-pixel font with a residual
transform, so glyphs stay crisp; shrinking stays a transform. The ceilings are
font sizes (`FULLSCREEN_MAX_FONT` 32px, `PANEL_MAX_FONT` 26px) rather than
multipliers. Tests: `test/term-scale.test.ts` (the budget),
`test/ui/term-resize.test.tsx` (resize without a frame, coalescing, disconnect,
font-based enlarge), `e2e/attach.spec.ts` "re-fits the capture when the window
changes shape". `npm run verify:inv1` is the check that `cols`/`rows` still
never travel back to tmux; run it against a real pane before a release.

## Tier 4 — fixtures the QA pass could not reach

### 6. Two blocked shapes and a dead pane, in the mock fleet

**Filed from the 0.9.0 QA pass, 2026-09-02.** `rust/src/mock.rs` has one
blocked fixture, `mock-waiting`, and it is an `AskUserQuestion` with labelled
options. INV-16 describes two more shapes — `ExitPlanMode` (a plan, no options)
and a tool permission request (tool and input, no options) — and the
`AnswerCard` states for them (`answerNoOptions`, the key-only picker) exist as
UI that no fixture can put on screen. Likewise no fixture ever reports
`pane-exited`, so `usePaneExited`, the notice-and-caption layout and
`useRefitAfterExit` in `Terminal.tsx` are covered by unit tests only.

Add three fixtures: one blocked on `ExitPlanMode`, one on a `Bash` permission
request, and one whose pane has exited (the server sends `{type:'error',
kind:'pane-exited'}` for it on attach). Give each an entry in
`e2e/helpers.ts`'s `AGENT` map and a golden response if it changes
`rust/tests/golden/agents.json`.

**Done when:** `npm run mock` shows all three, the QA agents can drive them,
and an e2e test each exercises the no-options card and the dead-pane notice.

## Not doing

**TLA+ for the invariant set.** Evaluated and rejected. Of the 16, one (INV-2)
is genuinely protocol-shaped; four are epistemic and unmodellable; two are claims
about *tmux's* behaviour that no model can check and that `npm run verify:inv1`
already checks empirically against tmux's own report; six are straight-line
predicates that item 4 covers better; one is about cost. A spec would be a third
artifact to keep in sync, it would prove nothing about the Rust, and it is a
format agents write poorly — against a document whose whole value is that it is
greppable and readable by an agent with no memory of the bugs it records.
