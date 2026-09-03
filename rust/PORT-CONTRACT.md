# Rust backend port — the contract every module builds against

The Node backend on `main` is the specification. This branch replaces it. The
existing React client and the 233-test Playwright suite are unchanged and are
the acceptance test: **if the wire bytes differ, the port is wrong.**

## Non-negotiable conventions

1. **Wire shape is camelCase and omits absent fields.**
   Every struct that crosses the wire carries `#[serde(rename_all = "camelCase")]`
   and every `Option` field carries `#[serde(skip_serializing_if = "Option::is_none")]`.
   A `"waitingFor": null` reads as present-and-empty to the TS client, which
   checks `!== undefined` in several places. This is already true in `types.rs`
   — do not regress it.

2. **`types.rs` and `agent_kinds.rs` are frozen.** They are the shared contract.
   If you believe one is wrong, say so in your report; do not edit it.

3. **`Agent::agent_kind` must be set explicitly at every construction site.**
   `Agent` derives `Default`, so a forgotten field yields `""`, and `""` reaches
   a capability lookup that quietly denies everything — no chat tab, no slash
   commands, no explanation. Claude sessions get `CLAUDE_KIND`; tmux-discovered
   ones get the matched spec's `id`. A test that asserts no agent reaches the
   wire with an empty `agent_kind` is worth writing.

4. **Errors degrade, they do not propagate to the user as 500s (INV-5).**
   A failed tmux probe means "unknown", not a broken page.

5. **Tests live in `#[cfg(test)] mod tests` beside the code**, as the parked port
   already does. Name the invariant in the test name where one applies:
   `fn inv13_quiet_is_never_drawn_as_done()`. `INVARIANTS.md` in the repo root is
   the authority — read the section for any invariant you touch.

## The invariants that constrain this code

Read `INVARIANTS.md` for the full text. The ones that bite in the backend:

- **INV-1 — no tmux client this app creates may affect the size of a pane.** This
  is why panes are read with `capture-pane`, polled and diffed, and never with a
  pty. Any code that attaches a client, or passes a width/height to tmux, is
  wrong. The browser's width only ever sets a CSS transform.
- **INV-2 — nothing reaches a live agent except from an explicit user action.**
  No retries, no auto-send, no replay on reconnect. Pastes stage through a file,
  never a command line.
- **INV-4 — bounded polling cost.** One poller per pane for the whole server, not
  one per tab; nothing polls what nobody is watching; no transcript tail for a
  CLI with no transcripts.
- **INV-5 — degrade, don't error.**
- **INV-6 — destructive keys (`C-c`, `C-d`, `Escape`) are refused without an
  explicit `confirmed`.** A server-side boundary, not a UI convention.
- **INV-8 — control actions are guarded and verified.** Each refuses a busy agent
  *except* mode, which sends `BTab` (a control key, not typed text) and so stays
  available mid-run. Every action is verified by reading the transcript back.
- **INV-11 — never assert more than is known.** `statusInferred` and
  `stateInferred` exist for this; `unknown` is a real answer.
- **INV-13 — a delegation tree claims only what the sidecars say.** Three states:
  `active` (inferred), `quiet` (no evidence either way), `done` (evidence only).
  `quiet` is never drawn as `done`.

## Module ownership for this wave

Edit only the files you own. The tree will not fully compile until integration;
run `cargo check` and ignore errors whose `-->` points outside your files.

| Agent | Owns | Ports from |
|---|---|---|
| tmux | `tmux_client.rs`, `tmux_source.rs`, `tmux_agents.rs` | `src/server/tmux-{client,source,agents}.ts` |
| pane | `pane.rs`, `pane_hub.rs`, `poll.rs`, `frames.rs` | `src/server/{pane,pane-hub,poll,frames}.ts` |
| tree | `subagents.rs`, `transcript.rs`, `enrich.rs` | `src/server/{subagents,transcript,enrich}.ts` |
| control | `control.rs`, `registry.rs`, `pending.rs`, `spawn.rs`, `options.rs`, `limits.rs` | same names in `src/server/` |

`routes.rs`, `main.rs`, `mock.rs`, `sources.rs` are integrated afterwards and are
owned by nobody in this wave.

## Cross-module API (pin these signatures)

```rust
// tmux_agents.rs
pub const BUSY_MS: i64 = 8_000;
pub fn started_at_of(session: &str) -> i64;
pub fn kind_of(row: &PaneFacts) -> Option<&'static AgentKindSpec>;
pub fn is_live_agent(row: &PaneFacts) -> bool;
pub fn infer_status(row: &PaneFacts, now: i64) -> AgentStatus;
pub fn to_tmux_agent(row: &PaneFacts, spec: &AgentKindSpec, now: i64) -> Agent;
pub fn agents_from_panes(rows: &[PaneFacts], now: i64) -> Vec<Agent>;

// tmux_source.rs
pub struct TmuxProvider;                     // discovers agents from tmux
pub trait AgentProvider { fn list(&self) -> Vec<Agent>; }
pub struct CompositeSource;                  // merges providers, Claude wins on id

// pane.rs — PaneFacts is the row tmux_agents consumes.
// CORRECTED: the first version of this snippet was written by hand and was
// wrong — it invented a `title` field the TS has never had and omitted three
// that `to_tmux_agent`/`infer_status` require. This matches `pane.ts`.
pub struct PaneFacts {
    pub pane_id: String, pub session: String, pub pid: i64,
    pub command: String,
    /// Epoch SECONDS, not millis; 0 means tmux said nothing.
    pub activity_at: i64,
    /// > 1 forces `infer_status` to answer `unknown` (INV-11).
    pub window_panes: i64,
    pub dead: bool, pub cwd: String,
}
pub async fn fleet_facts() -> Result<Vec<PaneFacts>, PaneError>;

// subagents.rs
pub fn forget_sidecars();
pub async fn read_tree(agent: &Agent, now: i64) -> AgentTree;
```

## The oracle

`rust/tests/golden/{agents,env,tree,dirs}.json` were captured from the live Node
server running `--mock` on port 4400 at the tip of `main`. They are sorted-key
pretty-printed JSON. To regenerate:

```sh
npx tsx src/server/cli.ts --mock --port 4400 &
curl -s http://127.0.0.1:4400/api/agents | python3 -m json.tool --sort-keys
```

Never point anything at **port 4317** — that is production and drives real
agents. 4400 is mock, 4500 is qa-sweep.

The mock fleet is deliberately awkward and the port must reproduce it exactly:
ten agents, five sharing a home directory, one name too long for its card, two
never prompted, one Kiro session (so the degraded card is on screen), and a
delegation forest containing a depth-3 chain, a delegate the user stopped, one
node in each of INV-13's three states, an orphan whose parent is not on disk, an
agent that has delegated nothing, and a CLI that cannot say either way.
