# Claim verification: agent-commander v0.17.1 (commit a69ffe5)

Method. HEAD (93d7cc0) is a69ffe5 plus two commits that add only `research_notes/` files, so all line numbers are valid at a69ffe5 and links point there. I built the release binary (`scripts/cargo.sh build --release`, exit 0) and ran two probe scripts that started `--mock` servers — tokenless on :4400 and token-protected on :4401 — sending raw HTTP/WebSocket requests with chosen headers, then killed both. Port 4317 was never used. No real browser was available (no Playwright/Chromium; npm install was off limits), so statements about what a browser attaches on its own are marked as spec inference. Probe scripts live in the session scratchpad (temporary), so their outputs are quoted inline.

Verdict summary:

| # | Claim | Verdict |
|---|---|---|
| 1 | Origin gate ignores ports | CONFIRMED (cookie-ride-along is spec inference) |
| 2 | Tokenless default grants full access to a no-Origin local client | CONFIRMED |
| 3 | No CSP / X-Frame-Options / frame-ancestors | CONFIRMED |
| 4 | INV-5's "still list from `claude agents --json`" fallback does not exist | CONFIRMED |
| 5 | Spawn permits `bypassPermissions` and `dontAsk` | CONFIRMED (`dontAsk` is restrictive, not dangerous) |
| 6 | No step-up for dangerous permission dialogs | CONFIRMED |
| 7 | `old-node-backend-branch` missing on origin | CONFIRMED |
| 8 | AGENTS.md says token printed in full; code masks it | CONFIRMED |
| 9 | Push semantics as described | CONFIRMED (+ the session-id tag is not sent as an ntfy tag) |
| 10 | Many lock `unwrap()`; `panic = "abort"` | CONFIRMED (108 non-test; poisoning moot under abort) |
| 11 | CI actions on mutable tags; no security scanning | CONFIRMED |
| 12 | Always-loaded instructions ~44–59k tokens | Both are heuristics on the same counts; best estimate ~50–60k |

## 1. Origin gate ignores ports

### Takeaway
CONFIRMED. The gate compares bare hostnames: `named_host` keeps only the text before the first `:` and validates the port solely for being digits, and `is_loopback_name` accepts `localhost`, `::1` and all of 127.0.0.0/8. A page served from any other loopback port, any 127/8 address, or a different scheme therefore passes the same-origin check. Empirically the tokenless server served the fleet, a full transcript and accepted an answer and a model change from `Origin: http://127.0.0.1:9999`; the token server did the same once the `ac_session` cookie was present. The earlier security note is correct; the audit's "must name loopback" description was right but did not note that loopback spans every port. Two earlier researchers disagreed only on emphasis, not on the code fact — both are reconciled: the gate is real and blocks `evil.example`, but it does not isolate by port/scheme among loopback origins.

