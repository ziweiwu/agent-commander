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

### 3. Stateful property tests for INV-2's write path

INV-2 is the one invariant here whose failures are *interleavings* rather than
wrong values, and it records a real one: one shared tmux buffer name meant two
overlapping pastes ran `load(A) → load(B) → paste(into A)`, and A's agent
received B's text.

Use `proptest-state-machine` (Rust) against the real write path in
`rust/src/pane.rs`. The model is a map of pane id → the bytes that pane should
have received; the operations are overlapping pastes, queued writes to one pane,
key sends, and a failure injected *after* the write reached tmux. Assert INV-2's
four clauses: exactly once, that text, that agent, in the order typed.

**Why this and not TLA+:** a TLA+ spec proves the *spec* correct and has no link
to `pane.rs`; property tests run against the real code, ride in `npm test`, and
shrink a failure to a minimal sequence you can paste in as a regression test.
The existing `pane::tests` write-path group already covers the known cases by
example — this generalises them.

**Done when:** the harness runs in the existing suite inside the `npm test`
budget (~46s for all three gates today, so keep the case count modest), and the
historical buffer-name bug is reproducible by reverting the fix.

### 4. Kani proofs for the pure predicates

`cargo-kani` is a bounded model checker for Rust. `#[kani::proof]` lives beside
the function and verifies the actual implementation over all inputs up to a
bound — no separate artifact, so nothing to drift.

Four functions are the right shape: small, total, no I/O.

- `browse::is_inside` (`rust/src/browse.rs:65`) — the INV-9 containment check,
  including the `/abc` is-not-inside-`/a` segment case
- `routes::is_loopback_name` (`rust/src/routes.rs:367`)
- `routes::is_allowed_name` (`rust/src/routes.rs:447`)
- `routes::is_self_name` (`rust/src/routes.rs:472`)

**Honest caveat:** symbolic strings get expensive quickly, so bound path and
hostname length (32 characters is plenty to exercise every branch). This buys a
*bounded* proof, not a total one — still far stronger than examples, and it is
the INV-3 and INV-9 code, where being wrong is a security bug rather than a
cosmetic one.

**Keep it out of the Stop-hook gates.** Kani needs its own toolchain and is far
slower than the ~46s those three cost; a hook slow enough to resent is one that
gets deleted (`AGENTS.md` makes this argument about `build` and `e2e`). CI or a
deliberate local run owns it.

---

## Tier 3 — the surface that is hardest to read

### 5. The attach view: make it bigger, and make it re-fit when the window moves

**Filed as a feature request, 2026-09-02.** The Attach tab reads small on a
large display, and — the sharper half — it does not re-fit when the box it
lives in changes shape. Four separate causes: the first two are defects, the
other two are ceilings picked against a smaller screen than people now use.

Everything below is a CSS transform or an xterm font size on the *capture*.
INV-1 is untouched by all of it: `cols` and `rows` never travel back to tmux,
and nothing here may make them start. `npm run verify:inv1` is the check that
this stayed true.

**a. Nothing observes the container, so a resize is never noticed.**
`PaneTerm.rescale` (`src/web/lib/term.ts:279`) runs from exactly three places:
`mount` via `openWhenSized` (`src/web/components/Terminal.tsx:175`), a frame
whose `cols`/`rows` changed (`term.ts:239`), and `setZoom`/`setMaxScale`
(`term.ts:337`, `:343`). There is no `ResizeObserver` and no `resize` listener
in `src/web` outside `SettingsMenu.tsx:145`. So dragging the desktop window
narrower, rotating a phone, the sheet opening beside the list, the key bar
wrapping from one row onto two, or a mobile URL bar collapsing all leave the
pane at whatever scale it was given on mount. A *quiet* agent is the worst
case: no redraw means no geometry change, so nothing ever recovers it, and the
pane stays clipped or shrunken until the tab is reopened.

Fix: observe `host.parentElement` in `mount` and call `scheduleRescale()`;
disconnect in `dispose()` beside the rAF cancellation. Two traps —

- Observe the **parent**, never `host`. `rescale` writes `host.style.width` and
  `host.style.height` (`term.ts:308`), so observing the element it sizes is a
  feedback loop.
- `scheduleRescale` queues *two* rAFs per call (`term.ts:260`) and tracks every
  handle for `dispose`. A resize drag would push hundreds. Coalesce: keep one
  pending schedule at a time.

**b. The height budget counts the key bar as if it were pane.** `rescale` reads
`host.parentElement.clientHeight` (`term.ts:295`), but `.host` holds the capture
*and* the key bar — and, for a pane that has ended, the notice and the caption
above it too (`Terminal.tsx:400-418`). The height fit is therefore computed
against more room than the capture actually gets, so at `PANEL_MAX_SCALE = 2`
an enlarged pane can push the Enter / Esc / Ctrl-C row out of the panel — read
from the code rather than observed, so reproduce it before fixing it. That row
is how a phone answers a blocked agent, so this is the one item here with a
consequence beyond legibility. Fix: measure what the capture may have —
subtract the siblings, or give `.wrap` a bounded flex parent and measure that
instead.

**c. Enlarging upscales a 13px canvas rather than re-rendering.** `BASE_FONT` is
13 (`term.ts:13`) and growth is a `scale()` transform, which is why `PaneTerm`
carries `scaled` at all and why its comment says enlarged text is "slightly
soft". Raising xterm's own `fontSize` for the *enlarge* direction is INV-1-safe
and gives crisp glyphs at any size. Keep shrinking as a transform: below
`MIN_EFFECTIVE_FONT` nothing is readable however it is rendered, and the
`readable`/`fit` split depends on scale being continuous. Watch: changing
`fontSize` changes the cell metrics, so every measurement in `rescale` must
re-run after xterm has laid out again — the existing double-rAF exists for
exactly this reason, and a font change needs the same treatment.

**d. The ceilings are guesses.** `FULLSCREEN_MAX_SCALE = 2.5` and
`PANEL_MAX_SCALE = 2` (`Terminal.tsx:14`, `:25`) were picked against 80- and
150-column captures on this machine. An 80-column pane full screen on a 4K
display still leaves most of the screen empty at 2.5. If (c) lands, express the
ceiling as a target effective font size rather than a multiplier — that is the
thing the reader actually cares about, and it stops the number needing a new
guess per display.

**While you are in the file:** `.wrap` declares `max-width: 100%` twice
(`Terminal.module.css:20` and `:26`).

**Done when:**

- `test/term-scale.test.ts` gains cases for the corrected height budget — a
  container whose height is shared with a key bar must not yield a scale that
  needs all of it.
- A test proves a container resize rescales with no new frame. `test/ui/setup.ts`
  stubs `clientHeight` to 0 for every element and jsdom has no `ResizeObserver`,
  so this needs both stubbed; a `PaneTerm` unit test is likely cheaper than a
  component one.
- `e2e/attach.spec.ts` resizes the viewport and asserts the transform on
  `term-scale` changed.
- `npm test`, `npm run e2e` and `npm run audit` pass, and `npm run verify:inv1`
  still passes against a real pane.

---

## Not doing

**TLA+ for the invariant set.** Evaluated and rejected. Of the 16, one (INV-2)
is genuinely protocol-shaped; four are epistemic and unmodellable; two are claims
about *tmux's* behaviour that no model can check and that `npm run verify:inv1`
already checks empirically against tmux's own report; six are straight-line
predicates that item 4 covers better; one is about cost. A spec would be a third
artifact to keep in sync, it would prove nothing about the Rust, and it is a
format agents write poorly — against a document whose whole value is that it is
greppable and readable by an agent with no memory of the bugs it records.
