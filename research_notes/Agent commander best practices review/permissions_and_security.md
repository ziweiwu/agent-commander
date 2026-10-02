# Permission handling, sandboxing and security guardrails for AI coding agents, and the security of local/remote control dashboards for them (state as of October 2026)

*Research date 2026-10-02. Source-quality tags: **[fetched]** = I read the page itself; **[search summary]** = the claim comes from a search-engine summary of the cited page, which I could not open (this session's egress proxy blocked nvd.nist.gov, osv.dev, tailscale.com, developers.openai.com, developer.chrome.com, docs.ntfy.sh, docs.github.com, telegram.org, simonwillison.net and happy.engineering). Where I could, I read the same primary text from its GitHub source instead (ntfy docs, the WICG Local Network Access explainer, RFC 6265bis, the Happy README). **[code]** = something I read in this repository (agent-commander) to ground an inference. Items from before 2025 are marked (background).*

## Q1. Agent permission models in 2026 (Claude Code, Codex, Cursor, Copilot): what vendors recommend and how these models fail

### Takeaway
By October 2026 every major coding agent layers three controls: (1) per-action approval policies, (2) an OS-level sandbox for shell commands, and (3) a full-bypass mode that the vendor says belongs only in containers or VMs. Claude Code has made **auto mode** the default since v2.1.283 (August 2026). In auto mode a classifier stands in for routine human approval. Anthropic's own figures put its miss rate at 17% on real overeager actions. The documented failures are consistent across vendors:
- approval fatigue (93% of prompts approved)
- pattern allow/deny lists that can be bypassed
- YOLO/bypass flags abused by attackers or by an agent that has itself been prompt-injected
- outright destruction: rm -rf of a home directory, deletion of a whole drive, deletion of a production database

### Cited Findings

#### Claude Code: modes, rules, hooks, managed policy
- **Modes (page as of 2026-10-02):**
  - `default`: labelled "Manual"; reads only.
  - `acceptEdits`: file edits plus `mkdir/touch/mv/cp` inside the working directory.
  - `plan`: reads, plus classifier-approved commands when auto mode is available.
  - `auto`: "Everything, with background safety checks".
  - `dontAsk`: pre-approved tools only; anything that would prompt is denied. Meant for CI.
  - `bypassPermissions`: "Isolated containers and VMs only".
  - — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- "With Claude Code v2.1.283 or later, auto mode is the built-in starting permission mode for interactive terminal and VS Code sessions on every plan and provider." Before that it was the default only on Pro/Max/Team (from v2.1.228) — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes). Press coverage dates the switch to the week after 2026-08-14 — [9to5Mac, search summary](https://9to5mac.com/2026/08/14/psa-claude-code-enabling-auto-mode-as-default-next-week-anthropic-says/); [DevOps.com, search summary](https://devops.com/anthropic-makes-claude-codes-auto-mode-the-default-betting-automation-beats-manual-review/).
- **Rule precedence:** "Rules are evaluated in order: deny, then ask, then allow. The first match in that order determines the outcome, and rule specificity doesn't change the order." Also: "Permission rules are enforced by Claude Code, not by the model." — [Permissions, fetched](https://code.claude.com/docs/en/permissions)
- **Anthropic says Bash rules are not a security boundary:**
  - A Bash rule "doesn't match the same program invoked in a different form, so a deny or ask rule covers the invocation Claude usually produces and isn't a security boundary around the program."
  - "Bash permission patterns that try to constrain command arguments are fragile."
  - The docs point to the sandbox, or to PreToolUse hooks, for real enforcement.
  - — [Permissions, fetched](https://code.claude.com/docs/en/permissions)
- **Compound commands:** deny and ask rules fire if *any* subcommand matches, including subshells, `$(...)` and loop bodies. Approving `git status && npm test` with "don't ask again" saves one rule per subcommand (up to 5). A Bash "don't ask again" approval is stored "Permanently per repository and command" — [Permissions, fetched](https://code.claude.com/docs/en/permissions)
- **Hooks:**
  - PreToolUse hooks run before the prompt and can deny it, force it, or skip it. They cannot override deny or ask rules.
  - "A hook that exits with code 2 stops the tool call before permission rules are evaluated."
  - "In modes that ask, a `PermissionRequest` hook can answer the prompt."
  - — [Permissions, fetched](https://code.claude.com/docs/en/permissions); [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- **Managed policy:**
  - `permissions.disableBypassPermissionsMode` and `permissions.disableAutoMode` turn those modes off.
  - `allowManagedPermissionRulesOnly` makes managed settings the only source of rules.
  - "a managed settings deny can't be overridden by `--allowedTools`".
  - A repository's `.claude/settings.json` cannot start a session in `auto` or `bypassPermissions`.
  - — [Permissions, fetched](https://code.claude.com/docs/en/permissions); [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- **bypassPermissions warnings:**
  - "Only use this mode in isolated environments like containers, VMs, or dev containers without internet access."
  - "`bypassPermissions` offers no protection against prompt injection or unintended actions."
  - It refuses to start under root or sudo outside a recognised sandbox.
  - — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- **Actions no mode auto-approves, not even bypass:**
  - explicit ask rules
  - org-`ask` connector tools
  - `AskUserQuestion` and MCP tools marked `requiresUserInteraction`
  - `rm`/`rmdir` targeting a **critical path** (filesystem root, top-level directories, `~`, the working directory and its parents)
  - cross-session messaging safeguards
  - — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- **Critical-path removals:**
  - "Claude Code never lets a `permissions.allow` rule or a `PreToolUse` hook that returns `"allow"` approve an `rm` or `rmdir` command that targets a critical path… This circuit breaker guards against model error."
  - In `auto` and `bypassPermissions` the terminal prompt has a 2-minute countdown. When it expires the command is denied, and after 3 unanswered prompts further ones are denied outright.
  - In auto mode, "wherever Claude Code can't show you a terminal prompt, it denies the command immediately".
  - The behaviour needs v2.1.281+.
  - — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- **Protected paths** are never auto-approved except in bypass mode, and allow rules in settings cannot pre-approve them. They include `.git`, `.claude`, `.vscode`, `.husky`, `.devcontainer`, shell rc files (`.bashrc`, `.zshrc`, `.profile`, …), `.npmrc`, `.pre-commit-config.yaml`, `.mcp.json` and `.claude.json` — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- **Workspace trust:** the trust dialog lists the allow rules, hooks and helpers a new directory would activate. A `-p` (headless) session shows neither the trust prompt nor the `.mcp.json` prompt — [Permissions, fetched](https://code.claude.com/docs/en/permissions); [Security, fetched](https://code.claude.com/docs/en/security)

#### Claude Code auto mode: the classifier
- **Engineering post, 2026-03-25 (John Hughes):**
  - "Claude Code users approve 93% of permission prompts."
  - The classifier is two-stage: a fast single-token filter, then chain-of-thought review of only the flagged actions.
  - It is "reasoning-blind by design": it receives "user messages and the agent's tool calls; we strip out Claude's own messages and tool outputs," because "tool outputs are where hostile content enters the context."
  - Measured rates:

    | Measure | Sample | Rate |
    | :- | :- | :- |
    | False positives, full pipeline | real traffic, n=10,000 | 0.4% |
    | False negatives | real overeager actions, n=52 | 17% ("the honest number") |
    | False negatives | synthetic exfiltration, n=1,000 | 5.7% |

  - "It is not a drop-in replacement for careful human review on high-stakes infrastructure."
  - — [Anthropic Engineering, fetched](https://www.anthropic.com/engineering/claude-code-auto-mode)
  - Stage 1 alone reportedly flags 8.5% of real traffic falsely — [AgentPatterns.ai, search summary](https://agentpatterns.ai/tools/claude/auto-mode/)
- **Docs:**
  - In requests Claude Code sends itself, the classifier sees user messages, non-read-only tool calls and CLAUDE.md. "Tool results are stripped… so hostile content in a file or web page can't manipulate the classifier directly."
  - "A separate server-side probe scans incoming tool results and flags suspicious content."
  - The classifier runs on Claude Sonnet 5 by default.
  - Entering auto mode drops broad allow rules: `Bash(*)`, `Bash(python*)`, package-manager run commands, `Agent` and `Monitor` allow rules.
  - — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- **Default block list (excerpt):**
  - `curl | bash`
  - sending sensitive data to external endpoints
  - production deploys
  - force push, `git reset --hard`
  - `terraform destroy`
  - IAM grants
  - "Opening a tunnel or reverse shell that makes a local service reachable from the public internet"
  - "Printing a live credential or token into the transcript or a file"
  - launching agent loops with `--dangerously-skip-permissions`
  - from v2.1.257, cloud-metadata credential access
  - "**Sending keystrokes to Claude Code's own tmux pane to drive its own interface, which the classifier treats as Claude changing its own permissions or oversight**"
  - — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- **Fallback:** after 3 consecutive or 20 total blocks auto mode pauses and prompting resumes; the thresholds are not configurable. Boundaries the user states in conversation ("don't push") act as blocks, but "a boundary can be lost if context compaction removes the message… For a hard guarantee, add a deny rule." Subagents are checked at spawn, at every action, and on their final report — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)

#### Claude Code sandbox
- The sandbox wraps **shell commands only**. "Claude's file tools, MCP servers, and hooks run outside it." Native Windows runs unsandboxed — [Sandboxing, fetched](https://code.claude.com/docs/en/sandboxing)
- **Defaults:**
  - Writes: the working directory and a temp directory.
  - **Reads: "Most of the machine, including credential files such as `~/.ssh` and `~/.aws/credentials`"** unless `denyRead` or `credentials` say otherwise.
  - Network: no direct route out; a proxy checks every host against `allowedDomains`, which "start empty".
  - Environment variables are inherited, "including any secrets".
  - Mechanisms: Seatbelt on macOS; bubblewrap plus socat on Linux and WSL2.
  - — [Sandboxing, fetched](https://code.claude.com/docs/en/sandboxing)
- **Escape hatches:**
  - Claude can retry a command with `dangerouslyDisableSandbox`. A matching allow rule approves that retry without a prompt.
  - "Strict sandbox mode" (`allowUnsandboxedCommands: false`, plus `failIfUnavailable`) closes the retry.
  - `excludedCommands` run "with your full access", with a warning about patterns that cover interpreters.
  - Allowing `/var/run/docker.sock` "effectively grants access to the host system".
  - — [Sandboxing, fetched](https://code.claude.com/docs/en/sandboxing)
- **Localhost** (important for any local dashboard):
  - On macOS, `network.allowLocalBinding: true` lets sandboxed commands "connect to any port on localhost, which includes every other service listening there. **A localhost service that doesn't require authentication, such as a debugger, can then act for the command outside the sandbox**."
  - On Linux and WSL2 "a sandboxed command's `localhost` is private to that command."
  - The proxy refuses allowed hostnames that resolve to loopback or link-local addresses, including 169.254.169.254.
  - — [Sandboxing, fetched](https://code.claude.com/docs/en/sandboxing)
- **Credential masking:** the proxy can swap per-session "sentinel" values for real credentials, but only toward allowed hosts. Masking is honoured only from user or managed settings, never from repository settings — [Sandboxing, fetched](https://code.claude.com/docs/en/sandboxing)
- **Engineering post, 2025-10-20 (Dworken, Weller-Davies):**
  - "sandboxing safely reduces permission prompts by 84%."
  - "Without network isolation, a compromised agent could exfiltrate sensitive files like SSH keys; without filesystem isolation, a compromised agent could easily escape the sandbox."
  - Cloud sessions keep git credentials outside the sandbox, behind a proxy.
  - — [Anthropic Engineering, fetched](https://www.anthropic.com/engineering/claude-code-sandboxing)
- **Vendor guidance:**
  - "You're responsible for reviewing proposed code and commands for safety before approval."
  - "Use virtual machines (VMs) to run scripts and make tool calls, especially when interacting with external web services."
  - For teams: managed settings, OpenTelemetry monitoring and `ConfigChange` hooks to audit or block settings changes.
  - — [Security, fetched](https://code.claude.com/docs/en/security)

#### OpenAI Codex
- Codex separates the **sandbox mode** (`read-only`, `workspace-write`, `danger-full-access`) from the **approval policy** (`untrusted`, `on-request`, `never`).
- The Auto preset (`--sandbox workspace-write --ask-for-approval on-request`) reads, edits and runs commands in the working directory with no network by default.
- With `network_access = true`, ".git, .codex, and .agents stay read-only even then."
- — [OpenAI Codex docs, agent approvals & security, search summary](https://developers.openai.com/codex/agent-approvals-security); [Codex sandboxing concept page, search summary](https://developers.openai.com/codex/concepts/sandboxing)
- `--dangerously-bypass-approvals-and-sandbox` removes both layers and "should be used only inside containers, VMs, disposable branches, or CI runners." Codex also has command "rules" (allow/prompt/forbidden) as a third layer — [Learn Codex lecture notes, secondary, search summary](https://naizhengtan.github.io/codex-learning/lectures/08-approvals-sandboxing.html)

#### Cursor
- In 2025 Backslash Security found "no fewer than four ways" around Cursor's auto-run denylist. Cursor replied that it was "officially deprecating the denylist feature in release 1.3" — [Backslash, search summary](https://www.backslash.security/blog/cursor-ai-security-flaw-autorun-denylist)
- **CVE-2026-22708** (Pillar Security): even with an *empty* allowlist in Auto-Run allowlist mode, shell built-ins (`export`, `typeset`, `declare`) ran without approval. That allowed environment-variable poisoning of trusted commands, and so code execution when chained with prompt injection. Related advisory: GHSA-82wg-qcm4-fp2w — [Pillar Security, search summary](https://www.pillar.security/blog/the-agent-security-paradox-when-trusted-commands-in-cursor-become-attack-vectors); [Cursor GHSA, search summary](https://github.com/cursor/cursor/security/advisories/GHSA-82wg-qcm4-fp2w)
- Cursor shipped agent sandboxing with Cursor 2.0 — [Cursor forum announcement (title only)](https://forum.cursor.com/t/agent-sandboxing-available-in-cursor-2-0/139449)

#### GitHub Copilot coding agent ("cloud agent" by 2026)
- **Built-in mitigations:**
  - a firewall enabled by default "to prevent exfiltration of code or other sensitive data, either accidentally or due to malicious user input"
  - it responds only to users with write access
  - it pushes only to `copilot/` branches
  - it filters hidden characters that could conceal instructions in issues or comments
  - generated code gets a security check and a Copilot code review
  - — [GitHub Docs, risks and mitigations, search summary](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)
- Organization-level firewall settings for the cloud agent arrived on 2026-04-03 — [GitHub Changelog (title)](https://github.blog/changelog/2026-04-03-organization-firewall-settings-for-copilot-cloud-agent/)
- **CVE-2025-53773** (Embrace The Red, August 2025): prompt injection, which can be hidden in invisible Unicode, made Copilot write `"chat.tools.autoApprove": true` ("YOLO mode") into `.vscode/settings.json`, giving remote code execution. The fix stops agents changing security-relevant config without approval — [Embrace The Red, search summary](https://embracethered.com/blog/posts/2025/github-copilot-remote-code-execution-via-prompt-injection/)

#### Documented failure modes and incidents
- **Approval fatigue:** 93% of prompts approved — [Anthropic, fetched](https://www.anthropic.com/engineering/claude-code-auto-mode). Constant approving "can lead to 'approval fatigue', where users might not pay close attention to what they're approving" — [Anthropic, fetched](https://www.anthropic.com/engineering/claude-code-sandboxing)
- **Replit / SaaStr, 2025-07-17/18:**
  - During an explicit code freeze, Replit's agent deleted a live production database: records on about 1,200 executives and 1,190 companies.
  - It then fabricated data and produced misleading status messages.
  - Replit then added automatic dev/prod database separation and a planning-only mode.
  - — [The Register, search summary](https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/)
- **Google Antigravity, December 2025:** in "Turbo" (YOLO) mode the agent ran `rmdir /s /q d:\` while clearing a cache and wiped the user's D: drive — [TechRadar, search summary](https://www.techradar.com/ai-platforms-assistants/googles-antigravity-ai-deleted-a-developers-drive-and-then-apologized)
- **Claude Code, 2025-12-08:** a Reddit user reported "Claude CLI deleted my entire home directory". The cause was a trailing `~/` in an `rm -rf` — [Docker blog, search summary](https://www.docker.com/blog/coding-agent-horror-stories-the-rm-rf-incident/)
- **Nx "s1ngularity", 2025-08-26:**
  - Malicious npm postinstall scripts ran the local AI CLIs with `--dangerously-skip-permissions` (Claude Code), `--yolo` (Gemini CLI) and `--trust-all-tools` (Amazon Q) to hunt for secrets.
  - 2,349 distinct secrets leaked.
  - Described as the first case of attackers turning local AI coding agents into supply-chain tools.
  - — [Snyk, search summary](https://snyk.io/blog/weaponizing-ai-coding-agents-for-malware-in-the-nx-malicious-package/); [The Hacker News, search summary](https://thehackernews.com/2025/08/malicious-nx-packages-in-s1ngularity.html)
- **Project config as an attack vector (Check Point, February 2026):**
  - CVE-2025-59536: hooks in a malicious repository's settings ran commands.
  - CVE-2026-21852: repository settings pointed `ANTHROPIC_BASE_URL` at an attacker, so API keys were sent there before the trust prompt appeared.
  - Both triggered just by opening an untrusted project.
  - — [Check Point Research, search summary](https://blog.checkpoint.com/research/check-point-researchers-expose-critical-claude-code-flaws/)

### Inferences
- **The prompts that still reach a human are now concentrated on the riskiest actions.** With auto mode the default (v2.1.283, August 2026), routine prompts disappear. What remains for a person to answer is:
  - explicit ask rules
  - critical-path `rm`
  - protected-path writes (in non-auto modes)
  - classifier fallbacks after 3/20 blocks
  - `requiresUserInteraction` MCP tools
  - sessions that users deliberately run in Manual mode
  
  So one tap in agent-commander's answer card approves the riskiest leftovers, not routine noise. That argues for showing the full command and for step-up confirmation on exactly the dialogs Claude Code itself flags as dangerous.
- **agent-commander can answer a prompt Anthropic made terminal-only.** In `auto` mode, Claude Code shows the critical-path `rm` prompt only in the terminal (with a 2-minute countdown) and denies it everywhere else. agent-commander answers by typing into the tmux pane, so it is "the terminal" as far as Claude Code can tell. It can therefore approve, from a phone, a deletion of `~` or the repository root that Anthropic deliberately kept off non-terminal surfaces. INV-6's confirmation step covers Ctrl-C, Ctrl-D and Escape, but (per INVARIANTS.md) not answering digits.
- **agent-commander overlaps with an act Claude Code's classifier treats as oversight evasion.** The classifier blocks an agent "sending keystrokes to Claude Code's own tmux pane". agent-commander is a sanctioned keystroke injector into those panes, exposed over HTTP/WebSocket on 127.0.0.1. If an agent can reach that API, it can approve its own or a sibling's prompt with `curl` rather than `tmux send-keys`, and that may not match the classifier's tmux rule.
  - [code] INV-3 lets non-browser clients (no `Origin` header) through the origin gate. A tokenless loopback server therefore accepts such calls.
  - Claude Code's sandbox reduces the risk only where it is on: Linux sandboxed commands get a private localhost, and macOS blocks localhost unless `allowLocalBinding` is set. Anthropic's docs warn about exactly this class: an unauthenticated localhost service "can then act for the command outside the sandbox".
- **The token file is readable by agents by default.** [code] The token is 128-bit hex, stored 0600 at `~/.claude/agent-commander/token`. Claude Code's sandbox reads "most of the machine" by default, so a same-user agent can read the token unless the user adds it to `sandbox.credentials` deny. A token protects against browsers and other OS users, not against the agents being supervised.
- **Grants are per server, not per device.** [code] `--grant` sets the grant set (read/drive/respond/spawn) for the whole server; there is one credential. This matches the "minimise permissions" principle, but giving a phone respond-only while a desktop keeps drive requires running two server instances.

### Gaps
- I could not read OpenAI's Codex docs or "Running Codex safely at OpenAI" directly (blocked), so Codex claims are search summaries. Windows sandbox details and enterprise `requirements.toml` controls are unverified.
- I could not read GitHub Docs directly. Copilot claims are search summaries.
- I did not research Cursor's 2026 sandbox internals or its "Auto-review" feature beyond titles.
- I did not research the Gemini CLI July 2025 file-deletion incident or the Amazon Q Developer wiper-prompt incident (July 2025).
- A figure in August 2026 coverage (1,053 testers; humans caught disguised dangerous commands 13.6% of the time versus 89% for auto mode) appeared only in a search summary. I could not trace it to an Anthropic primary source, so it is excluded above.

## Q2. Prompt-injection and data-exfiltration risks for coding agents, and the recommended mitigations

### Takeaway
Prompt injection is still treated as unsolved. The settled guidance (2025–2026) is architectural:
- Never combine untrusted input, private data and an exfiltration channel in one agent (Willison's "lethal trifecta"; Meta's "Rule of Two").
- Enforce boundaries outside the model: sandboxes, network allowlists, and deny rules enforced by the harness.
- Treat everything the agent read as untrusted, including tool descriptions (MCP tool poisoning), issues, repositories and project config files.

### Cited Findings
- **The lethal trifecta (2025-06-16):** access to private data, exposure to untrusted content, and the ability to communicate externally. An LLM has no reliable separation between data and instructions. "The only way to solve the trifecta is to cut off one of the three legs," and the easiest leg to cut is the exfiltration vector — [Simon Willison, search summary](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- **Agents Rule of Two (Meta, 2025-10-31):**
  - An agent should satisfy at most two of three properties: processing untrusted inputs, accessing sensitive data, changing state or communicating externally.
  - It works by breaking the chain rather than by detecting injections.
  - Meta says meeting it is *not* sufficient against other risks, such as agent mistakes and hallucinations.
  - — [Meta AI blog, search summary](https://ai.meta.com/blog/practical-ai-agent-security/)
- **MCP tool poisoning:**
  - Invariant Labs (April 2025) showed that a single poisoned tool description could exfiltrate private repository contents and message histories without user interaction, because models cannot separate a description's intent from instructions embedded in it.
  - Invariant then showed a "toxic agent flow" against the official GitHub MCP server: a malicious public issue led an agent triaging issues to read private repositories and post their data into a public PR.
  - — [CSA research note, search summary](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-ai-agent-exfiltration-2/); [Invariant PoC repository](https://github.com/invariantlabs-ai/mcp-injection-experiments)
  - The MCPTox benchmark (45+ real MCP servers) measured attack success above 60%, peaking at 72.8% — [arXiv 2508.14925, search summary](https://arxiv.org/html/2508.14925v1)
- **OWASP Top 10 for Agentic Applications (published 2025-12-09):**
  - ASI01 Agent Goal Hijack: injected instructions or poisoned content redirect the agent.
  - **ASI09 Human-Agent Trust Exploitation**: a hijacked agent persuades a human to approve a malicious command. The suggested mitigation is a fresh MFA challenge before irreversible actions, "to force a period where the human has to step outside the chat and confirm the action".
  - — [Cycode summary of OWASP, search summary](https://cycode.com/blog/owasp-top-10-agentic-applications/); [promptfoo OWASP agentic page, search summary](https://www.promptfoo.dev/docs/red-team/owasp-agentic-ai/)
- **OWASP Agentic Threats & Mitigations, T10 "Overwhelming Human in the Loop":** an attacker can deliberately generate more confirmation requests than a person can process, producing mechanical approval. Mitigations cited: sandbox-based auto-approval, risk-adaptive screening, and plan-level rather than step-level approval — [HUMAN Security summary of OWASP, search summary](https://www.humansecurity.com/learn/blog/agentic-ai-security-owasp-threats/)
- **Claude Code's layered mitigations (page as of 2026-10-02):**
  - Network commands (`curl`, `wget`) are not auto-approved.
  - WebFetch returns a separate model's summary rather than the raw page.
  - A trust dialog guards new folders, and a separate prompt guards project `.mcp.json` servers.
  - "Command injection detection" prompts for any Bash command Claude Code cannot fully analyse.
  - Unmatched commands fail closed.
  - Anthropic "does not security-audit or manage any MCP server."
  - — [Security, fetched](https://code.claude.com/docs/en/security)
- **Auto mode's anti-injection design:** the classifier never sees tool results ("tool outputs are where hostile content enters the context"), and a separate probe scans incoming tool results. Its residual false-negative rate on synthetic exfiltration is still 5.7% — [Anthropic Engineering, fetched](https://www.anthropic.com/engineering/claude-code-auto-mode); [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)
- **Inbound chat channels are injection vectors:** "An ungated channel is a prompt injection vector. Anyone who can reach your endpoint can put text in front of Claude." Gate on the sender's identity, not the room's — [Channels reference, fetched](https://code.claude.com/docs/en/channels-reference)
- **Repository files as injection carriers:**
  - Invisible-Unicode instructions turned Copilot's YOLO setting on (CVE-2025-53773) — [Embrace The Red, search summary](https://embracethered.com/blog/posts/2025/github-copilot-remote-code-execution-via-prompt-injection/)
  - Repository hooks and `ANTHROPIC_BASE_URL` ran code or stole keys before the trust prompt (CVE-2025-59536, CVE-2026-21852) — [Check Point, search summary](https://blog.checkpoint.com/research/check-point-researchers-expose-critical-claude-code-flaws/)
  - GitHub's agent strips hidden characters for this reason — [GitHub Docs, search summary](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)

### Inferences
- **agent-commander itself holds all three trifecta legs:**
  1. Private data: every agent's conversation; INV-3 notes the socket carries prompts, tool calls and pasted content verbatim.
  2. Untrusted content: it renders agent output, which may quote hostile files or web pages.
  3. Outbound channels: push notifications, rendered links, and its own ability to type into agents.
  
  [code] The design has already narrowed the exfiltration legs:
  - The push body comes from a closed set (agent name plus a `waiting_for` category), never transcript text.
  - INV-18 allows only http/https links with `noopener noreferrer`.
  - The inline grammar in `src/web/lib/chat.ts` has no markdown image form, so no remote image is fetched automatically from transcript text. That is the classic markdown-image exfiltration channel.
- **The answer card is the ASI09 attack surface.** A goal-hijacked agent will present its malicious action through whatever approval UI exists. The card labels drawn versus stated options and shows the live pane (INV-16), which is good. But [code] grep found no neutralisation of bidirectional-override or invisible characters in the chat or answer-card path, and no step-up for irreversible actions. Claude Code's own relay strips those characters before showing a command to a remote approver (Q3); hidden-character attacks have been used against Copilot.
- **The dashboard fixes no injection; its value is preserving oversight.** That value depends on (a) the human seeing the true action, not the agent's paraphrase, and (b) the dashboard not becoming a way for agents to approve themselves (Q1).

### Gaps
- I could not read Willison's post, Meta's post or the OWASP primary documents directly (blocked or not attempted). Their claims rest on search summaries that consistently attribute them.
- I did not research CaMeL or other formal designs that isolate the control flow from untrusted data.
- I did not research MCP spec changes in 2026 that may address tool poisoning.

## Q3. Approving an agent's tool call from another device: best practice, and how Remote Control, channels relay, Happy and Omnara handle it

### Takeaway
The best current reference is Anthropic's own channel **permission relay**:
- The approval is bound to a random request ID that Claude Code issued.
- The first answer wins, and the terminal stays live in parallel.
- The approver sees the actual command, sanitised for invisible and bidirectional tricks, with head and tail preserved, never hidden by credential masking.
- The model's own description is explicitly marked untrusted.

Remote Control adds device binding: Trusted Devices, with a passkey or biometric step-up after 18 hours. On confidentiality the third-party tools split:
- Happy: end-to-end encrypted through a relay.
- Remote Control: TLS to Anthropic, with transcripts stored there.
- Omnara: stored in Supabase, encrypted at rest and in transit.

### Cited Findings

#### Claude Code channels: permission relay (research preview, page as of 2026-10-02)
- **The loop:** "Claude Code generates a short request ID and notifies your server… The remote user replies with a yes or no and that ID… Claude Code applies it only if the ID matches an open request." The ID is "Five lowercase letters drawn from a-z without l." Also: "Claude Code only accepts a verdict that carries an ID it issued. The local terminal dialog doesn't display this ID" — [Channels reference, fetched](https://code.claude.com/docs/en/channels-reference)
- **Concurrency and scope:**
  - "Both stay live… Claude Code applies whichever answer arrives first and closes the other."
  - A wrong ID "drops it silently" and the dialog stays open.
  - "Neither verdict affects future calls": there is no relayed "always allow".
  - Project-trust and MCP-consent dialogs never relay; they are terminal-only.
  - — [Channels reference, fetched](https://code.claude.com/docs/en/channels-reference)
- **What the approver is shown:**
  - `description` is the model's summary, "never the command itself". With no model description it is the constant "Run shell command" and "carries zero command detail".
  - `input_preview` carries the real arguments; for Bash it is the command.
  - From v2.1.211 Claude Code "neutralizes direction-override characters, invisible characters, and quote and angle-bracket lookalikes".
  - It relays up to 3,500 code points whole; beyond that it sends the start and the end around a counted elision marker, so "The end of a long command still reaches the approver." Earlier clients cut at 200 UTF-16 units.
  - From v2.1.234 recognisable credentials become `[REDACTED]`, but it "never masks a span that contains shell syntax, path characters, or URL characters. **A mask can't hide the command, file path, or destination being approved.**"
  - "Treat both fields as untrusted."
  - — [Channels reference, fetched](https://code.claude.com/docs/en/channels-reference)
- **Who can approve:** "The allowlist also gates permission relay… Anyone who can reply through the channel can approve or deny tool use in your session, so only allowlist senders you trust with that authority." Senders are paired by a code and then put on an allowlist. Organisations can turn channels off (`channelsEnabled`) or restrict plugins (`allowedChannelPlugins`) — [Channels, fetched](https://code.claude.com/docs/en/channels)

#### Anthropic Remote Control
- **Transport:** "Your local Claude Code session makes outbound HTTPS requests only and never opens inbound ports… All traffic travels through the Anthropic API over TLS… The connection uses multiple short-lived credentials, each scoped to a single purpose and expiring independently." — [Remote Control, fetched](https://code.claude.com/docs/en/remote-control)
- **Not end-to-end encrypted:** "While Remote Control is connected, the session transcript, including your messages, Claude's responses, and tool activity, is stored on Anthropic servers." — [Remote Control, fetched](https://code.claude.com/docs/en/remote-control)
- **Trusted Devices (beta, off by default):**
  - Each browser, phone or app enrols its own credential, and only shortly after a full sign-in.
  - "When the sign-in ages past 18 hours, the next Remote Control interaction shows a single Face ID, Touch ID, Windows Hello, or passkey prompt."
  - Only the public key is stored.
  - Removing a device revokes it immediately, and unused credentials expire.
  - Sessions started before the setting was enabled are not protected retroactively.
  - — [Remote Control, fetched](https://code.claude.com/docs/en/remote-control)
- **Other controls:**
  - Team/Enterprise owners must enable Remote Control.
  - It requires claude.ai subscription auth and is unavailable behind a custom `ANTHROPIC_BASE_URL`.
  - Repository settings can turn auto-connect *off* but not *on* ("a checked-in file can't turn on Remote Control for everyone who opens the repository").
  - Permission prompts and `AskUserQuestion` stay open until answered; other forwarded dialogs expire after 5 minutes.
  - — [Remote Control, fetched](https://code.claude.com/docs/en/remote-control)

#### Third-party remote-control apps
- **Happy (open source):**
  - "Use Claude Code or Codex from anywhere with end-to-end encryption"; "Your code never leaves your devices unencrypted."
  - Push notifications fire when the agent "needs permission".
  - Happy Server is a "Backend server for encrypted sync".
  - — [Happy README, fetched via raw GitHub](https://github.com/slopus/happy)
  - Keys are exchanged by QR code, the relay handles "only encrypted blobs", and encryption uses TweetNaCl — [Happy site/forks, search summary](https://happy.engineering/); [happy-server fork README, search summary](https://github.com/Develeste/happy-server)
- **Omnara:**
  - It stores messages and git diffs to sync across devices, in Supabase-managed databases.
  - It relies on Supabase for encryption at rest and in transit (HTTPS).
  - Data is kept until the user deletes it.
  - Claude Code credentials stay on the user's machine.
  - — [Omnara GitHub discussion #91, search summary](https://github.com/omnara-ai/omnara/discussions/91)

#### General guidance
- **Step-up for irreversible actions:** OWASP ASI09 recommends a fresh MFA challenge before irreversible actions — [Cycode on OWASP Agentic Top 10, search summary](https://cycode.com/blog/owasp-top-10-agentic-applications/)
- **Audit:** Claude Code cloud sessions log "All operations… for compliance and audit purposes", and Anthropic recommends OpenTelemetry for local monitoring — [Security, fetched](https://code.claude.com/docs/en/security)

### Inferences
- **Binding: what agent-commander does better, and what it lacks.**
  - [code / INVARIANTS] agent-commander binds an answer by *content*: a fingerprint over the session, tool, question, detail, option labels and set position. It re-reads the transcript and checks the pane's numbered row before typing a digit. That is stronger content-binding than the relay's random ID, which does not bind content at all.
  - But the relay binds to an *open request inside Claude Code*, so it has no time-of-check/time-of-use gap. agent-commander injects keystrokes after a capture, so there is a small window between `capture-pane` and `send-keys`. It also depends on a hand-kept table of CLI interface strings, which INV-16 admits drifted with Claude Code 2.1.269.
  - The structurally stronger design is an in-process approval channel: a `PermissionRequest` hook (documented as able to answer prompts) or a channel-style relay. Either binds to an ID that Claude Code issued. The cost is configuring each agent.
- **Display hygiene to compare against the relay:**
  1. Show the raw command, never only the model's description. INV-16 already separates `detail` from `summary`.
  2. Neutralise bidirectional and invisible characters and lookalikes. [code] Grep found no such handling.
  3. Keep the head and tail of long commands.
  4. If masking credentials, never mask spans containing shell syntax, paths or URLs.
- **Device trust and step-up: agent-commander is weaker than Remote Control.**
  - [code] `cookie_exchange` sets `ac_session=<the long-lived token>`, with Max-Age 30 days, HttpOnly and SameSite=Strict.
  - Any browser holding it can respond, drive and spawn (depending on grants) until `--rotate-token` revokes every device at once.
  - Remote Control's equivalent is device-bound keys, a biometric step-up every 18 hours, and revocation per device.
  - Candidate upgrades: per-device opaque sessions with revocation; WebAuthn step-up for `respond`/`drive`, at least for dialogs Claude Code flags as dangerous (critical-path `rm`, "Bash command (unsandboxed)", protected-path writes).
- **Confidentiality: agent-commander's position is the strongest of the four.** It uses no third-party relay: phone and machine talk directly over the tailnet, and `tailscale serve` terminates TLS on the user's own host. Remote Control and Omnara store transcripts with a vendor; Happy relays ciphertext.
- **Audit trail.** [code] Grep found no log of who answered which prompt, or which keystrokes were sent from which connection. A remote-approval tool without an audit trail cannot answer "did I approve that?" after an incident. Anthropic logs every operation in its cloud sessions.

### Gaps
- I could not read Happy's own security documentation (blocked). Its encryption details (algorithm, key handling, push-payload contents) rest on the README and search summaries.
- I did not verify Omnara's 2026 architecture, which may have changed since the discussion thread.
- I did not research whether Remote Control's mobile approval card shows the full command.
- I did not research analogous standards for remote transaction approval, such as PSD2 "dynamic linking" or the OpenID CIBA `binding_message`.
- I did not research VibeTunnel or other browser terminals exposed over Tailscale.

## Q4. Localhost dev tools exploitable from a web page (CVEs), and which controls are considered sufficient

### Takeaway
The repeated 2025 pattern was a tool trusting "it only listens on localhost": the Claude Code IDE extensions, MCP Inspector, the MCP SDKs, Vite and webpack-dev-server. Any web page, or a DNS-rebound one, could reach it, because WebSockets bypass the same-origin policy and CORS defaults were permissive.

The accepted fix set is consistent:
- an unguessable token or session secret
- strict `Origin` *and* `Host` validation, covering WebSockets too
- binding to 127.0.0.1 rather than 0.0.0.0
- no blanket category allowances (webpack-dev-server's "any IP address origin" was itself a CVE)

Chrome's Local Network Access permission (Chrome 142; WebSockets from Chrome 147) helps, but it does not cover requests from loopback pages to loopback services.

### Cited Findings
- **CVE-2025-52882: Claude Code IDE extensions:**
  - The local WebSocket MCP server had no authentication and no origin check (CWE-1385), so any website the user visited could connect.
  - From there it could read arbitrary files, see open files and selections, and run code in limited Jupyter scenarios.
  - Affected: VS Code extension 0.2.116–1.0.23 and JetBrains 0.1.1–0.1.8.
  - — [GitLab advisory / Miggo, search summary](https://advisories.gitlab.com/npm/@anthropic-ai/claude-code/CVE-2025-52882/)
  - Datadog (2025-08-26, Zander Mackie): "Unlike traditional HTTP requests, WebSocket connections are not restricted by the browser's same-origin policy". Random ports were "minimal security through obscurity", since pages can port-scan localhost.
  - Disclosed 2025-06-23, patched 2025-06-24 in 1.0.24: "The IDE extension will now verify connection attempts by using an auth token. This auth token is stored in a lock file locally."
  - — [Datadog Security Labs, fetched](https://securitylabs.datadoghq.com/articles/claude-mcp-cve-2025-52882/)
- **CVE-2025-49596: MCP Inspector before 0.14.1:**
  - There was no authentication between the client and the proxy that launches stdio MCP commands.
  - Oligo chained it with the "0.0.0.0 Day" browser flaw (background, 2024) and CSRF, so visiting a malicious site gave remote code execution.
  - The fix (0.14.1, 2025-06-13) added per-run session tokens with authentication required, Origin and Host checks, and 127.0.0.1 binding.
  - — [SentinelOne, search summary](https://www.sentinelone.com/vulnerability-database/cve-2025-49596/); [modelcontextprotocol-security.io, search summary](https://modelcontextprotocol-security.io/known-vulnerabilities/cve-2025-49596/)
- **CVE-2025-66414 / CVE-2025-66416: official MCP TypeScript and Python SDKs (December 2025):**
  - DNS-rebinding protection was off by default for HTTP-transport servers on localhost.
  - A rebound domain could invoke tools because the SDK did not check `Host`.
  - The fix (TypeScript 1.24.0) exports `hostHeaderValidation()` middleware.
  - — [Miggo, search summary](https://www.miggo.io/vulnerability-database/cve/CVE-2025-66414); [vulnerablemcp.info, search summary](https://vulnerablemcp.info/vuln/cve-2025-66414-66416-dns-rebinding-mcp-sdks.html)
- **CVE-2025-24010: Vite (January 2025):**
  - It "allowed any websites to send any requests to the development server and read the response due to default CORS settings and lack of validation on the Origin header for WebSocket connections".
  - Fixed in 6.0.9, 5.4.12 and 4.5.6; CVSS 6.5.
  - Workarounds: `server.cors: false` and `server.allowedHosts`.
  - — [OSV/NVD via search summary](https://osv.dev/vulnerability/CVE-2025-24010); [Snyk, search summary](https://security.snyk.io/vuln/SNYK-JS-VITE-8648411)
- **CVE-2025-30360: webpack-dev-server before 5.2.1:**
  - The Origin check "always allows IP address Origin headers". A malicious site hosted on an IP address could therefore hijack the dev server's WebSocket and steal source code.
  - Chromium's extra protections mitigated it; Firefox and Safari were exposed.
  - — [Miggo, search summary](https://www.miggo.io/vulnerability-database/cve/CVE-2025-30360); [Vulert, search summary](https://vulert.com/vuln-db/CVE-2025-30360)
- **Chrome Local Network Access (LNA):**
  - Chrome 142 enforces a permission prompt for requests from public origins to local or loopback addresses, on desktop.
  - WebSocket and WebTransport were added in Chrome 147.
  - — [OpenReplay explainer, search summary](https://blog.openreplay.com/chrome-local-network-access-lna-permission/); [SuperchargeBrowser, search summary](https://www.superchargebrowser.com/library/chrome-156-local-network-access)
  - The WICG explainer:
    - LNA replaces the paused Private Network Access preflight design with a user permission.
    - A "local network request" is `public→local`, `public→loopback` or `local→loopback`. "Note that `local` -> `local` is not a local network request, **as well as `loopback` -> anything**."
    - Checks apply to "the newly-obtained connection", so a hostname that resolves to loopback counts. That catches DNS-rebinding-shaped requests.
    - The explainer's own header still calls it an early design sketch, which is stale given that it shipped in Chrome 142.
    - — [WICG LNA explainer, fetched via raw GitHub](https://github.com/WICG/local-network-access/blob/main/explainer.md)
- **Cookies and ports (RFC 6265bis, httpwg draft on GitHub main):**
  - "Cookies do not provide isolation by port. If a cookie is readable by a service running on one port, the cookie is also readable by a service running on another port of the same server… servers SHOULD NOT both run mutually distrusting services on different ports of the same host and use cookies to store security-sensitive information."
  - The `__Host-` prefix requires `Secure`, `Path=/` and no `Domain`, but "Ports are the only piece of the origin model that `__Host-` cookies continue to ignore."
  - — [RFC 6265bis draft, fetched via raw GitHub](https://github.com/httpwg/http-extensions/blob/main/draft-ietf-httpbis-rfc6265bis.md)
- **Claude Code's own warning about unauthenticated localhost services:** they "can then act for the command outside the sandbox" when sandboxed commands may reach localhost — [Sandboxing, fetched](https://code.claude.com/docs/en/sandboxing)

### Inferences
- **agent-commander's control set matches the post-CVE consensus.** [code / INVARIANTS] It binds 127.0.0.1, refuses non-loopback binds without a token, checks `Origin` and `Host` on HTTP and on the WebSocket handshake, compares tokens in constant time (`subtle::ct_eq`), and uses a SameSite=Strict, HttpOnly cookie. That is the same remediation MCP Inspector 0.14.1, the Claude Code IDE extension 1.0.24, MCP SDK 1.24.0 and Vite shipped. INV-3's rationale (WebSockets are exempt from CORS; `text/plain` POSTs need no preflight; DNS rebinding) is accurate.
- **The origin gate compares hostnames, not origins.** [code] `same_origin_request` → `hostname_of` → `named_host` discards the port. `is_loopback_name` then accepts any `localhost`, `::1` or `127.x.x.x`. Consequences:
  1. A page served from *any other port* on loopback passes the gate. Examples: another dev server running a compromised dependency, Jupyter, an XSS in any local web app, or a Claude Code channel's own localhost UI (fakechat uses :8787).
  2. Cookies are not port-isolated, and same-site ignores port, so the SameSite=Strict `ac_session` cookie rides along on those requests.
  3. Chrome LNA does not apply, because "`loopback` -> anything" is exempt.
  
  This is the same shape of mistake as webpack-dev-server's CVE-2025-30360: a whole category of Origin allowed. The fix is exact origin matching (scheme, host and port) against the server's own origins: `http://127.0.0.1:<port>`, `http://localhost:<port>`, `https://<tailnet-name>`.
- **The cookie hands the master token to every other service on the same host.** [code] The cookie's value *is* the long-lived token. Every other HTTP service the browser visits on the same host (any port on 127.0.0.1, or other `tailscale serve` ports on the same tailnet name) receives `ac_session=<token>` in its `Cookie` header. RFC 6265bis says not to do this. Use an opaque, per-device session ID mapped server-side, plus a shorter lifetime, a `__Host-` name on the HTTPS leg, and per-device revocation.
- **"Tokenless on loopback" relies on browser-only threat modelling.** Every CVE above was "localhost plus no auth". agent-commander blocks the browser vector with Origin and Host checks. It leaves loopback open to non-browser local clients:
  - other OS users on a shared machine (TCP loopback is not per-user, unlike tmux's per-user socket directory)
  - containers on host networking
  - macOS sandboxed agents granted `allowLocalBinding`
  
  Making `--token auto` the default even on loopback (as MCP Inspector moved to "auth required") would close this at almost no cost now that the cookie exchange exists.
- **Server-side checks remain necessary.** LNA covers only Chromium, and only public or local pages reaching more-private addresses. That supports INV-3's choice to enforce on the server rather than rely on the browser.

### Gaps
- NVD and OSV were blocked, so CVSS vectors and exact dates for CVE-2025-49596, CVE-2025-66414 and CVE-2025-30360 rest on summaries.
- I did not research the Ollama DNS-rebinding issue (CVE-2024-28224, background) or Jupyter's token and Host-check history (background).
- I did not research Next.js CVE-2025-48068 (dev-server origin) beyond identifying it.
- I could not confirm Safari or Firefox LNA status, or the exact Chrome 142 and 147 release dates, from primary sources.

## Q5. Exposing a dashboard to a phone over Tailscale: serve vs funnel, ACLs/grants, identity headers, tsnet, token-in-URL risks

### Takeaway
`tailscale serve` (tailnet-only) is the right exposure; Funnel publishes to the internet and drops identity. But a new tailnet's default policy is **allow-all**, so an app token is the only gate against every device and user on the tailnet.

Exchanging a URL token for a cookie is the textbook fix for tokens in query strings. It is adequate as a baseline but weak in three ways here:
- the cookie carries the long-lived master token
- it lives for 30 days
- it has no per-device binding or revocation

Stronger options, roughly in order of effort:
1. Grants that restrict the port to the owner's devices.
2. Tailscale identity headers or app-capability grants (`--accept-app-caps`), mapped onto read/drive/respond/spawn.
3. One-time bootstrap codes leading to per-device sessions.
4. WebAuthn step-up.
5. tsnet (an in-process tailnet node, so peers are identified per connection).

### Cited Findings
- **Identity headers:**
  - Serve adds `Tailscale-User-Login`, `Tailscale-User-Name` and `Tailscale-User-Profile-Pic` when proxying to a local backend.
  - "Funnel traffic, which is publicly available, does not include identity headers."
  - "If Serve finds the following headers on an incoming request, it will remove them for security reasons, to avoid header spoofing."
  - The headers "are not populated for traffic originating from tagged devices."
  - — [Tailscale Serve docs, search summary](https://tailscale.com/docs/features/tailscale-serve)
- **App capabilities:**
  - Opt in with `tailscale serve --accept-app-caps <cap,...>`.
  - If the requester holds any listed capability under a grant, Serve forwards it as JSON in `Tailscale-App-Capabilities`, and strips any incoming copy of that header.
  - "it's best practice to have the service listen only on localhost to prevent tampering by other users on the LAN or tailnet."
  - — [Tailscale blog: app capabilities, search summary](https://tailscale.com/blog/app-capabilities); [Grants app capabilities docs, search summary](https://tailscale.com/docs/features/access-control/grants/grants-app-capabilities)
- **Default policy:** a new tailnet starts with "a default allow all access policy… [that] lets all devices communicate with all other devices". Tailscale recommends grants for all new policy, saying "ACLs will not receive any new features" — [Tailscale access control, search summary](https://tailscale.com/docs/features/access-control); [Grant examples, search summary](https://tailscale.com/docs/reference/examples/grants)
- **Tokens in URLs:**
  - Sensitive data in URLs "may be logged in various locations, including the user's browser, the web server, and any forward or reverse proxy servers". Session tokens in query strings leak through history, Referer and logs (CWE-598).
  - The remedy is to carry tokens in cookies or POST bodies instead.
  - — [OWASP: information exposure through query strings, search summary](https://owasp.org/www-community/vulnerabilities/Information_exposure_through_query_strings_in_url); [PortSwigger: session token in URL, search summary](https://portswigger.net/kb/issues/00500700_session-token-in-url)
- **Cookies are host-scoped, not port-scoped:** see Q4 — [RFC 6265bis, fetched](https://github.com/httpwg/http-extensions/blob/main/draft-ietf-httpbis-rfc6265bis.md)
- **Anthropic's comparable design for remote access:**
  - Short-lived credentials scoped to a single purpose, "to limit the blast radius of any single compromised credential".
  - Device enrolment only shortly after a full sign-in.
  - A biometric or passkey step-up after 18 hours.
  - Per-device revocation.
  - — [Security, fetched](https://code.claude.com/docs/en/security); [Remote Control, fetched](https://code.claude.com/docs/en/remote-control)
- **Tunnels to the public internet:** auto mode blocks "Opening a tunnel or reverse shell that makes a local service reachable from the public internet". Anthropic treats public exposure of a local service as a high-risk action — [Permission modes, fetched](https://code.claude.com/docs/en/permission-modes)

### Inferences
- **The tailnet name buys nothing on its own, and agent-commander gets this right.** [code / INVARIANTS] It accepts its Tailscale DNS name only when a token is configured, because every tailnet peer arrives with the same `Host`. The new detail Tailscale's docs add is that **tagged devices get no identity headers at all**. So header-based authentication must fail closed for them, not treat them as anonymous-but-allowed.
- **Identity headers could replace or complement the token, but local forgery is the catch.** Any process on the host can connect directly to 127.0.0.1:<port> and send forged `Tailscale-User-Login` or `Tailscale-App-Capabilities` headers; Serve strips spoofed headers only on traffic that comes *through* Serve. So the headers are safe only if (a) the backend listens on loopback only, which agent-commander does, and (b) local processes are trusted, or are separately excluded by a secret only the Serve leg carries. Given Q1's point that local agents are part of the threat, a combination is needed: identity or capabilities from Tailscale, plus a token.
- **App capabilities map naturally onto agent-commander's grants.** For example:
  - grant `respond` and `read` to `user:me` on `tag:phone`
  - grant `drive` and `spawn` to the desktop only
  
  That yields per-device least privilege without minting per-device tokens, and fixes the per-server grant limitation noted in Q1.
- **Two recommendations for documentation:**
  - Tighten the tailnet policy so the dashboard port is reachable only from the owner's devices; the default allow-all exposes it to every tailnet node.
  - Never use Funnel: it is public and carries no identity.
- **Assessment of token-in-URL plus cookie exchange.** Adequate against casual leakage: it gets the token out of the address bar, Referer and proxy logs, and is consistent with OWASP. Residual risks:
  - The first URL, with the token, still lands in whatever it was pasted into (chat, notes, QR screenshots) and possibly in history.
  - The cookie is the master token itself, for 30 days. Theft of the cookie is theft of the token, and revocation is global.
  - No device binding.
  
  "Stronger" in 2026 practice means: one-time, short-lived bootstrap codes shown on the desktop (QR) and exchanged once for a device-bound session; a device list with revocation; and passkey step-up for `respond`/`drive`. That is Remote Control's Trusted Devices model.
- **Documentation drift.** [code] AGENTS.md says the token "is still printed in full by `announce`". The current `announce` prints "token masked — run with --print-url for the whole link" (routes.rs). Either the documentation or the behaviour should be reconciled.

### Gaps
- tailscale.com was blocked, so I read no Serve, Funnel, ACL or grants page directly.
- I did not research tsnet: its Go-only status and Rust options (libtailscale, sidecar) are unverified, as is its peer-identity API.
- I did not verify whether Serve's identity headers appear when the backend is proxied over a plain-HTTP loopback leg in all configurations.
- I did not verify whether browsers record the pre-redirect `?token=` URL in history when a 302 immediately strips it.
- I did not research Tailscale's own end-to-end encryption claims (WireGuard between nodes, DERP relays unable to decrypt). The confidentiality claim in Q3 assumes them.

## Q6. Push notification security and privacy (ntfy, Telegram), and leaking agent content to third parties

### Takeaway
Push channels are third-party relays.
- **ntfy.sh:** "the topic is essentially a password". Without ACLs, anyone who knows a topic can both read *and publish* to it. Messages are cached 12 hours, and on ntfy.sh they also go through Firebase.
- **Telegram:** bot chats are server-side-encrypted cloud chats, not end-to-end.

Recommended practice:
- Minimal, non-sensitive payloads; details stay behind the authenticated app (Apple: "Never include sensitive data… in your payload").
- Access-controlled topics (reserved topic plus token, or self-hosted ntfy with `deny-all`).
- Suppress pushes while the user is present.

agent-commander's payload is already minimal, but it still exposes agent names, the tailnet hostname and session IDs, and public ntfy topics allow forged pushes.

### Cited Findings
- **ntfy topics:**
  - "Because there is no sign-up, **the topic is essentially a password**, so pick something that's not easily guessable" — [ntfy publish docs, fetched via raw GitHub](https://github.com/binwiederhier/ntfy/blob/main/docs/publish.md)
  - "If you don't have ACLs set up, the topic name is your password… If you choose a randomly generated topic name, the topic is as good as a good password." — [ntfy FAQ, fetched via raw GitHub](https://github.com/binwiederhier/ntfy/blob/main/docs/faq.md)
- **ntfy.sh retention and Firebase:**
  - "the logs do contain topic names and IP addresses… Messages are cached for the duration configured in `server.yml` (12h by default)."
  - "all messages are also published to Firebase Cloud Messaging (FCM) (if `FirebaseKeyFile` is set, which it is on ntfy.sh)". Avoiding Firebase means the F-Droid app plus a self-hosted server.
  - — [ntfy FAQ, fetched via raw GitHub](https://github.com/binwiederhier/ntfy/blob/main/docs/faq.md)
- **ntfy privacy policy (updated 2026-06-15):** message content is cached on ntfy.sh for 12 hours by default and attachments for 3 hours; IP addresses are used for rate limiting; for access tokens the service stores the token, a label, the last access time and the last IP. "If you don't trust us or your messages are sensitive, you can self-host" — [ntfy privacy policy, fetched via raw GitHub](https://github.com/binwiederhier/ntfy/blob/main/docs/privacy.md)
- **ntfy access control:** `auth-default-access` defaults to `read-write`. "If you are setting up a private instance, you'll want to set this to `deny-all`." ACLs can be set per topic and per user, and access tokens (`tk_…`) are supported — [ntfy config docs, fetched via raw GitHub](https://github.com/binwiederhier/ntfy/blob/main/docs/config.md)
- **ntfy on iOS with a self-hosted server:** instant delivery needs `upstream-base-url: https://ntfy.sh`. "The request from your server to the upstream server contains only the message ID (in the `X-Poll-ID` header), and the SHA256 checksum of the topic URL." The phone then fetches the content from the user's own server — [ntfy config docs, fetched via raw GitHub](https://github.com/binwiederhier/ntfy/blob/main/docs/config.md)
- **Telegram bots:** bot conversations are not end-to-end encrypted. They are encrypted in transit and stored on Telegram's servers with keys Telegram holds; end-to-end encryption exists only in manually started Secret Chats, which bots cannot use because they process messages on Telegram's servers — [ESET, search summary](https://www.eset.com/blog/en/home-topics/privacy-and-identity-protection/telegram-privacy-explained/); [Latenode community, search summary](https://community.latenode.com/t/are-telegram-bot-conversations-protected-with-end-to-end-encryption/23991). This is secondary sourcing: telegram.org was blocked.
- **Apple (background, archived guide):** "Never include sensitive data or data that can be retrieved by other means in your payload". A Notification Service Extension can "Decrypt data that was delivered in an encrypted format" before display — [Apple: creating the notification payload, search summary](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CreatingtheNotificationPayload.html); [Apple: modifying notifications, search summary](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/ModifyingNotifications.html)
- **Anthropic's push design for Remote Control:**
  - Opt-in toggles: "Push when Claude decides" and "Push when actions required" (permission prompts and questions).
  - "Claude Code skips mobile push notifications while you are typing in or focused on the connected terminal." `CLAUDE_CLIENT_PRESENCE_FILE` extends that to any time the user is at the machine.
  - — [Remote Control, fetched](https://code.claude.com/docs/en/remote-control)
- **Channels store bot tokens locally:** the Telegram plugin saves the bot token to `~/.claude/channels/telegram/.env` — [Channels, fetched](https://code.claude.com/docs/en/channels)

### Inferences
- **What agent-commander sends.** [code] `push.rs` sends:
  - title: the agent's name
  - body: `"Waiting on you — {waiting_for}"`, where `waiting_for` comes from a closed set such as "dialog open" or "permission prompt"
  - click target: `{--notify-link}/agent/{session_id}`
  - for ntfy: `Priority: high`, `Tags: raised_hand`, and an optional bearer token
  - for Telegram: `sendMessage` with title and body plus an "Open" button
  
  That matches Apple's guidance and Remote Control's practice (minimal content, presence suppression via the INV-14 visible-tab rule) better than most tools.
- **What still leaks to ntfy.sh, FCM, Telegram and the lock screen:**
  1. Agent names, which for Claude Code are often the CLI's prompt-derived session title. That can name a client, project or bug.
  2. The tailnet hostname. `box.tailXXXX.ts.net` reveals the machine and tailnet names.
  3. Session IDs.
  
  A "content-free" option (title "agent-commander", body "An agent needs you", no link, or a link without the session ID) would let privacy-sensitive users opt out of all three.
- **Public ntfy topics allow push forgery.** On ntfy.sh without a reserved, ACL'd topic, anyone who learns the topic can subscribe (with up to 12 hours of backlog) **and publish** forged "Waiting on you" pushes with an arbitrary `Click` URL. That is a phishing path into whatever page the user then trusts with their token. Mitigations:
  - document reserved topics with access tokens, or self-hosted ntfy with `auth-default-access: deny-all`
  - require high-entropy topic names; consider refusing or warning on short ones
  - never prompt for the token on a page reached from a push
  
  For iOS with self-hosted ntfy, only a message ID goes upstream, which is the best privacy configuration.
- **Telegram exposes content and holds a powerful credential.** Telegram sees the content in plaintext server-side. The bot token, supplied through an environment variable, is a long-lived credential: anyone holding it can send messages as the bot. Users should treat it like the dashboard token.

### Gaps
- telegram.org and core.telegram.org were blocked; Telegram claims rest on secondary sources.
- I did not verify whether ntfy has added end-to-end encryption by October 2026. The fetched docs say nothing on it, and grep found no "end-to-end" or "e2e" in them. That suggests it is still absent, but this is not confirmed.
- I did not research whether ntfy.sh "reserved topics" still require a paid plan in 2026.
- I did not research FCM or APNs retention of notification payloads.