### Cited Findings
- `named_host` drops the port: `let host = parts.next().unwrap_or("");` then `if let Some(port) = parts.next() { if parts.next().is_some() || !port.chars().all(|c| c.is_ascii_digit()) { return None; } }` returning the lowercased host — [routes.rs L468-480](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L468-L480). IPv6 path keeps only the bracketed host — [L462-466](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L462-L466); `hostname_of` dispatches — [L432-438](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L432-L438).
- A unit test pins the port-dropping: `assert_eq!(hostname_of(Some("http://127.0.0.1:4317")).as_deref(), Some("127.0.0.1"));` — [routes.rs L5703](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L5703). No test checks that a different-port Origin is refused; `serves_every_honest_spelling_of_loopback` varies only `Host` — [L4398-4414](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L4398-L4414).
- `is_loopback_name`: `localhost`/`::1` plus `^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$` — [routes.rs L489-505](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L489-L505); `is_self_name` = loopback OR `origin_names` — [L594-596](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L594-L596). `origin_names` is empty without a token — [L581-592](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L581-L592).
- `same_origin_request` checks `Origin` only when present and requires `Host` to be a self name — [routes.rs L598-612](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L598-L612).
- The gate's own doc comment states the intent that the port gap defeats: a token "says who is calling; this says the call was meant... a credential the browser attaches by itself, such as a cookie, rides along on a cross-origin request and proves nothing about intent." — [routes.rs L528-532](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L528-L532)
- The `ac_session` cookie value is the long-lived token itself, host-only (no `Domain`), `Max-Age` 30 days, `Secure` only behind `X-Forwarded-Proto: https` — [routes.rs L698-706](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L698-L706), [L624](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L624). `authorized` accepts it — [L752-756](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L752-L756).
- POST bodies are parsed as JSON regardless of `Content-Type` (`serde_json::from_slice`, no header check) — [routes.rs L1137-1142](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L1137-L1142).
- Empirical (tokenless :4400, `GET /api/agents`): no Origin → 200 (15 agents); `http://127.0.0.1:9999` → 200; `http://localhost:5173` → 200; `http://127.8.9.10:8080` → 200; `https://localhost:8443` → 200; `http://evil.example` → 403; `Origin: null` → 403; `Host: evil.example` → 403. WebSocket `/ws`: cross-port origins → 101; `evil.example` → 403.
- Empirical (tokenless :4400, socket from `Origin: http://127.0.0.1:9999`): first frames `fleet`(15)+`limits`; `focus` on `mock-waiting` returned a `timeline` with 15 conversation events and the pending `AskUserQuestion` id; an `answer` with the correct id produced no error (a stale id correctly produced `error`/`answer-refused`).
- Empirical (tokenless :4400): `POST /api/agents/mock-idle-kb/model` with `Content-Type: text/plain;charset=UTF-8`, body `{"value":"opus"}`, `Origin: http://127.0.0.1:9999` → `200 {"ok":true,"detail":"opus"}`; same from `Origin: http://evil.example` → 403.
- Empirical (token :4401): cross-port Origin, no credential → 401; `GET /?token=…` `Accept: text/html` → 302 setting `ac_session`; cross-port Origin + `ac_session` cookie → 200 on HTTP and 101 (15-agent fleet) on the socket; `evil.example` + cookie → 403.
- Cookies are not port-isolated: "Cookies do not provide isolation by port. If a cookie is readable by a service running on one port, the cookie is also readable by a service running on another port of the same server" (§5.3); host-only matching requires identical hosts (§3.5); same-site = scheme + registrable domain via the HTML Standard — [RFC 6265bis draft](https://raw.githubusercontent.com/httpwg/http-extensions/main/draft-ietf-httpbis-rfc6265bis.md).
- Chrome LNA does not help: "`loopback` -> anything" is exempt — [WICG LNA explainer](https://github.com/WICG/local-network-access/blob/main/explainer.md), as cited in the team's permissions note.

### Inferences
- The gate blocks the network and foreign-domain pages, but does not distinguish among loopback origins. On a tokenless server (the default), script executing in the user's browser under any `http(s)://127.*/localhost:*` origin is treated as same-origin and can use the API — read fleet and transcripts, and (given the default grants) drive, answer and spawn. On a token server the same holds for any browser context that carries the cookie, because a host-only `SameSite=Strict` cookie is attached to same-site requests and same-site ignores port (spec inference; not browser-tested here). The realistic precondition is some other content executing on a loopback origin: a second local dev server pulling a compromised dependency, an XSS in any local web UI, or another local tool's browser page. For a same-user attacker the marginal gain is modest (they could already drive tmux directly); the sharper cases are a browser confused-deputy path and anything that can run web content but not arbitrary local commands.
- Fix shape (from the team's own note): compare full origins (scheme+host+port) against the server's own, and make the cookie an opaque server-mapped session id rather than the token verbatim.

### Gaps
- The cookie ride-along across loopback ports was not reproduced in a real browser; it rests on the cookie spec plus the server accepting the cookie from a cross-port Origin, which I did confirm by sending the cookie myself.

## 2. Tokenless default grants full access to a no-Origin local client

### Takeaway
CONFIRMED. With no `--token` (the default), `authorized()` returns `true` unconditionally, and a request with no `Origin` header passes the same-origin gate (an absent Origin is read as a non-browser client). Grants default to all four (read, respond, drive, spawn). So any local process that can reach the port and omits `Origin` — curl, a script, or a supervised agent doing `curl 127.0.0.1:PORT` — has the full API, including answering its own or a sibling's permission prompt and spawning agents.

### Cited Findings
- No token short-circuits auth: `let Some(token) = self.token.as_deref() else { return true; };` — [routes.rs L737-740](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L737-L740).
- Default bind is loopback and needs no token; a non-loopback `--host` is refused without one: `if !LOOPBACK.contains(&opts.host.as_str()) && opts.token.is_none()` — [options.rs L504-512](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/options.rs#L504-L512); default `grants: Grants::ALL` — [options.rs L191](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/options.rs#L191).
- An absent `Origin` is deliberately allowed: `same_origin_request` only checks it `if let Some(origin) = headers.get(header::ORIGIN)` — [routes.rs L598-607](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L598-L607); INV-3 states "Absent means a non-browser client... which is not what this guards" — [routes.rs L521-522](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L521-L522), [INVARIANTS.md L276-278](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L276-L278).
- The four grants and their HTTP mapping: spawn = `POST /api/agents`, `POST /api/terminals`, `/api/dirs`; drive = picture POST and every `control_route`; everything else read — [routes.rs L828-851](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L828-L851). Socket messages: `Answer`→Respond, `Paste`/`Key`→Drive — [routes.rs L1879-1891](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L1879-L1891).
- Empirical: `GET /api/agents` to tokenless :4400 with no Origin returned 200 with 15 agents; a no-Origin WebSocket upgraded to 101 and received the fleet. (probe.py)
- Grants are per server process, not per token or device: set once by `--grant` — [options.rs L394](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/options.rs#L394), default all. SPEC states the model: "Not multi-user. There are no accounts. A credential is a capability, not an identity" — SPEC.md.

### Inferences
- A supervised Claude Code agent on the same machine that can reach loopback can call this API with no Origin and so answer a permission prompt (its own or a sibling's) or spawn a new agent, under the default config. The server has no per-caller identity to distinguish the human from an agent. This is a privilege-boundary concern on shared hosts too: TCP loopback is not per-user, whereas tmux's socket directory is 0700. These are inferences from the code path; I confirmed the no-Origin acceptance and the answer path empirically, not an agent actually calling it.

### Gaps
- Whether a sandboxed Claude Code agent can reach loopback depends on its sandbox config (`network.allowLocalBinding`), which is out of this repo's scope.

## 3. No CSP, X-Frame-Options or frame-ancestors (clickjacking)

### Takeaway
CONFIRMED. No security/frame headers are set anywhere, and the document is served with only `Content-Type` and `Cache-Control`. The client has no frame-busting. `tower-http` is pulled in with the `set-header` feature but no header layer is wired into the router. In token mode, the `SameSite=Strict` host-only cookie would not be sent to a cross-site framing page (spec inference), which blunts clickjacking there; the tokenless page has no such protection.

### Cited Findings
- Document response sets only `Content-Type: text/html` and `Cache-Control` — [routes.rs L1100-1128](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L1100-L1128). Static files get only `Content-Type` (+ `Cache-Control` for html). Text/JSON helpers set only `Content-Type` — [L778-799](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L778-L799).
- Grep across `rust/src` for `Content-Security-Policy`, `X-Frame-Options`, `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy` returns nothing; no `.layer(`, `SetResponseHeader` or `tower_http` use in `rust/src`. `tower-http = { version = "0.6", features = ["fs", "set-header"] }` is declared but unused — [rust/Cargo.toml L18](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/Cargo.toml#L18).
- No frame-busting in the web client (grep for `window.top`, `frameElement`, `self !== top` in `src/web` returns nothing).
- Empirical: response headers on `GET /` were `content-type: text/html`, `cache-control: no-cache`, `content-length`, `connection`, `date` — nothing else. `GET /api/agents` had `content-type: application/json; charset=utf-8` plus `content-length/connection/date`. (probe.py)
- Token cookie is `HttpOnly; SameSite=Strict` — [routes.rs L705](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L705).

### Inferences
- The tokenless page is framable by another site; a frame's requests carry that frame's `Origin` (the other site's domain), which the gate refuses for reads — but a clickjacking overlay drives the user's own clicks inside the framed app, whose same-origin requests pass. So UI-redress against the tokenless page is not blocked at the header level. In token mode, the strict host-only cookie is not attached in a cross-site frame (spec inference), so a framed tokenless-less request is unauthenticated (401) — a meaningful mitigation that depends on running with a token. Not browser-tested.

## 4. INV-5's "agents still list from `claude agents --json`" fallback

### Takeaway
CONFIRMED that INVARIANTS.md's wording is misleading/contradicted by the code. The fleet of Claude agents is built only from `~/.claude/sessions/<pid>.json`. `claude agents --json` is used solely to produce a *set of session ids* that filters out ghosts; it never constructs a fleet entry. A renamed/removed required field (`sessionId`, `pid`, or `cwd`) in the session file drops that agent entirely — it does not fall back to listing from the CLI.

### Cited Findings
- Module doc: "`claude agents --json` is authoritative for presence, but costs ~680ms" and runs only on the slow reconcile — [registry.rs L1-13](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L1-L13).
- `to_agent` requires three fields or returns `None`: `let session_id = non_empty_field(file, "sessionId")?...; let pid = file.get("pid").and_then(|p| p.as_i64())?; let cwd = non_empty_field(file, "cwd")?...` — [registry.rs L195-198](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L195-L198). A record that fails is skipped — [L244-274](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L244-L274).
- `read_cli_session_ids` collects only ids: `rows.iter().filter_map(|r| r.get("sessionId")...)` into a `HashSet<String>` — [registry.rs L296-307](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L296-L307).
- `absorb` folds only session-file agents (`found`) into the map; the CLI set (`known`) is consulted via `is_unconfirmed` to decide whether to drop/hold — [registry.rs L492-533](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L492-L533). `reconcile` only swaps the id set and re-publishes — [L545-567](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/registry.rs#L545-L567).
- INVARIANTS.md's claim: "If it changes shape, agents must still list from `claude agents --json` — they simply lose the Attach tab." — [INVARIANTS.md L625-626](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/INVARIANTS.md#L625-L626).

### Inferences
- A shape change confined to *non-required* fields (e.g. `tmux`, `name`, `status`, `waitingFor`) degrades gracefully as INV-5 intends: the agent still lists, `attach_blocked_reason` is set, status falls to `unknown`. But a change to `sessionId`, `pid`, or `cwd` empties those agents from the fleet with no CLI fallback. The invariant text overclaims resilience; the degradation is field-dependent. (CLI-discovery of agents does not exist in this code — only id-set confirmation.)

## 5. Spawn permits `bypassPermissions` and `dontAsk`

### Takeaway
CONFIRMED. `SPAWN_MODES` = `default, acceptEdits, plan, bypassPermissions, auto, dontAsk`, and the new-agent dialog offers all six. The server validates the mode against this list and forwards it to `claude --permission-mode <mode>`. Nuance worth passing on: `bypassPermissions` and `auto` are the permissive ones; `dontAsk` is the opposite (pre-approved tools only, otherwise deny — a CI mode), so calling it "dangerous" would be wrong. The real exposure is that a spawn (available by default, and reachable by any same-origin/no-Origin caller) can start an agent that stops asking for permission.

### Cited Findings
- `pub const SPAWN_MODES: &[&str] = &["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk"];` — [types.rs L914-917](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/types.rs#L914-L917). `MODE_CYCLE` (Shift+Tab) omits `dontAsk` — [L910-913](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/types.rs#L910-L913).
- Spawn validates then forwards: `if !is_permission_mode(mode) { return Err(... "unknown permission mode") }` — [spawn.rs L136-139](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/spawn.rs#L136-L139); `argv.push("--permission-mode".into()); argv.push(mode...)` — [spawn.rs L195-198](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/spawn.rs#L195-L198). `is_permission_mode` → `is_spawn_mode` → `SPAWN_MODES.contains` — [options.rs L38-40](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/options.rs#L38-L40), [types.rs L931-933](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/types.rs#L931-L933).
- The dialog offers the full `SPAWN_MODES` (via `NEW_AGENT_MODES = SPAWN_MODES`): `{MODES.map((m) => <option ...>)}` — [NewAgentDialog.tsx L24, L101-111](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/components/NewAgentDialog.tsx#L24-L111); [modes.ts L18](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/lib/modes.ts#L18). Labels include `bypassPermissions`→"Bypass", `dontAsk`→"Don't ask" — [i18n.ts L382-384](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/lib/i18n.ts#L382-L384).
- Semantics (Claude Code docs, via team note): `bypassPermissions` = "Isolated containers and VMs only" and "offers no protection against prompt injection"; `dontAsk` = "pre-approved tools only; anything that would prompt is denied. Meant for CI." — [permissions_and_security.md L22-23, L44-46](file:///home/user/agent-commander/research_notes/Agent%20commander%20best%20practices%20review/permissions_and_security.md).
- The code names the risk itself: `grant_for` comment, "mode can cycle onto a permission mode that stops asking" — [routes.rs L845-848](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L845-L848).

### Inferences
- No warning or extra confirmation accompanies choosing `bypassPermissions` in the dialog (only a plain `<select>`). Combined with claims 2/6, a spawn request that reaches the server can start an agent that will not prompt again — the one genuinely dangerous option in the list. `dontAsk` being present is harmless (it is strictly more restrictive). The dialog does not prevent starting a `bypassPermissions` session in a working directory outside a container, which the CLI itself recommends against.

## 6. No step-up / extra confirmation distinguishing dangerous permission dialogs

### Takeaway
CONFIRMED. The answer path treats every permission dialog the same. Options are answered by a single digit press; there is no classification of the underlying command (e.g. an `rm` on a critical path) and no extra confirmation for a dangerous approval versus a routine one. The only confirmation in the card is `window.confirm` on the destructive `Escape` key (INV-6), which is about interrupting, not about approving a dangerous action. The server's checks are staleness/consistency checks (right prompt id, agent still waiting, pane shows the row), not danger checks.

### Cited Findings
- `press(choice)` sends the option index with a one-press latch and a toast; no risk branch — [AnswerCard.tsx L203-246](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/components/AnswerCard.tsx#L203-L246). The only `window.confirm` is for `Escape` — [L436-437](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/components/AnswerCard.tsx#L436-L437).
- The card shows a sandbox-escape note (`sandboxOff`) and the Bash command/summary, but these are display-only; pressing a numbered option is unaffected by them — [AnswerCard.tsx L270-296](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/components/AnswerCard.tsx#L270-L296).
- Server answer path validates id/status/pane only, not danger: `if agent.status != AgentStatus::Waiting`, fingerprint re-check, and `drawn_row_matches` for drawn rows — [routes.rs L1978-2036](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L1978-L2036).
- Claude Code's own protections against approving critical-path `rm`/`rmdir` live in the CLI, not here (team note) — [permissions_and_security.md L56-62](file:///home/user/agent-commander/research_notes/Agent%20commander%20best%20practices%20review/permissions_and_security.md).

### Inferences
- The app relies on the operator reading the shown command/pane before tapping, which matches the vendor evidence that per-action approval habituates (humans caught ~13.6% of injected dangerous commands, falling to ~5% after 50+ prompts) — [supervision_and_hitl.md L252-261](file:///home/user/agent-commander/research_notes/Agent%20commander%20best%20practices%20review/supervision_and_hitl.md), [Anthropic auto-mode](https://www.anthropic.com/engineering/claude-code-auto-mode). On a phone next to a push, this is exactly the rubber-stamping context. A `respond`-only credential can still approve a "Yes, and don't ask again" option (the card offers whatever the dialog drew), escalating future permissions. agent-commander's mitigation is showing the whole command, the sandbox note and the live pane — not a friction/step-up for dangerous approvals. Whether to add one is a design judgement, not a defect; the claim (no step-up exists) is factually correct.

## 7. `old-node-backend-branch` missing on origin

### Takeaway
CONFIRMED. `git ls-remote --heads origin` does not list `old-node-backend-branch`. Three docs cite it as the place the Node server is preserved. The pre-port Node code does still exist in history (commit a05da3c, parent of the port commit 11b7cb1, has 22 files under `src/server/`), so it is recoverable by commit — but not via the named branch the docs point readers to.

### Cited Findings
- Remote heads (2026-10-02): `chat/status-rail-answers-and-terminal-run`, `claude/new-session-3wcie4`, `dependabot/npm_and_yarn/multi-d0c2d048a7`, `dependabot/npm_and_yarn/undici-8.11.2`, `experiment/rust-backend`, `feat/research-top-six`, `feat/self-pacing-polls-e2e-and-colour-schemes`, `fix/code-review-findings`, `main`. No `old-node-backend-branch`.
- Docs cite it: AGENTS.md "preserved, working, on the `old-node-backend-branch` branch" — [AGENTS.md L53-55](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L53-L55); also ARCHITECTURE.md L759 and docs/HANDBOOK.md L757.
- The Node server exists at a05da3c (11b7cb1^): `git ls-tree a05da3c src/server/` lists 22 `.ts` files (browse.ts, cli.ts, control.ts, enrich.ts, ...). At a69ffe5, `src/` has only `src/shared` and `src/web`.
- Related doc drift the team's audit already flags: `.gitignore` says the Rust port "lives on `experiment/rust-backend`" and `rust/README.md`/`rust/PORT-CONTRACT.md` call the Rust server "parked" — [agent_commander_audit.md L379-382](file:///home/user/agent-commander/research_notes/Agent%20commander%20best%20practices%20review/agent_commander_audit.md).

## 8. AGENTS.md says the token is printed in full; code masks it

### Takeaway
CONFIRMED. AGENTS.md says the token "is still printed in full by `announce`". The code masks it to four characters unless `--print-url` is given. ARCHITECTURE.md and INVARIANTS.md describe the masking correctly, so AGENTS.md is the stale document.

### Cited Findings
- AGENTS.md: "The token still travels in the query string and is still printed in full by `announce`." — [AGENTS.md L332-333](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/AGENTS.md#L332-L333).
- `masked` keeps 4 chars + ellipsis; `MASK_VISIBLE_CHARS = 4` — [routes.rs L3040-3052](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L3040-L3052). `announce` prints `?token={}` as `if opts.print_url { t } else { masked(t) }`, and adds "token masked — run with --print-url for the whole link" unless `--print-url` — [routes.rs L3059-3075](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L3059-L3075).
- ARCHITECTURE.md describes the masking correctly: "`announce` masks to four characters unless asked with `--print-url`, and the token itself lives in a 0600 file" — [ARCHITECTURE.md L603-612](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/ARCHITECTURE.md#L603-L612). So AGENTS.md L332-333 is the one stale copy.
- Empirical: token server startup log read `agent-commander on http://127.0.0.1:4401/?token=s3cr…` then `token masked — run with --print-url for the whole link`. (probe.py; the token was `s3cretprobetoken…`, printed as `s3cr…`.)

## 9. Push notifications (push.rs)

### Takeaway
CONFIRMED on every sub-claim. A push fires only on a transition into `waiting` (first frame is backlog; standing blocks never re-fire; an inferred status is excluded twice). ntfy requests always set `Priority: high`. There is no completion/failure push, no cooldown/coalescing/quiet-hours, and failures are logged and not retried. Presence suppression depends only on a browser tab reporting itself visible on its heartbeat — terminal focus is not consulted. One addition to the earlier payload description: the session id is used as the notification `tag` field in the `Push` struct, but that tag is not emitted as an ntfy `Tags` header (ntfy `Tags` is the fixed string `raised_hand`); the session id only appears in the `Click` link.

### Push payload (exact fields)
- `Push { title, body, link, tag }` composed per agent — [push.rs L85-95, L150-161](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L85-L161):
  - `title` = `agent.name`.
  - `body` = `format!("Waiting on you — {reason}")` with `reason` = `agent.waiting_for`, else `"Waiting on you"`.
  - `link` = `Some(format!("{base}/agent/{session_id}"))` when `--notify-link` is set, else `None`.
  - `tag` = `agent.session_id` (used for logging and for channel de-dup intent).
- ntfy wire (`fn ntfy`) — [push.rs L192-207](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L192-L207): POST to the topic URL; headers `Title` (CR/LF stripped), `Tags: raised_hand` (constant), `Priority: high` (constant); body = `push.body`; `Click: <link>` only if a link; `bearer_auth(token)` from `AGENT_COMMANDER_NTFY_TOKEN` if present. The session id is not sent as an ntfy tag.
- Telegram wire (`fn telegram`) — [push.rs L209-221](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L209-L221): POST `https://api.telegram.org/bot<token>/sendMessage`, JSON `{chat_id, text: "<title>\n<body>"}`, plus an inline "Open" button with the link when present. Bot token from `AGENT_COMMANDER_TELEGRAM_TOKEN` or the 0600 file — [L48-72](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L48-L72).

### Cited Findings
- Transition-only + backlog + re-fire: `record` builds the blocked set, `let before = self.seen.lock().unwrap().replace(blocked.clone())?;` returns `None` on the first frame (backlog), then emits only ids in `blocked` but not in `before` — [push.rs L119-148](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L119-L148). A standing block is in both sets so it does not re-fire; unblock-then-block is news again.
- Inferred status excluded: filter is `a.status == AgentStatus::Waiting && a.status_inferred != Some(true)` — [push.rs L137-141](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L137-L141). And an inferred status can never be `waiting` in the first place (tmux_agents has no `waiting` branch) — INV-11.
- Presence = browser tab visibility only: the listener checks `if viewers.viewers.any_visible() { notifier.watched_on_screen(&agents); return; }` else push — [routes.rs L3162-3174](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L3162-L3174). `any_visible` reads a count bumped by `Pong { visible }` from the client — [routes.rs L349-362](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L349-L362), [L1812-1819](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/routes.rs#L1812-L1819); the client sends `pong {visible: onScreen()}` on each beat and on `visibilitychange` — [transport.ts L686, L874-881](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/src/web/store/transport.ts#L686-L881). Nothing reads tmux/terminal focus.
- No completion/failure push: `Notifier` only ever composes a `waiting` push; there is no "done"/"error" path. No cooldown/coalesce/quiet-hours: no timer, `Instant`, interval, debounce or throttle anywhere in push.rs (grep clean). Failures are logged, not retried: `eprintln!("agent-commander: push for {} not delivered: {why}", push.tag)` with the comment "a push that did not go is a push that did not go, and the next transition sends its own" — [push.rs L163-169](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L163-L169). One HTTPS request per push, 10s timeout — [L172-237](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/push.rs#L172-L237).

### Inferences
- Privacy: agent names (often derived from the opening prompt) and session ids leave the machine to a third party (ntfy.sh or Telegram) on every transition; an ntfy topic with no `AGENT_COMMANDER_NTFY_TOKEN` is effectively a public bearer URL. `--notify-link` also puts the dashboard's address (a tailnet hostname, in the intended phone flow) into the push.
- Because presence is tab-visibility only, a user watching the agent in the terminal but with no visible dashboard tab still gets pushed — the opposite of Remote Control's "at the terminal" suppression that the module comment invokes.

## 10. lock().unwrap() count and panic = "abort"

### Takeaway
CONFIRMED. The release profile sets `panic = "abort"`. I count 108 `.lock().unwrap()` in non-test code (plus 5 `.lock().expect(`), across 11 modules. Because the profile aborts on panic, a poisoned lock does not unwind — the whole single-process server aborts. There is no lock-poison recovery (`into_inner`, `PoisonError` handling) and no `RwLock`; all are `std::sync::Mutex`. A `catch_unwind` in `pane_hub` is explicitly documented as inert under abort.

### Cited Findings
- `[profile.release] ... panic = "abort"` (also lto, codegen-units=1, strip) — [rust/Cargo.toml L47-52](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/Cargo.toml#L47-L52).
- Non-test `.lock().unwrap()` by module (counting code before each file's `#[cfg(test)] mod tests`; `pane_props.rs` is entirely `#[cfg(test)]` and excluded): mock.rs 26, routes.rs 17, pane_hub.rs 17, registry.rs 15, tmux_client.rs 14, tmux_source.rs 6, limits.rs 4, pane.rs 4, poll.rs 2, usage.rs 2, push.rs 1 = **108**. Plus `.lock().expect(` ×5. (Measured by script over `rust/src/*.rs` with comment lines stripped.) Of these, mock.rs 26 run only in `--mock`.
- No poison handling / only `std::sync::Mutex`: grep for `into_inner`, `PoisonError`, `RwLock`, `parking_lot` in non-test code returns nothing.
- `catch_unwind` cannot catch under abort, and the code says so: "under `panic = "abort"` (the release profile) nothing can catch that — so this holds in dev and test, and listeners are expected not to panic" — [pane_hub.rs L341-347](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/rust/src/pane_hub.rs#L341-L347).

### Inferences
- The audit's "106" and my "108" differ only by counting boundary (both are "about 106-108"); the material point holds. Under `panic = "abort"`, any panic — a poisoned mutex after a thread panicked while holding it, an unexpected `unwrap`, an arithmetic panic — takes down the entire server process rather than one request/task. For a long-running single-process daemon this is a crash-on-any-bug posture. In production on macOS the launchd `KeepAlive` job restarts it (per AGENTS.md), so the practical effect is a restart (dropping all sockets and pane pollers) rather than a hang. There is no graceful per-task isolation. This is a robustness trade-off (abort gives smaller binaries and no unwind tables) with the cost that lock-poisoning is unrecoverable by design.

## 11. CI: action pinning and security scanning

### Takeaway
CONFIRMED. Every GitHub Action is pinned to a mutable major tag (`@v5`, `@v4`, `@v2`) and `dtolnay/rust-toolchain@stable` is a moving branch — none pinned to a commit SHA. There is no CodeQL, cargo-audit/deny, npm audit, OSV or dependency-review step in either workflow, and no `dependabot.yml` (though Dependabot PRs exist, so it is enabled at the org/repo-settings level). `ci.yml` has no top-level `permissions:` block; `npm-publish.yml` does (`contents: read`, with `id-token: write` scoped to the publish job for trusted publishing).

### Cited Findings
- `ci.yml` actions: `actions/checkout@v5`, `actions/setup-node@v5`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`, `actions/upload-artifact@v4` — [ci.yml L46-154](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/ci.yml#L46-L154). Triggers: push to branches + pull_request — [L27-35](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/ci.yml#L27-L35). No `permissions:` block, no `timeout-minutes` (grep clean).
- `npm-publish.yml`: same action tags; top-level `permissions: contents: read` — [L32-33](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/npm-publish.yml#L32-L33); publish job adds `id-token: write` — [L207-214](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/npm-publish.yml#L207-L214) (OIDC trusted publishing, no stored NPM_TOKEN). It runs `npm install -g npm@latest` before publish — [L228](https://github.com/ziweiwu/agent-commander/blob/a69ffe58bc269d02d236aa4c9e2583920ffa0070/.github/workflows/npm-publish.yml#L228).
- No scanners: grep for `codeql`, `cargo audit`, `cargo-audit`, `cargo deny`, `npm audit`, `osv`, `dependency-review`, `scorecard`, `trivy`, `semgrep`, `gitleaks` across `.github/` returns nothing. No `.github/dependabot.yml`/`.yaml`. The team audit notes two open Dependabot PRs (so Dependabot runs via repo settings) — [agent_commander_audit.md L205-209](file:///home/user/agent-commander/research_notes/Agent%20commander%20best%20practices%20review/agent_commander_audit.md).

### Inferences
- Mutable tags mean a compromised or retagged action version could enter a build; SHA-pinning plus Dependabot's `github-actions` ecosystem is the common hardening. `@stable` for the Rust toolchain also drifts. The absence of any SAST/dependency scanning means known-vuln dependencies (the open undici PR is one) are caught only by Dependabot's own alerts, not gated in CI. The publish workflow is the hardened part (least-privilege token, OIDC provenance).

## 12. Always-loaded instruction size (CLAUDE.md + AGENTS.md + INVARIANTS.md)

### Takeaway
Measured at a69ffe5: 3,286 lines, 34,423 whitespace-separated words, 205,721 Unicode characters (206,813 bytes; 557 non-ASCII). CLAUDE.md is a 2-line `@AGENTS.md`/`@INVARIANTS.md` import, so the weight is AGENTS.md (808 lines / ~8,104 words / 49,845 chars) and INVARIANTS.md (2,476 lines / ~26,317 words / 155,850 chars). The two earlier estimates (44–52k and 51–59k) are not a contradiction: they are different heuristics applied to the same text. A tokenizer-grade count was not possible here (the egress proxy blocks the tiktoken BPE download and MDN/web.dev), so this stays an estimate.

### Cited Findings
- File measurements (`wc` + a Python Unicode count):
  - CLAUDE.md: 2 lines, 2 words, 26 chars — it is `@AGENTS.md` / `@INVARIANTS.md`.
  - AGENTS.md: 808 lines, 8,104 words, 49,845 chars, 50,036 bytes.
  - INVARIANTS.md: 2,476 lines, 26,317 words, 155,850 chars, 156,751 bytes.
  - TOTAL: 3,286 lines, 34,423 words, 205,721 chars, 206,813 bytes.
- Heuristic token ranges on these counts:
  - words × 1.30 = 44,750; × 1.53 = 52,667; × 1.75 = 60,240.
  - chars ÷ 4.0 = 51,430; ÷ 3.5 = 58,777. bytes ÷ 4.0 = 51,703; ÷ 3.5 = 59,089.
- The 44–52k figure (team audit) ≈ words × 1.30–1.53; the 51–59k figure ≈ chars/bytes ÷ 4.0–3.5. Both are defensible rules of thumb.

### Inferences
- Reconciliation: the lower estimate is word-based, the higher is character/byte-based. English prose is ~1.3 tokens/word and ~4 chars/token, but this text is unusually punctuation- and code-dense (2,488 backticks; many identifiers, `file:line` and hyphenated invariant names), which pushes it toward the higher end — code/identifier-heavy text tends to run closer to 3.3–3.8 chars/token. So the realistic figure is the overlap-to-upper band, ~50–60k tokens, with ~55k a reasonable midpoint. Loaded into every session in this repo (CLAUDE.md imports both, and INVARIANTS.md also ships in the npm package `files`).

### Gaps
- No tokenizer count: `tiktoken` could not fetch `cl100k_base`/`o200k_base` (egress proxy 403), and no Anthropic token-count API key was available. The band above is heuristic; a true count needs the tokenizer offline.
