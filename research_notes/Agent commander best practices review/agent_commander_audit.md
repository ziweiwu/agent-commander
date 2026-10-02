# agent-commander: repository audit (code, docs, configuration, history)

Baseline: everything below was measured at commit `a69ffe58bc269d02d236aa4c9e2583920ffa0070` (tag `v0.17.1`, 2026-09-26). That commit is `origin/main`, and the checked-out branch `claude/new-session-3wcie4` is identical to it. The local clone is shallow (60 of 103 commits), so whole-history figures come from the read-only GitHub REST API. Nothing was installed, no server was started, and no test suite was run: every test count is a static grep count, and every "measured" figure comes from `wc`, `grep` or `find` at that commit. Permalinks use the base `https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/`.

## 1. Feature inventory: what the user can see and do

### Takeaway
It covers a lot for a single-machine supervisor. It has:
- a grouped fleet list with a shape-coded status rail;
- a chat timeline with "answer cards" for blocked agents;
- a tmux `capture-pane` terminal view;
- buttons to start agents and plain terminals;
- control actions (`/clear`, `/compact`, `/model`, `/goal`, Shift+Tab, close, prune);
- browser and ntfy/Telegram push notifications;
- delegation trees;
- quota, context and cost read through a statusLine bridge;
- a sandboxed folder browser, picture upload, two languages, 16 generated palettes, a PWA manifest and a macOS launcher.

Every action is delivered by typing into the agent's tmux pane. An agent that is not running inside tmux is therefore read-only.

### Cited Findings
- **Fleet list.** Agents are grouped "Needs you → Working → Idle". Each card shows the folder, branch, current activity and delegates. A "status rail" glyph column shows a raised hand (waiting), a turning arc (working), a ring (idle) and a struck ring (pane gone). Whether the app can still reach the pane is a separate mark — [README.md L16-22](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L16-L22); [src/web/lib/status.ts](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/lib/status.ts); [INVARIANTS.md INV-11 L1104+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1104)
- **Sorting, filters and keyboard.** Sort keys are recent activity, token spend, running time and name. Sorting happens inside each status group, never across groups. The filter, sort key and direction persist in `localStorage`; the search box deliberately does not. Keyboard: `/` filters, `↑` `↓` move, `Enter` opens, `Esc` closes — [docs/HANDBOOK.md L375-407](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/docs/HANDBOOK.md#L375-L407); [README.md L127](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L127)
- **Chat tab.** It shows the transcript timeline and renders tables and links. Links are restricted to http/https by two checks (a regex plus `new URL`) and open with `noopener noreferrer` — [README.md L115-119](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L115-L119); [INVARIANTS.md INV-18 L2423+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L2423)
- **Answer cards.** Labelled buttons come from the transcript's `AskUserQuestion` payload. A multi-select press ticks a row rather than committing, and a multi-question set is walked by reading the pane. `ExitPlanMode` and tool-permission prompts get "drawn" choices from a hard-coded table, captioned as drawn and shown above a live pane capture. When an agent waits on a dialog it never wrote down (a trust prompt, a model picker), the card shows the pane and raw keys only — [README.md L23-28](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L23-L28); [INVARIANTS.md INV-16 L1820+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1820); [rust/src/transcript.rs L556-579](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/transcript.rs#L556-L579)
- **Attach tab.** A polled and diffed `capture-pane` is replayed into xterm.js and never resizes the pane. "Earlier output" pages back through scrollback (200 lines per page, at most 2,000 above the top). A paste line offers **Send** (stage at the prompt) and **Run** (stage and submit) — [README.md L29-36](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L29-L36); [rust/src/pane.rs L243-244](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/pane.rs#L243-L244)
- **Plain terminals.** "+ New agent" also offers a Terminal: a tmux session running the user's shell, tagged with the tmux option `@agent_commander terminal`. Claude-only controls are hidden and refused for it — [README.md L37-40](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L37-L40); [rust/src/spawn.rs L236-246](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/spawn.rs#L236-L246)
- **What a busy agent is running.** One `ps -axo pid=,ppid=,etime=,command=` per enrichment pass finds the tool process under a busy agent — [README.md L41-43](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L41-L43); [rust/src/procs.rs L70](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/procs.rs#L70)
- **Control actions** (HTTP `POST /api/agents/<id>/{close,clear,compact,mode,model,goal}`):
  - `/model <alias>` is permitted even while the agent is busy, reported as "queued";
  - Shift+Tab sends exactly one `BTab` and deliberately reports no resulting mode;
  - `/goal` is verified by reading back the `goal_status` record;
  - `/compact` is unverified by design;
  - `/clear` is verified by watching the session id rotate;
  - close sends `/exit`, then kills the tmux session after a grace period;
  - typing actions are refused while the agent is `busy`.

  Sources: [rust/src/routes.rs L964-975](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L964-L975); [INVARIANTS.md INV-8 L816+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L816)
- **Picture upload.** `POST /api/agents/<id>/picture` sniffs the format (PNG, JPEG, GIF or WebP), caps size at 10 MB and writes to `~/.claude/agent-commander/pictures/<session_id>/`. The returned path is appended to the draft and not sent — [TODO.md L433-465](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L433-L465); [rust/src/pictures.rs L33](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/pictures.rs#L33)
- **Notifications.**
  - In the browser: a `Notification` fires only for a transition the page watched happen, and is off by default behind a bell toggle.
  - From the server: `--notify https://ntfy.sh/<topic>` or `--notify telegram:<chat_id>`, with `--notify-link` for a deep link.
  - A push is suppressed while any tab reports itself visible, and a failed push is not retried. Answering from the lock screen is deliberately unsupported.

  Sources: [README.md L97-111](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L97-L111); [rust/src/push.rs L1-29](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L1-L29); [INVARIANTS.md INV-14 L1683+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1683)
- **Delegation.** Each card rolls subagent sidecars up into a line that opens a `DelegationTree`. Node states are `done` (only on `stoppedByUser`), `active` (inferred) and `quiet`, plus a tool-call count and time span per node. A family where everything has gone quiet gets a "still working?" question (INV-15). `/api/tree` is polled every 3 s with ETag/304 — [AGENTS.md L15-25](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L15-L25); [INVARIANTS.md INV-13 L1506+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1506), [INV-15 L1768+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1768)
- **Usage.** Topbar meters show the 5-hour and 7-day quota windows. Each card carries the CLI's own context percentage and cost estimate, from `scripts/statusline-bridge.mjs`, which `--install-statusline` adds to `~/.claude/settings.json` — [docs/HANDBOOK.md L299-330](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/docs/HANDBOOK.md#L299-L330)
- **Folder browser** for spawning, confined to the home directory or `--browse-root`. Paths are resolved with `realpath` first and checked by path segment; containment is enforced as a type (`browse::WithinRoot`) — [INVARIANTS.md INV-9 L1040+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1040)
- **Prune.** Bulk-closes sessions that show no activity, tokens or title, after a `window.confirm` naming them, one at a time through the normal close path — [src/web/components/FleetList.tsx L79-109](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/components/FleetList.tsx#L79-L109); [SPEC.md FR-PRUNE L662-676](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/SPEC.md#L662-L676)
- **Appearance.** Eight colour schemes in light and dark (16 generated palettes, contrast-audited) and two UI languages, English and Simplified Chinese (`src/web/lib/i18n.ts` is 948 lines) — [README.md L52-53](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L52-L53); [TODO.md §9 L194-252](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L194-L252)
- **PWA.** It consists of a web manifest and two icons only. No service worker exists (a grep for `navigator.serviceWorker` in `src/web` matches nothing), so there is no offline mode and no Web Push — [src/web/index.html L20-21](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/index.html#L20-L21)
- **macOS launcher app.** Built by `scripts/build-mac-app.py`. `scripts/mac-app/launcher.sh` uses `osascript`, `/usr/bin/open`, a `/usr/bin/perl` fork and BSD `stat -f` — [AGENTS.md L734-757](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L734-L757); [scripts/mac-app/launcher.sh L67-82](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/scripts/mac-app/launcher.sh#L67-L82)
- **HTTP surface.**
  - `GET`: `/api/agents`, `/api/env`, `/api/tree`, `/api/dirs`
  - `POST`: `/api/agents` (spawn agent), `/api/terminals` (spawn terminal), `/api/agents/<id>/{close,clear,compact,mode,model,goal,picture}`
  - WebSocket upgrade on `/ws`; everything else is the SPA shell

  Source: [rust/src/routes.rs L913-962](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L913-L962)
- **WebSocket messages.** Client to server: `focus`, `attach`, `paste`, `key`, `answer`, `history`, `ping`, `pong`. Server to client: `fleet`, `limits`, `timeline`, `frame`, `history`, `pasteAck`, `error` (typed kinds), `ping`, `pong`, `paneExited`, `historyFailed` — [rust/src/types.rs L618-760](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/types.rs#L618-L760)
- **CLI flags.** `--port`, `--host`, `--token`, `--rotate-token`, `--grant`, `--print-url`, `--notify`, `--notify-link`, `--mock`, `--mock-transitions`, `--mock-empty`, `--browse-root`, `--install-statusline`, `--web-root`, `-V`, `-h` — [rust/src/options.rs L522-556](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/options.rs#L522-L556)

### Inferences
- The product's core loop is "notice a blocked agent, answer it from a phone". The capability model is "can the pane be reached", because there is no API channel to the agent at all: everything is a keystroke into the TUI.
- Agents not started inside tmux lose every write path. The README admits this and asks users to start every agent in tmux ([README.md L66-80](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L66-L80)).

### Gaps
- The app was not run, so UI behaviour is taken from code and docs, not observed.

## 2. How it observes sessions, and how exposed it is to Claude Code format changes

### Takeaway
Observation rests almost entirely on Claude Code internals that the code itself describes as undocumented:
- the session files in `~/.claude/sessions/<pid>.json`;
- the transcript JSONL record shapes;
- the subagent sidecar files;
- the output of `claude agents --json`;
- scraping the TUI's rendering in the pane, and typing slash commands into it.

The one documented interface it consumes is the statusLine stdin JSON. Claude Code hooks, OpenTelemetry and the Agent SDK appear nowhere in the code or docs.

Parsing degrades field by field, but the code has single points of failure. The INV-5 promise that agents "still list from `claude agents --json`" when the session file changes shape is **not implemented**: that command only filters out stale entries.

### Cited Findings
- **Registry cadence.** The registry reads `~/.claude/sessions/<pid>.json` every 2 s (`TICK`). It runs `claude agents --json` (about 680 ms, 15 s timeout) every 30 s (`RECONCILE`) as a presence check — [rust/src/registry.rs L1-16, L33-42](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L1-L42)
- **Session-file fields read.** `sessionId`, `pid` and `cwd` are required (a record missing any of them is dropped). Also read: `name`, `nameSource` (`"derived"`), `status` (`busy`, `idle` or `waiting`, anything else becomes `unknown`), `waitingFor`, `kind`, `startedAt`, `version`, and `tmux`. The `tmux` value looks like `claude-1786666491:@65.%77`, and the pane id must match `%` plus digits — [rust/src/registry.rs L108-147, L188-229](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L108-L229)
- **The code itself calls the session file "an internal Claude Code format".** For that reason it parses it as an untyped `serde_json::Value` rather than a strict struct — [rust/src/registry.rs L15-16, L188-194](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L188-L194)
- **`claude agents --json` only contributes a set of `sessionId`s.** That set is used to drop "ghosts" (sessions whose pid was reused). Fleet entries are built only from session files, and an id the CLI has not confirmed is skipped — [rust/src/registry.rs L293-307](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L293-L307), [L492-525](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L492-L525), [L582-587](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L582-L587). This contradicts INV-5, which says: "If it changes shape, agents must still list from `claude agents --json` — they simply lose the Attach tab" — [INVARIANTS.md L625-626](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L625-L626)
- **The project's own risk register says status is "trusted wholesale from Claude Code's session file"**, calling this "the largest [dependency] in the system" with "no independent corroboration" — [ARCHITECTURE.md L629-636](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L629-L636)
- **Transcript JSONL fields parsed** (production part of `transcript.rs`, by grep):
  - record types `user`, `assistant`, `system`, `summary`, plus `tool_use` and `tool_result`;
  - `ai-title`, `permission-mode`, `compact_boundary` (with `compactMetadata.preTokens`, `postTokens` and `trigger`), `goal_status`;
  - `isSidechain`, `isMeta`, `origin.kind == "human"`, `promptSource`, `gitBranch`, `usage.output_tokens`, `model`;
  - tool inputs: `AskUserQuestion` (`questions`, `options`, `label`, `description`, `multiSelect`, `header`, `preview`), `ExitPlanMode` (`plan`), and Bash (`command`, `description`, `dangerouslyDisableSandbox`).

  Sources: [rust/src/transcript.rs](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/transcript.rs); [INVARIANTS.md INV-11, INV-16](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1820)
- **Subagent sidecars.** The app reads `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.meta.json`, with fields `agentType`, `description`, `toolUseId`, `parentAgentId`, `spawnDepth`, `isFork` and `stoppedByUser`, and caches each file for the life of the process. ARCHITECTURE.md lists this as fragile item #1: an "undocumented internal format" that "degrades *silently*", where an empty tree looks identical to "no delegates" — [ARCHITECTURE.md L540-548](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L540-L548); [INVARIANTS.md INV-13](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1506)
- **statusLine stdin (the documented interface).** The bridge reads `rate_limits` (5-hour and 7-day `used_percentage` and reset), `session_id`, `context_window.used_percentage`, `context_window_size` and `cost.total_cost_usd`. It writes `~/.claude/agent-commander/rate-limits.json` and `sessions/<session_id>.json` by temp file plus rename. Its comment cites "the docs" for `session_id` being stable per session — [scripts/statusline-bridge.mjs L1-36](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/scripts/statusline-bridge.mjs#L1-L36), [L122-132](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/scripts/statusline-bridge.mjs#L122-L132)
- **The installer writes to the user's Claude configuration.** It adds `statusLine` to `~/.claude/settings.json` (with a `.json.bak` backup) and refuses if a `statusLine` already exists. That makes quota display and a custom status line mutually exclusive unless the user chains them by hand — [rust/src/main.rs L151-215](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/main.rs#L151-L215)
- **Hard-coded Claude Code UI strings (`drawn_choices`).**
  - `ExitPlanMode` → "Yes" / "Yes, manually approve edits" / "No, keep planning".
  - Every other tool's permission prompt → "Yes" / "Yes, and don't ask again" / "No, and tell Claude what to do differently".
  - Delegation tools (`Task`, `Agent`, `Workflow`) get no list.

  Sources: [rust/src/transcript.rs L556-579](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/transcript.rs#L556-L579), [L65](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/transcript.rs#L65)
- **That table drifted in the field.**
  - It was verified against Claude Code 2.1.260 and 2.1.261.
  - At 2.1.269 row 3 became plain "No" and row 2 gained a typographic apostrophe (U+2019), so "**only option 1 was answerable, on every permission prompt**" until the match was patched.
  - The table is now a fallback: rows are read off the pane wherever it draws at least two.

  Sources: [TODO.md §12 L322-368](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L322-L368); [rust/src/transcript.rs L531-555, L585-618](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/transcript.rs#L531-L618)
- **A residual risk is stated in the code.** Matching by "prefix in either direction" means that if the CLI swapped rows 1 and 2, approve-once and approve-always could be confused; only approval versus refusal is guaranteed apart — [rust/src/transcript.rs L607-615](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/transcript.rs#L607-L615)
- **Other behaviour verified against a specific Claude Code version, recorded only in comments or docs:**
  - multi-select picker driving, measured on 2.1.277;
  - the two-question picker and its review page, on 2.1.278;
  - `PICTURE_SETTLE` = 150 ms, so the Enter after a picture paste is not swallowed, on 2.1.278;
  - mock fixtures stamped 2.1.232.

  Sources: [INVARIANTS.md L1994](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1994), [L2119](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L2119), [L181](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L181); [rust/src/pane.rs L536](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/pane.rs#L536)
- **No version gating.** The session file's `version` is carried and shown (in Help it is the server version), but no minimum or maximum supported Claude Code version exists, and nothing warns when running against an unverified one (grep finds no such constant) — [rust/src/registry.rs L668-669](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L668-L669)
- **Control works by typing into the TUI**: `/model`, `/goal`, `/clear`, `/compact`, `/exit`, `BTab` and digit answers. Permission-mode changes cannot be observed, because Claude Code writes its `permission-mode` record only at the end of a turn — [INVARIANTS.md INV-8 L816+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L816); [AGENTS.md L279-658](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L279-L658)
- **tmux usage.** One long-lived control-mode client (`-C`) that never sends `refresh-client -C`, so it acquires no size. Reads use `capture-pane` and writes use `send-keys`/`paste-buffer`. Behaviour was measured against tmux 3.6a — [INVARIANTS.md INV-1 L17-89](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L17-L89); [rust/src/tmux_client.rs L701](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/tmux_client.rs#L701)
- **`isMissingTarget()` string-matches tmux's English error prose** to tell "session gone" from "could not ask" — [ARCHITECTURE.md L645-651](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L645-L651)
- **No hooks, OpenTelemetry or Agent SDK.** A grep of code and docs for these finds only two mentions, both in INVARIANTS.md: one cites a `PreToolUse` hook record as evidence that `tool_use` is flushed early ([INVARIANTS.md L1833](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1833)), and one cites Claude Code's own "Remote Control" push suppression as precedent ([INVARIANTS.md L1755](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1755); [rust/src/push.rs L26-28](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L26-L28)).
- **INV-5 degradation as implemented:**
  - a malformed session file skips only that record;
  - a transcript that moves is found again;
  - five consecutive pane-read failures are tolerated before the terminal gives up;
  - the quota cache keeps its last good value.

  Sources: [INVARIANTS.md INV-5 L619-674](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L619-L674); [rust/src/registry.rs L243-268](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L243-L268)

### Inferences
- The app depends on at least six independent Claude Code surfaces: the session file, `claude agents --json`, the transcript schema, subagent sidecars, the TUI's dialog rendering, and slash-command semantics and timing. Each is checked only by hand, against a named 2.1.x version, in comments. No automated canary or compatibility test runs against a real Claude Code.
- **Inferred single point of failure.** Suppose a release kept `claude agents --json` as an array but renamed `sessionId` in it. `read_cli_session_ids` would then return an empty set, every agent would become "unconfirmed" and be skipped, and the fleet would be empty (from L296-306 together with L582-587).
- **The same outcome follows from the session file.** Renaming `sessionId`, `pid` or `cwd` there would also empty the fleet, which is the opposite of INV-5's stated fallback.
- **Most degradations are silent.** "No tree" looks like "no delegates", and a status the app cannot parse becomes `unknown`. The user loses capability without being told why.
- Hooks (event push from Claude Code itself) are never discussed, neither as a source for status nor as a rejected alternative. Scraping is the only strategy the docs consider.

### Gaps
- Whether `claude agents --json` and `~/.claude/sessions/*.json` are officially documented was not checked against Anthropic documentation (outside this repo audit). The code calls the first "the supported presence check" and the second internal.
- Nothing was exercised against a live Claude Code. The fleet-emptying scenarios above come from reading the code and were not tested.

## 3. Security model

### Takeaway
The defences against a hostile web page are careful:
- an Origin plus Host gate that stops CSRF, cross-site WebSocket hijacking and DNS rebinding;
- a token exchanged for an `HttpOnly; SameSite=Strict` cookie;
- constant-time comparison, a 0600 token file, and four grants;
- a per-socket write budget;
- server-enforced confirmation for destructive keys;
- answers bound to a SHA-1 fingerprint of the question and re-checked against the pane.

The weak points are elsewhere:
- the tokenless default trusts any local process that sends no `Origin` header, including other OS users;
- no CSP or anti-framing headers are sent;
- the cookie *is* the long-lived bearer token (30 days), and grants are server-wide;
- there is no audit log and no native TLS;
- the spawn path permits `bypassPermissions` and `dontAsk`;
- pushes send agent names and session ids to third parties;
- the write budget can be multiplied by opening more sockets;
- release builds use `panic = "abort"`.

### Cited Findings
- **Bind policy.** The default bind is `127.0.0.1`. A non-loopback `--host` is refused without `--token` — [rust/src/options.rs L505-512](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/options.rs#L505-L512)
- **A tokenless server authorizes every request** (`authorized()` returns `true` when there is no token) — [rust/src/routes.rs L737-740](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L737-L740)
- **Origin gate.** `Origin`, when present, and `Host` must both name loopback or an entry in `origin_names`. That list is empty without a token; with one it adds the bound host and this host's Tailscale DNSName. The gate is never skipped, even for a correct token — [rust/src/routes.rs L569-612](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L569-L612), [L759-767](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L759-L767). INV-3 states the scope explicitly: an absent `Origin` "means a non-browser client, which is not what this guards" — [INVARIANTS.md L276-278](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L276-L278)
- **Token.** It is 128 bits, hex-encoded, stored 0600 at `~/.claude/agent-commander/token`. `--token auto` reuses it and `--rotate-token` replaces it — [rust/src/token_file.rs L48-53, L84](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/token_file.rs#L48-L84)
- **How the token is presented.** It is accepted from `?token=`, from `Authorization: Bearer`, or from the `ac_session` cookie, and compared with `subtle::ct_eq` after a length check — [rust/src/routes.rs L397-405](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L397-L405), [L737-757](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L737-L757)
- **Cookie exchange.** A browser navigation carrying `?token=` gets a 302 setting `ac_session=<token>; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`. `Secure` is added only when `X-Forwarded-Proto: https` is present. The cookie value is the token itself, so revocation means rotating the token for every device at once — [rust/src/routes.rs L614-716](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L614-L716)
- **`GET` and `HEAD` under `/assets/` bypass the token gate**, but not the origin gate — [rust/src/routes.rs L718-734](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L718-L734)
- **Grants.** There are four: `read`, `respond` (answer a prompt), `drive` (pastes, keys, mode, model, clear, compact, close, pictures) and `spawn` (new agents or terminals, folder browsing). The default is all four. They are set once per server process with `--grant`, not per token or per device — [rust/src/options.rs L44-64](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/options.rs#L44-L64); [rust/src/routes.rs L828-851](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L828-L851); [docs/HANDBOOK.md L714-748](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/docs/HANDBOOK.md#L714-L748)
- **Input bounds (INV-12):**
  - a per-connection token bucket allows a burst of 120 writes, refilling at 30 per second (`focus` and `attach` are not charged);
  - `MAX_PASTE` is 100,000 characters;
  - WebSocket frames and messages are capped at 1 MiB;
  - HTTP bodies are capped at 8 KiB, except pictures at 10 MB.

  Sources: [rust/src/control.rs L679-743](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/control.rs#L679-L743); [rust/src/routes.rs L105](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L105). No cap on concurrent sockets was found (grep for `MAX_SOCKETS`, `max_connections` and similar matches nothing).
- **Destructive keys.** `C-c`, `C-d` and `Escape` require `confirmed: true` server-side. Keys are allow-listed, and a sendable key is a type (`SendableKey`) — [rust/src/types.rs L943-950](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/types.rs#L943-L950); [INVARIANTS.md INV-6 L675-716](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L675-L716)
- **Answer binding.** The prompt id is a SHA-1 over length-prefixed fields: session id, tool, question, detail, the remaining-question count, header, the drawn/read flags, question index, summary, the sandbox flag, and each option's label and preview. Before typing, the server re-reads the transcript, and for drawn rows the pane too — [rust/src/types.rs L527-557](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/types.rs#L527-L557); [INVARIANTS.md INV-2 L90-258](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L90-L258)
- **Spawn may pick dangerous modes.** The allowed permission modes are `default`, `acceptEdits`, `plan`, `bypassPermissions`, `auto` and `dontAsk` — [rust/src/types.rs L915-921](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/types.rs#L915-L921); [rust/src/spawn.rs L136-137, L195-197](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/spawn.rs#L136-L197). The code acknowledges that `mode` "can cycle onto a permission mode that stops asking" — [rust/src/routes.rs L844-849](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L844-L849)
- **Push payload.** The title is the agent's name, the body is "Waiting on you — <waitingFor>", the link is `<notify-link>/agent/<session_id>`, and the tag is the session id. ntfy requests carry `Title`, `Tags`, `Priority` and `Click` headers, plus an optional bearer token from `AGENT_COMMANDER_NTFY_TOKEN`. The Telegram bot token comes from the environment or a 0600 file. Failures are logged and not retried — [rust/src/push.rs L38-46](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L38-L46), [L150-169](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L150-L169), [L192-219](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L192-L219)
- **No audit log.** The whole server contains about 29 print statements (main.rs 18, routes.rs 5, frames.rs 2, pictures.rs 2, push.rs 1, tmux_source.rs 1), no `tracing` or `log` crate, and no record of who answered, pasted or spawned what (measured by grep over [rust/src](https://github.com/ziweiwu/agent-commander/tree/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src))
- **No security headers or frame protection.** Greps for `Content-Security-Policy`, `X-Frame-Options`, `frame-ancestors`, `X-Content-Type-Options` and `Referrer-Policy` across rust/src and the HTML return nothing. The client has no frame-busting code, and no doc mentions clickjacking — [rust/src/routes.rs](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs); [src/web/index.html](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/index.html)
- **No TLS in the server.** Remote use relies on `tailscale serve` to terminate TLS. Nothing warns that a `--host` bind serves the token over plaintext HTTP — [README.md L85-96](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L85-L96)
- **Robustness.** The release profile sets `panic = "abort"`, and production Rust contains 106 `lock().unwrap()` calls (114 `.unwrap()`, 24 `.expect(`, 2 `unsafe` mentions) — [rust/Cargo.toml L47-52](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/Cargo.toml#L47-L52) (counts measured by grep before each file's `mod tests`)
- **Stated non-goal:** "Not multi-user. There are no accounts. A credential is a capability, not an identity" — [SPEC.md L64-65](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/SPEC.md#L64-L65)
- **Supply chain.**
  - Publishing uses npm trusted publishing via OIDC (`id-token: write`), with provenance, and no stored `NPM_TOKEN`; the publish workflow's top-level permissions are `contents: read` — [.github/workflows/npm-publish.yml L32-33, L205-214](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/npm-publish.yml#L32-L214).
  - `ci.yml` has no `permissions:` block.
  - Every action is pinned to a mutable tag (`checkout@v5`, `setup-node@v5`, `rust-cache@v2`, `upload-artifact@v4`/`download-artifact@v4`), and `dtolnay/rust-toolchain@stable` is a moving branch.
  - No CodeQL, `cargo audit`, `cargo deny`, `npm audit` or OSV scan runs.
  - There is no `dependabot.yml`, yet two Dependabot PRs sit open: [#2 (vitest, since 2026-09-10)](https://github.com/ziweiwu/agent-commander/pull/2) and [#5 (undici, 2026-10-01)](https://github.com/ziweiwu/agent-commander/pull/5) — [.github/workflows/ci.yml](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/ci.yml)

### Inferences
- **In the default configuration (loopback, no token), full control is open to any process on the machine that omits `Origin`.** That control includes typing into any pane, answering prompts, and spawning `bypassPermissions` agents. It covers other OS user accounts on a shared host, which tmux's per-user 0700 socket would otherwise keep out, so this is a privilege-boundary crossing. It also covers the supervised agents themselves, since an agent can `curl` localhost. For same-user processes the marginal risk is modest, because they can already run `tmux send-keys` or `claude --permission-mode …`. For prompt-injection threat models the dashboard is a ready-made control plane.
- **Clickjacking (inferred, not tested).** Nothing stops another site from framing the tokenless loopback UI. Requests from inside the frame carry the app's own `Origin` and pass the gate. In token mode the `SameSite=Strict` cookie is not sent to a cross-site frame, so the frame gets a 401, which mitigates it.
- **A stolen cookie is full control for up to 30 days, or until rotation**, and rotation logs out every device. A `respond`-only credential can still select "Yes, and don't ask again", which escalates an agent's permissions persistently.
- **ntfy.sh topics are effectively bearer URLs** unless an access token is configured. Agent names, which are often derived from the user's prompts or the AI-generated title, plus session ids and the tailnet hostname in the link, go to a third party.
- **A remote-control tool for agents has no record of its actions.** With no audit trail, a phone session that typed or approved something cannot be reviewed afterwards.

### Gaps
- No penetration testing was done. The clickjacking, cross-user and socket-multiplication points come from reading the code.
- The startup banner's token masking was not inspected beyond ARCHITECTURE.md's description (it says the token is masked to four characters unless `--print-url` is given).

## 4. Repo conventions and process: agent instructions, gates, CI, tests, and count drift

### Takeaway
This is an unusually heavily documented, invariant-driven, agent-oriented repository:
- `CLAUDE.md` imports `AGENTS.md` and `INVARIANTS.md`, about 3.3k lines and 34k words (roughly 44–52k tokens), into every session;
- tests are numerous and tied to invariant numbers by a guard test;
- generated files are held to their generators by drift tests.

The enforcement is not self-contained, though. The Stop hook and the review agents come from an undeclared external `harness` plugin. There is no setup hook. Security scanning and job timeouts are missing from CI. Prose has drifted, including test counts and Node-era identifiers inside the always-loaded contract.

### Cited Findings
- **`CLAUDE.md` is two lines:** `@AGENTS.md` and `@INVARIANTS.md` — [CLAUDE.md](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/CLAUDE.md)
- **Document sizes.** Measured with `wc` at a69ffe5. The two token columns are approximations (words × 1.3, and characters ÷ 4).

  | Document | Lines | Words | Characters | ≈ tokens (words × 1.3) | ≈ tokens (chars ÷ 4) |
  |---|---|---|---|---|---|
  | AGENTS.md | 808 | 8,016 | 50,036 | 10,420 | 12,509 |
  | INVARIANTS.md | 2,476 | 25,891 | 156,751 | 33,658 | 39,187 |
  | **Always loaded (CLAUDE.md + AGENTS.md + INVARIANTS.md)** | **3,286** | **33,909** | **206,813** | **≈44,100** | **≈51,700** |
  | ARCHITECTURE.md | 823 | 7,663 | 49,512 | 9,961 | 12,378 |
  | SPEC.md | 1,069 | 10,076 | 64,712 | 13,098 | 16,178 |
  | TODO.md | 476 | 4,305 | 27,355 | 5,596 | 6,838 |
  | docs/HANDBOOK.md | 1,070 | 9,904 | 59,821 | 12,875 | 14,955 |
  | CONTRIBUTING.md | 126 | 857 | 5,446 | 1,114 | 1,361 |
  | README.md | 159 | 1,245 | 8,267 | 1,618 | 2,066 |

  Across these nine files the total is 67,959 words, about 88k tokens — [AGENTS.md](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md), [INVARIANTS.md](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md)
- **What fills the always-loaded files.**
  - AGENTS.md's "Things that have already bitten" section is 380 lines and 4,310 words, 54% of the file, in 40 war-story entries — [AGENTS.md L279-658](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L279-L658).
  - The largest invariants are INV-16 (386 lines, 4,087 words), INV-11 (366, 3,996), INV-4 (255, 2,700), INV-8 (224, 2,534) and INV-17 (217, 2,504). All are prose with embedded "Amended:" histories — [INVARIANTS.md](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1820)
- **Loading INVARIANTS.md everywhere was deliberate.** Commit `543a0a5` says "CLAUDE.md now imports INVARIANTS.md beside AGENTS.md, so the contract is in context for every Claude Code session in this repository". INVARIANTS.md also ships in the npm package's `files` — [commit 543a0a5](https://github.com/ziweiwu/agent-commander/commit/543a0a5); [package.json L28-35](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/package.json#L28-L35)
- **`.claude/` contains only `gates.json`.** It lists watch paths (`src/`, `rust/`, `test/`, `scripts/`, `package.json`, `package-lock.json`, `tsconfig.json`), three gates (typecheck, lint, test), and a 600 s timeout — [.claude/gates.json](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.claude/gates.json)
- **The Stop hook "lives in the `harness` plugin and reads its list from `.claude/gates.json`"** — [AGENTS.md L140-142](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L140-L142). The review agents `harness:qa-bar-raiser` and `harness:ux-bar-raiser` ship in the same plugin; the repo's own copy was deleted after it "fell six months behind" — [docs/HANDBOOK.md L880-889](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/docs/HANDBOOK.md#L880-L889). The repo has no `settings.json`, `plugin.json`, marketplace file or `.mcp.json`, and no doc says where to obtain the plugin (checked with `find` and `grep`).
- **The pre-commit hook is also external.** It applies clean-code thresholds and a secret scan configured by `.cleancode.json` (only `magic-number` relaxed to a warning), but the hook itself is not in the repo — [AGENTS.md L798-808](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L798-L808); [.cleancode.json](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.cleancode.json)
- **Gate costs as documented.** AGENTS.md reports typecheck 5.0 s, lint 0.9 s, test about 40 s and build 3.4 s. It deliberately keeps build, e2e, audits, qa and `verify:inv1` out of the Stop hook — [AGENTS.md L98-160](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L98-L160)
- **CI (`ci.yml`)** has three jobs and cancels in-progress runs per ref, but sets no `timeout-minutes` — [.github/workflows/ci.yml L25-163](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/ci.yml#L25-L163):

  | Job | Node | What it runs |
  |---|---|---|
  | `check` | 22 | typecheck, lint (oxlint plus clippy `-D warnings`), test, build |
  | `floor` | 20 | build, then the Rust binary's `--help` |
  | `e2e` | 22 | installs tmux and a keep-alive session, runs Playwright on Chromium and WebKit, uploads the report on failure |

- **The `floor` job's comment is stale.** It says the package is "`dist/` plus one runtime dependency (`ws`)", but `package.json` has no `dependencies`. The job also runs the Rust binary directly, not `scripts/launch.mjs` on Node 20, so the `engines: node >=20` launcher is never executed on Node 20 — [.github/workflows/ci.yml L72-105](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/ci.yml#L72-L105)
- **`npm-publish.yml` (387 lines)** runs a tag/version guard and the gates, builds a four-target matrix (macos-latest for both darwin targets, `ubuntu-22.04` and `ubuntu-22.04-arm` for Linux), then publishes once. Before publishing it checks `chmod 755` and the tarball listing, and smoke-tests linux-x64, including a mock-server `/api/env` probe. `darwin-x64` is never executed — [.github/workflows/npm-publish.yml](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/npm-publish.yml); [AGENTS.md L720-733](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L720-L733)
- **Generated artefacts held by tests:**
  - `gen-themes.py` → `tokens.css`, held by `test/scheme.test.ts`;
  - `gen-ui-icons.py` → `icon-paths.ts`, held by `test/icons.test.ts`;
  - `gen-icons.py` → the app-icon PNGs, held by `test/mac-app.test.ts`;
  - `wire.ts` from `types.rs` via ts-rs, held by `types::tests::the_checked_in_wire_contract_is_current`;
  - four golden JSON responses captured from the old Node server (`rust/tests/golden`).

  Sources: [AGENTS.md L165-190](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L165-L190); [ARCHITECTURE.md L782-785](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L782-L785)
- **The invariant guard (`test/invariants.test.ts`)** enforces:
  - contiguous numbering;
  - at least one test carrying each number (`invN_` in Rust or `INV-N` in a test string);
  - no orphan numbers;
  - every cited `test/` or `e2e/` file exists;
  - every cited `module::invN_*` Rust test exists.

  It does not check prose identifiers or counts. Its own doc comment still says "INV-10 is known-unpinned" and "Keeping the list non-empty is deliberate", while `KNOWN_UNPINNED` is empty — [test/invariants.test.ts L72-84, L86-160](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/test/invariants.test.ts#L72-L160)
- **Measured test counts (static grep at a69ffe5):**

  | Suite | Measured | Detail |
  |---|---|---|
  | Rust | 685 test attributes | 316 `#[test]`, 365 `#[tokio::test]`, 4 `#[tokio::test(start_paused = true)]`, including one proptest-state-machine property test |
  | Vitest | ≈819 cases | 802 call sites: 795 `it(` plus 7 `it.each(` tables that expand to 24 cases; 26 node `.test.ts` and 59 jsdom `.test.tsx` files |
  | Playwright | 409 project-test instances | 99 declared tests in 17 specs; tag exclusions across the five projects give desktop 85, tablet 82, phone 80, phone-safari 80, tablet-safari 82 |

  The Rust test modules make up 14,238 of 31,558 lines (45%) in files that have one, and `pane_props.rs` (391 lines) is test-only. Sources: [rust/src](https://github.com/ziweiwu/agent-commander/tree/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src); [test/](https://github.com/ziweiwu/agent-commander/tree/a69ffe58bc269d02d236aa4c9e2583920ffa0070/test); [e2e/](https://github.com/ziweiwu/agent-commander/tree/a69ffe58bc269d02d236aa4c9e2583920ffa0070/e2e); [playwright.config.ts L78-106](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/playwright.config.ts#L78-L106)
- **Count claims across the docs disagree:**

  | Source | Claim |
  |---|---|
  | AGENTS.md L106-108 | "1497 tests: 684 Rust + 813 vitest" and "406 end-to-end tests" (close to measured: +1, +6, +3) |
  | AGENTS.md L63; ARCHITECTURE.md L789 | "233 Playwright tests" (the figure at the time of the Rust port) |
  | docs/HANDBOOK.md L783-784 | "1197 tests: 597 Rust + 600 vitest" and "401 end-to-end tests" (stale) |
  | TODO.md L299 | "399 Playwright tests" |
  | ARCHITECTURE.md L723-724 | `npm test` runs on "CI, Node 20 and 22"; e2e on "CI, Chromium" (tests actually run on Node 22 only, and e2e also runs WebKit) |
  | CONTRIBUTING.md L10 | "CI runs 20 and 22" |

  Sources: [AGENTS.md L63](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L63), [L106-108](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L106-L108); [docs/HANDBOOK.md L783-784](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/docs/HANDBOOK.md#L783-L784); [TODO.md L299](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L299); [ARCHITECTURE.md L723-724, L789](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L723-L789); [CONTRIBUTING.md L10](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/CONTRIBUTING.md#L10)
- **E2E harness settings.** `workers: 1`, `fullyParallel: false`, `retries: 1` on CI, and `reuseExistingServer` outside CI. AGENTS.md warns that reuse makes Rust changes invisible to e2e — [playwright.config.ts L122, L152-157](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/playwright.config.ts#L122-L157); [AGENTS.md L503-523](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L503-L523)
- **Local-only checks.**
  - `audit:contrast`, `audit:a11y`, `audit:ux` and `audit:mobile`. The a11y audit is a custom Playwright implementation of a "P0 set" of WCAG 2.2 AA checks, not axe-core.
  - `audit:workspace` (a bar of at least 80% of the viewport for the work surface).
  - `qa`, a seeded randomized sweep.
  - `verify:inv1`, which needs a live tmux server with a real agent.

  Sources: [package.json scripts L36-68](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/package.json#L36-L68); [scripts/audit-a11y.mjs L1-9](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/scripts/audit-a11y.mjs#L1-L9); [.github/workflows/ci.yml L17-24](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/ci.yml#L17-L24)
- **Commit rules versus practice.** The rules are "explain why", "never add a `Co-Authored-By: Claude` or any AI-attribution trailer", and "one change per commit" — [AGENTS.md L795](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L795); [CONTRIBUTING.md L101-106](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/CONTRIBUTING.md#L101-L106). In practice, 25 of 103 commits on main carry a `Claude-Session:` trailer linking a claude.ai session, none carry `Co-Authored-By`, and the last 60 commit messages average 224 words — [commits on main](https://github.com/ziweiwu/agent-commander/commits/main)
- **Known flakes are documented**: `scheme.test.ts`, `token.test.tsx`, WebKit timeouts under load, `theme.spec` on WebKit, a `fades.spec` race, and `control.spec`'s `/clear` follow test on CI — [AGENTS.md L279-658](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L279-L658)
- **Machine-specific operational content sits in the always-loaded AGENTS.md:**
  - the launchd job `com.ziweiwu.agent-commander` and `launchctl kickstart`;
  - `~/Library/Logs`;
  - "one browser, shared" by the Chrome DevTools MCP;
  - "Measured on this machine" timings.

  Source: [AGENTS.md L223-265](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L223-L265)
- **Observed in this cloud checkout:** Node 22, cargo, tmux and claude are present, but `node_modules/` is absent. The repo has no SessionStart hook or setup script to install it, so the Stop-hook gates cannot pass in a fresh remote session without a manual `npm ci`.

### Inferences
- **Strong agent-friendly patterns:**
  - machine-checkable claims (invariant numbers in test names, a citation guard);
  - generated-artefact drift tests;
  - an explicit "say which gates you ran" norm;
  - a mock mode on separate ports that keeps agents away from real sessions;
  - documented flake signatures.
- **Weaknesses for agents.**
  - About 44–52k tokens of narrative is front-loaded into every session; more than half of it is history, war stories and "Amended:" notes rather than imperative rules.
  - Prose inside that always-loaded contract is stale (see §5), and the guard cannot catch it.
  - The enforcement that makes the docs safe, the Stop hook and the review agents, cannot be reproduced from the repository, so a new contributor or cloud agent gets the claims without the gates.

### Gaps
- Exact runtime test counts were not obtained, because node_modules was not installed and the Rust test build was not compiled. Static counts may differ slightly from runtime (skips and conditional `test.skip`).
- The `harness` plugin's code was not inspected, so the Stop hook's actual behaviour is known only from AGENTS.md.

## 5. Code size, history, and stale or dead references

### Takeaway
About 32k lines of Rust (around 45% of it tests) and about 19k lines of TypeScript, TSX and CSS for the web app, plus about 15k lines of tests and e2e. The project is a single maintainer's AI-assisted sprint: 103 commits and 31 tags in 43 days (v0.1.1 to v0.17.1), with very large multi-concern commits, including the entire Rust port in one commit. Documentation drift after the Node-to-Rust port is substantial: a missing preservation branch, a Rust README that says the Rust server is "parked", Node-era identifiers in the always-loaded invariants, and stale counts and branding.

### Cited Findings
- **Rust server (`rust/src`):** 31 files, 32,239 lines (29,445 non-blank). The largest:

  | File | Lines | Note |
  |---|---|---|
  | routes.rs | 5,763 | tests start at L3247 |
  | transcript.rs | 3,519 | |
  | mock.rs | 2,528 | |
  | pane.rs | 2,403 | |
  | registry.rs | 1,731 | |
  | control.rs | 1,610 | |
  | tmux_client.rs | 1,390 | |
  | subagents.rs | 1,264 | |
  | pane_hub.rs | 1,219 | |
  | types.rs | 1,181 | |
  | enrich.rs | 1,077 | |

  `rust/tests` holds only four golden JSON files (696 lines) — [rust/src](https://github.com/ziweiwu/agent-commander/tree/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src)
- **Web app.**
  - `src/web`: 28 `.ts` files (6,103 lines), 30 `.tsx` (7,105) and 25 `.css` (5,580); `src/shared` has 4 files (623).
  - Largest: `transport.ts` 988, `i18n.ts` 948, `Chat.tsx` 902, `Terminal.tsx` 745, `chat.ts` 618, `term.ts` 599, `store.ts` 570.
  - Tests: `test/` has 26 `.ts` files (3,558 lines) and 59 `.tsx` (9,404); `e2e/` has 18 files (2,323).
  - `scripts/` has 20 files (4,422 lines), of which `gen-themes.py` is 1,015.

  Source: [src/web](https://github.com/ziweiwu/agent-commander/tree/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web)
- **Dependencies.**
  - Server: tokio, axum 0.7 (WebSocket), tower-http, hyper, serde/serde_json, subtle, notify, libc, regex, sha1, base64, and reqwest with rustls.
  - Server dev-dependencies: ts-rs, proptest, proptest-state-machine, tokio-tungstenite, tempfile.
  - Release profile: LTO, `codegen-units = 1`, `strip`, `panic = "abort"`.
  - Web (all `devDependencies`, no runtime dependencies at all): React 19, react-router 7, zustand 5, @xterm/xterm 5, Vite 7, vitest 4, Playwright 1.62, oxlint.

  Sources: [rust/Cargo.toml](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/Cargo.toml); [package.json](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/package.json)
- **History (GitHub API).**
  - Repository created 2026-08-15; 103 commits on main from 2026-08-14 ("Initial commit") to 2026-09-26 ("0.17.1").
  - One contributor, `ziweiwu`, with all 103 commits.
  - 31 tags, `v0.1.1` to `v0.17.1` (including `v0.8.1-rc.0` and `-rc.1`), and no GitHub Release objects.
  - 0 stars and 0 forks. The last push, 2026-10-01, was a Dependabot branch.

  Sources: [api.github.com/repos/ziweiwu/agent-commander](https://api.github.com/repos/ziweiwu/agent-commander); [tags](https://github.com/ziweiwu/agent-commander/tags); [commits](https://github.com/ziweiwu/agent-commander/commits/main)
- **Cadence.** Commits fall on 20 of the 43 days, in bursts (16 commits on 2026-08-27 and 16 on 2026-09-03). Main had no commits between 2026-09-26 and the audit date, 2026-10-02 — [commits](https://github.com/ziweiwu/agent-commander/commits/main)
- **Pull requests.** Five in total. #1, #3 and #4 are closed feature PRs by the owner; #2 and #5 are open Dependabot bumps — [pulls](https://github.com/ziweiwu/agent-commander/pulls?q=is%3Apr)
- **Commit size.**
  - The Rust port landed as one commit, `11b7cb1`: +27,038 / −13,130 lines across 118 files.
  - Other feature commits run 3.5k–5.2k insertions across 39–87 files (`3cdd509`, `21dff05`, `dee2dac`, `b301ede`, `a644a1d`).
  - The median is about 135 insertions over the locally available 60 commits.

  Sources: [commit 11b7cb1](https://github.com/ziweiwu/agent-commander/commit/11b7cb1); [commit dee2dac](https://github.com/ziweiwu/agent-commander/commit/dee2dac)
- **Branches on GitHub:** main, experiment/rust-backend, feat/research-top-six, feat/self-pacing-polls-e2e-and-colour-schemes, fix/code-review-findings, chat/status-rail-answers-and-terminal-run, and two Dependabot branches — [branches](https://github.com/ziweiwu/agent-commander/branches/all)
- **Stale or dead references, sampled and verified:**
  - **`old-node-backend-branch`** is cited as where the TypeScript server is "preserved, working" ([AGENTS.md L54](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L54); [ARCHITECTURE.md L759](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L759); [docs/HANDBOOK.md L757](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/docs/HANDBOOK.md#L757)). No branch or tag of that name exists on GitHub: the branch API returns 404 and there are no matching refs. The code is only reachable in main's history before `11b7cb1`.
  - **`rust/README.md`** says "The Rust backend — parked … It is not part of the app, and this branch is the only place it exists … The published package is the TypeScript server". It also cites four scripts that do not exist (`ab-bench.py`, `ab-compare-ws.mjs`, `ab-compare.py`, `ws-load.mjs`) — [rust/README.md L1-10](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/README.md#L1-L10). **`rust/PORT-CONTRACT.md`** says "The Node backend on `main` is the specification. This branch replaces it" — [L1-5](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/PORT-CONTRACT.md#L1-L5).
  - **The package description** still says "See every Claude Code and Kiro CLI agent", although Kiro support was removed deliberately — [package.json L4](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/package.json#L4); [AGENTS.md L281](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L281). The GitHub repo description is current.
  - **Config and code comments still describe the old layout:**
    - `.gitignore` says the Rust port "lives on `experiment/rust-backend`" ([.gitignore L12](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.gitignore#L12));
    - `playwright.config.ts` cites `cli.ts` ([L20](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/playwright.config.ts#L20));
    - the statusline bridge cites `src/server/transcript.ts` and `src/server/limits.ts` ([L7, L16](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/scripts/statusline-bridge.mjs#L7-L16));
    - `find_bridge` cites `cli.ts` ([rust/src/main.rs L131-133](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/main.rs#L131-L133)).
  - **ARCHITECTURE.md still describes the removed forest view as current** (L144, L346, L350, L417 — which names a missing `src/web/lib/forest.ts` — and L543). Its fragility list cites Node-era locations: `registry.ts:183`, `registry.ts:320`, `enrich.ts:17`, `routes.ts:410/633`, `pane-hub.ts:40/76`, `routes.ts:365` and `registry.ts:41`. Its comment-density figures ("`pane.rs` 173/478") predate the port; `pane.rs` is now 2,403 lines — [ARCHITECTURE.md L540-643](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L540-L643)
  - **INVARIANTS.md, which is always loaded, names Node-era identifiers that appear in no file under rust/src, src or scripts:** `assertSlashCommandable`, `checkSpawnRequest`, `findTranscript`, `assertAttachable`, `assertControllable`, `buildFrame`, `isNoop`, `maxPayload`, `transcript.ts:244` and `transcript.ts:17` (grep count 0 for each) — [INVARIANTS.md](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md). AGENTS.md has `Registry.changed()` (`registry.ts:320`) and `wire::render_once()`, which actually lives in `types.rs`.
  - **Citations that do hold.** Every Rust test name cited in INVARIANTS.md, SPEC.md, TODO.md, AGENTS.md and ARCHITECTURE.md was checked and exists (the one apparent miss, `transcript::prompt_tests`, is a module name). Every `test/` and `e2e/` path cited in AGENTS.md, INVARIANTS.md, SPEC.md and TODO.md exists. The six missing paths cited by ARCHITECTURE.md are `forest.ts` plus five test files named in its "Fixed since…" history section.
- **Code-quality markers.** The 15 TODO/FIXME markers in the code all point at completed TODO.md sections. ARCHITECTURE.md itself flags "comment density inverted relative to risk", with registry.rs thinly commented — [ARCHITECTURE.md L638-643](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L638-L643)

### Inferences
- The bus factor is 1. Development is fast and AI-assisted (`Claude-Session:` trailers, very long commit bodies), and documentation churns faster than any guard can keep it consistent. The port moved the code and left behind much of the prose that describes it.
- `routes.rs`, at 5.8k lines with 3.2k of production code, is a god module combining HTTP dispatch, gates, socket handling and control. That concentrates security-relevant logic in one hard-to-review file.
- The "preserved on a branch" claim is not true on the remote. An agent told to "reach for" `old-node-backend-branch` will fail.

### Gaps
- The Rust test build was not compiled, so there is no coverage figure. No coverage tooling (llvm-cov, c8 or similar) is configured in the repo.

## 6. TODO.md: what is queued, and what was considered and rejected

### Takeaway
TODO.md works as a decision log more than a backlog. Of 14 numbered items, 13 are marked done and one, §4 (Kani proofs), was attempted and deferred. Its "Not doing" section rejects TLA+, and it records two findings it deliberately left alone. AGENTS.md still calls it "queued work".

### Cited Findings
- **Origin and ordering.** The items came from a review of whether the invariants should be formalized, and are ordered "by how much it removes rather than how much it adds" — [TODO.md L10-18](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L10-L18)
- **Done:**
  - §1 illegal states made unrepresentable: `WithinRoot` (INV-9), `SendableKey` (INV-6), and `Prepared`/`Failed` (INV-2);
  - §2 the generated wire contract;
  - §3 a proptest state machine for INV-2 (96 cases of up to 10 steps);
  - §5 the Attach view made bigger and re-fitted on resize;
  - §6 blocked-shape and dead-pane fixtures;
  - §7 a single shared parity list;
  - §8 the composer height cap;
  - §9 palettes tuned against real themes;
  - §10 the icon redesign (commit `8f65488`);
  - §11 a multi-select fixture;
  - §12 drawn choices read off the pane;
  - §13 edge cases (a)–(d) from a transcript survey;
  - §14 sending a picture.

  Source: [TODO.md L22-465](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L22-L465)
- **Deferred: §4, Kani proofs** of pure predicates, attempted 2026-09-02. Five harnesses had not finished one result after 3 h 30 m. A single harness generated 225,393 verification conditions and was still in the SAT solver at 15 minutes. "Nothing of it is in the tree" — [TODO.md L64-90](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L64-L90)
- **Deliberately not acted on:**
  - `drawn_choices` offers the permission triple for about 15 tool names that never raise a dialog (`ToolSearch`, `StructuredOutput`, `SendMessage`, the `Task*` family — about 2,000 calls);
  - `ExitPlanMode` inlines the whole plan (median 11.3 KB) while `planFilePath`, present on 30 of 30 calls, goes unused.

  Source: [TODO.md L419-424](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L419-L424)
- **Not doing: TLA+ for the invariant set.** Of the 16 invariants then numbered, one is protocol-shaped, four are epistemic, two concern tmux's own behaviour, six are predicates and one is about cost. A spec would be "a third artifact to keep in sync", "would prove nothing about the Rust", and is "a format agents write poorly" — [TODO.md L467-476](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L467-L476)
- **Survey data recorded there:**
  - 714 transcript files, 229,909 records and 47,919 tool calls;
  - 45.9% of `AskUserQuestion` calls were multi-question sets (72 of 157);
  - 10.3% of tool calls gave the card nothing to summarize;
  - 43% of Bash calls were multi-line;
  - `dangerouslyDisableSandbox` appeared on 174 calls and was not surfaced at the time.

  Source: [TODO.md L378-417](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L378-L417)
- **Description mismatch.** AGENTS.md describes TODO.md as "queued work, written to be executed cold" — [AGENTS.md L786](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L786)

### Inferences
- Nothing is queued for product evolution: no item covers hooks, worktrees, history, multi-machine work or security hardening. Future direction is not written down anywhere in the repo.
- The rejected and deferred items are formal-methods ideas (Kani, TLA+). The project prefers example-based tests, types and property tests over formal verification, and says why in measured terms.

### Gaps
- None beyond the above. The file was read in full.

## 7. Gaps relative to common fleet-management features, and which are deliberate non-goals

### Takeaway
Six non-goals are explicit: not a terminal multiplexer, not an agent runner or orchestrator, not multi-machine, not multi-user, not a cost tracker, not Windows. Several other common capabilities are absent and **never discussed**:
- git worktree or branch isolation;
- diff or changed-files review;
- PR or CI integration;
- history and search across ended sessions, or resume;
- hooks-based status;
- OpenTelemetry;
- Web Push;
- an audit log;
- CSP or anti-framing headers.

Linux ships as binaries but is a secondary target.

### Cited Findings
- **Explicit non-goals.** Not a terminal multiplexer; not an agent runner ("never decides what an agent should do next, never retries, and never composes a message"); not multi-machine; not multi-user; not a cost tracker; not Windows — [SPEC.md L57-70](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/SPEC.md#L57-L70)
- **Worktrees.** No document mentions worktrees (grep count 0). The only occurrence is `.gitignore`'s `.claude/worktrees/`, for "worktrees this repo's own agents check out into". Spawning is `tmux new-session -d -s <generated> -c <dir> claude [-n] [--model] [--permission-mode]`, with no branch or worktree option — [.gitignore L17-18](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.gitignore#L17-L18); [rust/src/spawn.rs L175-197](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/spawn.rs#L175-L197)
- **No diff view, PR or CI integration.** The server spawns only `tmux`, `ps`, `claude` and `tailscale`; there is no `git` and no GitHub API call. The branch shown on a card comes from the transcript's `gitBranch` field — [rust/src/env.rs L20-21](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/env.rs#L20-L21); [rust/src/registry.rs L297](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L297)
- **No history of ended sessions.** The fleet is live processes only (a `kill(pid, 0)` liveness check). Tests treat `--resume` as hostile input, and search filters only the live fleet — [rust/src/registry.rs L149-167, L243-268](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L149-L268); [rust/src/spawn.rs L449](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/spawn.rs#L449)
- **Cost.** `tokens` (output tokens only) is labelled as such. Per-session context percentage and the CLI's own cost estimate appear in the card's fold. There is no aggregate cost dashboard, by design — [SPEC.md L66-68](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/SPEC.md#L66-L68); [ARCHITECTURE.md L563-571](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L563-L571)
- **Observability.** OpenTelemetry and telemetry get zero mentions across the docs and code, and hooks and the Agent SDK are absent from code (see §2).
- **Accessibility is a strong area.** A custom WCAG 2.2 AA audit covers five profiles in both themes (run locally). Touch targets are 44 px and text inputs at least 16 px on coarse pointers. INV-17 requires the same actions on every layout, and the status rail is `aria-hidden` with words beside it — [INVARIANTS.md INV-17 L2206+](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L2206)
- **Mobile push uses third-party ntfy or Telegram, not Web Push.** There is no service worker (see §1). Lock-screen answering is deliberately excluded — [README.md L109-111](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L109-L111)
- **Overlap with a first-party feature.** The docs cite Claude Code's own "Remote Control" as the model for push suppression, which shows awareness that it overlaps with this app's phone use case — [INVARIANTS.md L1755](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L1755)

### Inferences
- **Deliberate, and argued in the docs:** multi-machine, multi-user, cost tracking, Windows, orchestration and autonomous action.
- **Absent and apparently never considered (no mention at all):**
  - worktree or branch isolation per agent;
  - diff or changed-files review before approving;
  - PR/CI status;
  - ended-session history, search or resume;
  - hooks- or OTel-based event ingestion instead of polling and scraping;
  - an audit trail;
  - CSP;
  - Web Push.
- The app is optimized for one human answering prompts in real time, not for reviewing what agents changed. That is a notable gap for a supervision tool: an approval decision is made without a view of the diff.

### Gaps
- Comparison against specific competing tools was out of scope for this repo audit.

## 8. Platform assumptions

### Takeaway
The app is designed and operated on macOS: production runs as a launchd job, there is a macOS `.app` launcher, the Tailscale macOS app path is probed, and the docs' measurements were taken on a Mac. Linux x64 and arm64 binaries are published and CI runs mock-mode e2e on Ubuntu, but real-mode Linux behaviour is exercised only by unit tests with fakes. Windows is an explicit non-goal. Every write path assumes tmux.

### Cited Findings
- **tmux is required.** Agents must run inside tmux; an agent outside it is listed and its chat readable, but it cannot be written to — [README.md L66-80](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L66-L80)
- **Production is a launchd job.** `~/Library/LaunchAgents/com.ziweiwu.agent-commander.plist` runs it with `KeepAlive`; restarts use `launchctl kickstart -k gui/$(id -u)/com.ziweiwu.agent-commander`. The plist is not in the repo — [AGENTS.md L223-245](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L223-L245)
- **macOS bundle.** It contains `Contents/Resources/bin` plus `web`, and is signed with `codesign` before a `--help` smoke test. `launcher.sh` uses `osascript`, `/usr/bin/open`, a `/usr/bin/perl` fork with a plain-background fallback, and BSD `stat -f`. "It is not covered by any gate" — [AGENTS.md L734-757](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L734-L757); [scripts/mac-app/launcher.sh L198, L269-291, L364-365](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/scripts/mac-app/launcher.sh#L198-L365)
- **Tailscale probe.** It tries `tailscale`, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale` — [rust/src/env.rs L20-21](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/env.rs#L20-L21)
- **Measurements in the docs come from macOS**: `kern.maxprocperuid` 2666 with 109 panes and 33 sessions, and "on an M-series Mac" for the Kani attempt. tmux behaviour was measured on 3.6a — [rust/src/pane.rs L522](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/pane.rs#L522); [TODO.md L75](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/TODO.md#L75); [rust/src/tmux_client.rs L701](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/tmux_client.rs#L701)
- **Linux.**
  - FR-ENV-1 promises a single binary on macOS (arm64, x64) and Linux (x64, arm64) ([SPEC.md L75](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/SPEC.md#L75)).
  - The Linux legs are pinned to ubuntu-22.04 to set a low glibc floor.
  - CI e2e runs on ubuntu-latest in `--mock` mode with a real tmux server ([.github/workflows/ci.yml L127-152](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/ci.yml#L127-L152)).
  - Process inspection uses `ps -axo pid=,ppid=,etime=,command=` ([rust/src/procs.rs L70](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/procs.rs#L70)).
- **Windows** is not supported "because the terminal view is tmux" — [README.md L64](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/README.md#L64); [SPEC.md L69-70](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/SPEC.md#L69-L70)
- **Node versions.** The launcher needs Node ≥ 20 (`engines`). The tests need Node 22, because jsdom@30 does not run on Node 20 — [.github/workflows/ci.yml L48-57](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/ci.yml#L48-L57)
- **Statusline install path.** `--install-statusline` locates the bridge by walking up from the executable to the first `scripts/statusline-bridge.mjs`. It has no special handling for npx's cache, yet HANDBOOK recommends `npx @ziweiwu/agent-commander --install-statusline` — [rust/src/main.rs L130-148](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/main.rs#L130-L148); [docs/HANDBOOK.md L313-315](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/docs/HANDBOOK.md#L313-L315)

### Inferences
- Linux is "shipped and smoke-tested, not lived on". Real-mode code paths there (procps `ps` output, the Linux Tailscale CLI, session files under Linux paths, launch without launchd) have no automated end-to-end coverage, and no doc describes running the server as a service on Linux (no systemd unit or equivalent).
- **Inferred, not tested:** an npx-installed statusline may write a path inside npx's cache into `~/.claude/settings.json`. If that cache is pruned, the path breaks, which runs against INV-10's "cannot break a Claude Code session" in spirit. The docs handle the analogous `.app` case explicitly ([AGENTS.md "The bundle ships no statusline-bridge.mjs"](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L279-L658)) but not npx.

### Gaps
- Nothing was run on Linux in real mode, so whether `ps -axo …` parses cleanly on procps-ng is unverified.
