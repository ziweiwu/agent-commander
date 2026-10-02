# Repository conventions and quality gates for AI coding agents: what helps, what hurts (evidence as of October 2026)

*Scope note (research date 2026-10-02). Tags used below: **[Evidence]** = controlled or large-sample study; **[Vendor]** = official vendor documentation or source code; **[Practitioner]** = opinion or experience report; **[Background]** = pre-2025 source. Living vendor docs were fetched on 2026-10-02; they change often, and some carry version numbers that are noted. This environment's egress proxy blocked arxiv.org, openai.com, developers.openai.com, docs.github.com (the HTML site), cursor.com, trychroma.com, humanlayer.dev, vercel.com and most blogs. For those sources the findings come from search-result abstracts or secondary summaries, and each one says so ("via search abstract" / "via secondary summary"). Primary text was read directly for code.claude.com, platform.claude.com, anthropic.com/engineering, the agents.md site source, OpenAI Codex source code, GitHub's docs source (github/docs repo), the Gemini CLI docs source, the IFScale raw data, and the Chroma and AGENTbench repos. Measurements of agent-commander files were taken from this checkout.*

---

## 1. The AGENTS.md standard and its governance, and what Anthropic, OpenAI, GitHub, Cursor and Google recommend for context-file content, length and structure

### Takeaway
AGENTS.md is now a vendor-neutral, Linux Foundation–stewarded convention with **no required fields and no length rule**. Every vendor that does give guidance converges on the same advice: keep the file short, keep only what applies in every session, and push everything else into scoped or on-demand mechanisms (path-scoped rules, nested files, skills, docs/). The concrete numbers are:
- Anthropic: under 200 lines per CLAUDE.md, with a warning shown at startup when a file is over.
- OpenAI Codex: a 32 KiB hard budget, with anything past it truncated.
- GitHub: two pages or less in its own onboarding prompt.
- Cursor: under 500 lines per rule.
- OpenAI's internal team: about 100 lines of "map".

Anthropic also states explicitly that **`@imports` organize a file but do not reduce its context cost**.

### Cited Findings

#### The standard and its governance
- **[Vendor]** The agents.md site describes AGENTS.md as "A simple, open format for guiding coding agents, used by over 60k open-source projects" and "a README for agents: a dedicated, predictable place to provide the context and instructions to help AI coding agents work on your project." It says the format "emerged from collaborative efforts across the AI software development ecosystem, including OpenAI Codex, Jules from Google, Cursor, and Factory" and "is now stewarded by the Agentic AI Foundation under the Linux Foundation." (Site source read 2026-10-02.) — [agentsmd/agents.md site source (Hero.tsx, AboutSection.tsx)](https://github.com/agentsmd/agents.md)
- **[Vendor]** The site's FAQ, in full:
  - "Are there required fields? No. AGENTS.md is just standard Markdown."
  - Conflicts: "The closest AGENTS.md to the edited file wins; explicit user chat prompts override everything."
  - "Will the agent run testing commands found in AGENTS.md automatically? Yes—if you list them. The agent will attempt to execute relevant programmatic checks and fix failures before finishing the task."
  - "Treat AGENTS.md as living documentation."

  Source: [agents.md FAQSection.tsx](https://github.com/agentsmd/agents.md/blob/main/components/FAQSection.tsx)
- **[Vendor]** Recommended sections: "Project overview, Build and test commands, Code style guidelines, Testing instructions, Security considerations", plus "Commit messages or pull request guidelines, security gotchas, large datasets, deployment steps: anything you'd tell a new teammate." For monorepos: "Place another AGENTS.md inside each package. Agents automatically read the nearest file in the directory tree… the main OpenAI repo has 88 AGENTS.md files." **The standard itself gives no length guidance.** — [agents.md HowToUseSection.tsx](https://github.com/agentsmd/agents.md/blob/main/components/HowToUseSection.tsx)
- **[Vendor]** The site's compatibility list includes Codex, Amp, Jules, Cursor, Factory, RooCode, Aider, Gemini CLI, goose, Kilo Code, opencode, Phoenix, Zed, Semgrep, Warp, the GitHub Copilot coding agent and VS Code, among others. — [agents.md CompatibilitySection.tsx](https://github.com/agentsmd/agents.md/blob/main/components/CompatibilitySection.tsx)
- **[Vendor]** On 9 December 2025 the Linux Foundation announced the Agentic AI Foundation (AAIF), "anchored by" three founding project contributions: Anthropic's Model Context Protocol, Block's goose, and OpenAI's AGENTS.md. — [Linux Foundation press release](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation); [TechCrunch, 2025-12-09](https://techcrunch.com/2025/12/09/openai-anthropic-and-block-join-new-linux-foundation-effort-to-standardize-the-ai-agent-era/)

#### Anthropic (Claude Code), docs fetched 2026-10-02
- **[Vendor]** "**Size**: target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence. Move instructions that matter for only part of the codebase into path-scoped rules… Imports help you organize a long file but don't reduce its context cost, because imported files also load at launch." — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** "If one of your instruction files is over the recommended length, you see a warning at startup and when you run `/status`. You also see a warning when files that are each within that length add up past a combined limit… Each CLAUDE.md, rules file, and `@path` import counts as a separate file." Claude Code loads a CLAUDE.md of up to 4 MiB in full and skips a larger one: "Shorter files produce better adherence." — [Claude Code docs: memory ("My CLAUDE.md is too large")](https://code.claude.com/docs/en/memory)
- **[Vendor]** Scope rule: "Keep it to facts Claude should hold in every session: build commands, conventions, project layout, 'always do X' rules. If an entry is a multi-step procedure or only matters for one part of the codebase, move it to a skill or a path-scoped rule instead." — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** Best-practices doc:
  - "Keep it concise. For each line, ask: 'Would removing this cause Claude to make mistakes?' If not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions!"
  - "If Claude keeps doing something you don't want despite having a rule against it, the file is probably too long and the rule is getting lost."
  - "If you emphasize many lines, none of them stands out."
  - "Treat CLAUDE.md like code: review it when things go wrong, prune it regularly, and test changes by observing whether Claude's behavior actually shifts."

  Source: [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Vendor]** The best-practices include/exclude table:

  | Include | Exclude |
  | --- | --- |
  | Bash commands Claude can't guess | Anything Claude can figure out by reading code |
  | Code style rules that differ from defaults | Standard language conventions Claude already knows |
  | Testing instructions and preferred test runners | Detailed API documentation (link to docs instead) |
  | Repository etiquette | Information that changes frequently |
  | Architectural decisions specific to your project | Long explanations or tutorials |
  | Developer environment quirks | File-by-file descriptions of the codebase |
  | Common gotchas or non-obvious behaviors | Self-evident practices like "write clean code" |

  The doc also names the failure pattern "The over-specified CLAUDE.md… Claude ignores half of it because important rules get lost in the noise. Fix: Ruthlessly prune. If Claude already does something correctly without the instruction, delete it or convert it to a hook." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Vendor]** "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself… there's no guarantee of strict compliance, especially for vague or conflicting instructions." Claude "treats them as context, not enforced configuration. To block an action regardless of what Claude decides, use a PreToolUse hook." — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** How files are loaded:
  - Imports recurse "with a maximum depth of four hops."
  - CLAUDE.md files in ancestor directories load at launch. Files in subdirectories "load on demand when Claude reads files in those directories."
  - `.claude/rules/*.md` files with `paths:` frontmatter "only load into context when Claude works with matching files."
  - "Block-level HTML comments (`<!-- maintainer notes -->`) in CLAUDE.md files are stripped before the content is injected into Claude's context. Use them to leave notes for human maintainers without spending context tokens on them."

  Source: [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** The `/doctor` checkup "cuts content Claude can derive from the codebase, such as directory layouts, dependency lists, and architecture overviews, and keeps pitfalls, rationale, and conventions that differ from tool defaults." `/doctor prompt-audit` (v2.1.283+) looks for "instructions written for older models, references to files or commands that don't exist, and files that contradict each other." — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** "Project-root CLAUDE.md survives compaction: after `/compact`, Claude re-reads it from disk and re-injects it into the session." — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** Subagents load "every level of the CLAUDE.md hierarchy the main conversation loads… The built-in Explore and Plan agents skip this." Custom subagents can opt out with `omitClaudeMd: true` (v2.1.271+). — [Claude Code docs: sub-agents](https://code.claude.com/docs/en/sub-agents)
- **[Vendor]** Claude Code reads AGENTS.md natively from v2.1.277. By default it reads AGENTS.md *only when there is no CLAUDE.md*. A CLAUDE.md containing `@AGENTS.md` "never makes Claude read AGENTS.md twice." — [Claude Code docs: memory (AGENTS.md)](https://code.claude.com/docs/en/memory)
- **[Vendor]** "Aim to keep CLAUDE.md under 200 lines by including only essentials", and move workflow-specific instructions (for example PR reviews or migrations) into skills, because "those tokens are present even when you're doing unrelated work." — [Claude Code docs: costs](https://code.claude.com/docs/en/costs)
- **[Vendor]** "a single CLAUDE.md at the repository root tends to either grow to cover every subsystem's conventions, costing context on instructions unrelated to the current task, or stay too generic to be useful." The recommended alternatives are per-directory CLAUDE.md files or path-scoped rules. — [Claude Code docs: large codebases](https://code.claude.com/docs/en/large-codebases)
- **[Vendor]** Anthropic's prompting guide:
  - "Providing context or motivation behind your instructions, such as explaining to Claude why such behavior is important, can help Claude better understand your goals." This supports brief rationale.
  - Newer models "are also more responsive to the system prompt than previous models… The fix is to dial back any aggressive language. Where you might have said 'CRITICAL: You MUST use this tool when…'".

  Source: [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- **[Vendor]** Anthropic applies the same limit to its own auto-memory index: only "the first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation"; topic files are read on demand. — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)

#### OpenAI (Codex)
- **[Vendor, source code]** Codex concatenates "every `AGENTS.md` found from the project root down to the current working directory". The default budget is `AGENTS_MD_MAX_BYTES … = DEFAULT_PROJECT_DOC_MAX_BYTES; // 32 KiB`. Content past the budget is cut with `data.truncate(remaining)` and a log line, "project doc exceeds remaining budget; truncating". The budget is configurable as `project_doc_max_bytes`. — [openai/codex agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs); [openai/codex config/mod.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs)
- **[Practitioner, OpenAI team, Feb 2026; via secondary summary]** In OpenAI's "Harness engineering" write-up, a team built a roughly 1M-line product with Codex across about 1,500 PRs. They tried "one big AGENTS.md" and report that it failed through context crowding, guidance overload ("when everything is important"), rapid rot, and being impossible to verify mechanically. They moved to a **~100-line AGENTS.md used as a map / table of contents**, with a structured `docs/` directory as the system of record. "Dedicated linters and CI jobs validate that the knowledge base is up to date, cross-linked, and structured correctly." A recurring "doc-gardening" agent opens fix-up PRs for stale documentation. — [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/) (primary not fetchable here); summaries: [zby commonplace notes](https://zby.github.io/commonplace/sources/harness-engineering-leveraging-codex-agent-first-world/), [alexlavaee.me](https://alexlavaee.me/blog/openai-agent-first-codebase-learnings/)

#### GitHub (Copilot), docs source read 2026-10-02
- **[Vendor]** The Copilot cloud agent reads `/.github/copilot-instructions.md`, `/.github/instructions/**/*.instructions.md`, `**/AGENTS.md`, `/CLAUDE.md` and `/GEMINI.md`. "If Copilot is able to build, test and validate its changes in its own development environment, it is more likely to produce good pull requests which can be merged quickly." — [GitHub Docs: get the best results (source)](https://github.com/github/docs/blob/main/content/copilot/tutorials/cloud-agent/get-the-best-results.md)
- **[Vendor]** GitHub's own recommended prompt for generating repository instructions says: "Instructions must be no longer than 2 pages" and "Instructions must not be task specific." Its stated goals are to reduce PRs rejected for failing CI, "Minimize bash command and build failures", and minimize exploration. — [GitHub Docs: add repository instructions (source)](https://github.com/github/docs/blob/main/content/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions.md)
- **[Vendor]** Copilot code review's decision table splits guidance by kind:
  - `copilot-instructions.md`: repository-wide always-on rules.
  - Path-specific `*.instructions.md`: "Always-on rules for specific paths".
  - `AGENTS.md`: "Any agent, always know this".
  - Skills: "Do this when needed".

  Source: [GitHub Docs: Copilot code review concepts (source)](https://github.com/github/docs/blob/main/content/copilot/concepts/agents/code-review.md)
- **[Vendor]** Copilot CLI reads AGENTS.md, CLAUDE.md (and `.claude/CLAUDE.md`) and GEMINI.md, and expands `@path` imports in `copilot-instructions.md`, AGENTS.md and CLAUDE.md. Referenced files must stay inside the repository. — [GitHub Docs: Copilot CLI custom instructions (source)](https://github.com/github/docs/blob/main/content/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions.md)
- **[Vendor, conflicting]** Copilot code review used to document that it "only reads the first 4,000 characters of any custom instruction file". The limit has since been removed from the docs. — [sqlserverscience: Copilot code review and the 4,000 character limit](https://www.sqlserverscience.com/ai-for-dbas/copilot-code-review-4000-character-limit/); [github/docs issue #42761 "Character limit removed for custom instructions"](https://github.com/github/docs/issues/42761)
- **[Vendor, conflicting]** GitHub argues the opposite of the ETH study in §2: "A well-maintained custom instructions file… gives agents a structural overview of your repository so they don't have to read large numbers of files just to orient themselves." — [GitHub Docs: optimize AI usage (source)](https://github.com/github/docs/blob/main/content/copilot/tutorials/optimize-ai-usage.md)
- **[Practitioner/Vendor blog, 2025-11-19; via search abstract]** GitHub analyzed more than 2,500 agents.md files. Its recommendations:
  - Put exact executable commands (with flags) early.
  - "One real code snippet showing your style beats three paragraphs describing it."
  - Set explicit boundaries: what never to touch.
  - Give a specific persona.
  - Vagueness is the most common failure.

  Source: [GitHub Blog: How to write a great agents.md](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/)

#### Cursor
- **[Vendor; via search abstract]** Cursor's rules docs recommend keeping rules under 500 lines and splitting large rules into composable, scoped ones. Third-party guides add that `alwaysApply` rules are loaded on every request and should be used sparingly. — [Cursor docs: Rules](https://cursor.com/docs/rules); [third-party guide, techsy.io](https://techsy.io/en/blog/cursor-rules-guide)

#### Google (Gemini CLI, Jules)
- **[Vendor]** Gemini CLI "concatenates the contents of all found files, and sends them to the model with every prompt". It loads files in this order: global `~/.gemini/GEMINI.md`, then workspace files plus ancestors, then "Just-in-time (JIT) context files". For JIT: "When a tool accesses a file or directory, the CLI automatically scans for `GEMINI.md` files in that directory and its ancestors… only when they are needed." It supports `@file.md` imports, with a maximum import depth and circular-import detection, and `context.fileName` can be set to `["AGENTS.md", …]`. **No length guidance was found.** — [gemini-cli docs/cli/gemini-md.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md); [memport.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/memport.md)
- **[Vendor]** Jules (Google) is named as a co-originator and consumer of AGENTS.md. — [agents.md AboutSection.tsx](https://github.com/agentsmd/agents.md/blob/main/components/AboutSection.tsx)

#### Progressive disclosure through Skills, and the counter-evidence
- **[Vendor, 2025-10-16]** Skills load at three levels:
  1. Name and description metadata are preloaded.
  2. The full SKILL.md is loaded "when Claude determines relevance".
  3. Linked files are read "only as needed".

  "The amount of context that can be bundled into a skill is effectively unbounded." — [Anthropic Engineering: Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- **[Vendor]** Skill authoring guidance:
  - "The context window is a public good."
  - "Default assumption: Claude is already very smart… 'Does this paragraph justify its token cost?'"
  - "Keep SKILL.md body under 500 lines."
  - "Keep references one level deep."
  - Add a table of contents to reference files longer than 100 lines.
  - "Create evaluations BEFORE writing extensive documentation"; at least three scenarios.
  - Avoid time-sensitive information, and put history in a collapsed "Old patterns" section.

  Source: [Claude Platform: Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- **[Vendor]** After `/compact`, Claude Code re-injects the body of each skill that was invoked, "capped at 5,000 tokens per skill". The skill *listing* itself is not re-injected. — [Claude Code docs: context window](https://code.claude.com/docs/en/context-window)
- **[Evidence, vendor eval, Jan 2026; via search abstract]** Vercel's Next.js agent evals found that a compressed ~8 KB docs index embedded in AGENTS.md reached a **100%** pass rate. The other configurations scored:
  - Baseline: **53%**.
  - Skills with default behavior: **53%**. The skill was never invoked in **56%** of cases.
  - Skills with explicit instructions to use them: **79%**.

  The lesson Vercel drew: persistent context wins when the bottleneck is triggering or retrieval. — [Vercel: AGENTS.md outperforms skills in our agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)

### Inferences
- **What agent-commander's setup measures against these numbers (this checkout, 2026-10-02):**
  - `CLAUDE.md` is a two-line shim (`@AGENTS.md`, `@INVARIANTS.md`). It imports **3,284 lines**: AGENTS.md is 808 lines and INVARIANTS.md is 2,476 lines. (The brief guessed ~900 and ~1,500; the measured numbers differ.)
  - Against Anthropic's 200-line target, AGENTS.md is about **4×** over, INVARIANTS.md about **12×**, and the combined load about **16×**.
  - Per the docs, both files will trigger Claude Code's over-length warning.
  - Splitting the files into imports does nothing for cost or adherence: Anthropic says imports "don't reduce its context cost".
- **The setup has cross-tool consequences.**
  - Codex reads AGENTS.md only. It cuts the file at its 32 KiB budget, at roughly line 526 of 808 (65.5% kept, measured), part-way through "Things that have already bitten". So Codex never sees "Shipping it to npm", "The macOS bundle", "Review agents", "The three documents worth reading in full" or **"Commits"**, which holds the imperative rules "Never add a Co-Authored-By: Claude… trailer" and "Commit or push only when asked".
  - INVARIANTS.md reaches no tool except Claude Code, and possibly Copilot CLI, which expands imports inside CLAUDE.md.
  - Copilot CLI reads both AGENTS.md and CLAUDE.md, and CLAUDE.md imports AGENTS.md. Whether it de-duplicates is unverified.
- **The standard keeps the repo's intent and rejects its form.** AGENTS.md's recommended sections (commands, testing, conventions, gotchas) match the repo's best content: the "Before you say it works" commands, the port-safety rules, the INV-1/INV-2 summaries, the generated-files rule and the `scripts/cargo.sh` rule. What vendor guidance rules out is the *volume*, and the *placement* of narrative and reference material in always-loaded context.
- **HTML comments are an underused option.** Claude Code strips block-level HTML comments, so maintainer narrative ("why we learned this") can stay next to a rule without costing tokens. Whether other agents strip them is unverified.
- **Anthropic does not tell you to delete rationale.** Its own trimmer keeps "pitfalls, rationale, and conventions that differ from tool defaults", and its prompting guide says motivation helps. The evidence supports a *one-line* "why" per rule, not multi-paragraph incident narratives.
- **How CLAUDE.md is framed to the model varies by version and surface.** First-hand observation in this research session (a Claude Agent SDK subagent, 2026-10-02; no public URL): the full AGENTS.md and INVARIANTS.md text was injected into the subagent's context, which confirms the docs' statement that subagents load CLAUDE.md. It was framed as "Codebase and user instructions are shown below… IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written." HumanLayer described a "may or may not be relevant" wrapper instead. So the HumanLayer description should not be relied on as current. The only documented constant is that CLAUDE.md arrives as a user message after the system prompt, with no guarantee of strict compliance.

### Gaps
- No Google length guidance for GEMINI.md, and no Jules-specific AGENTS.md guidance, was found.
- Cursor's and OpenAI's developer docs could not be fetched here. Cursor's 500-line figure comes from a search abstract, and Codex's behavior was confirmed from source code instead.
- The AAIF technical charter (`Technical_Charter.pdf` in the agents.md repo) was not reviewed, so governance details beyond "stewarded by AAIF under the Linux Foundation" are unverified.
- Whether Copilot CLI de-duplicates an AGENTS.md that is both read directly and imported via CLAUDE.md is undocumented.

---

## 2. Empirical evidence on context files, instruction-following decay, context rot, and the token cost of large always-loaded context

### Takeaway
The controlled evidence (2026) says **context files help only a little, and only when they are short, specific and non-obvious**. Developer-written files gave about +4 percentage points of success at up to +19% cost. LLM-generated files cost about 3 points of success at more than +20% cost. Repository overviews did not help. Agents *do* follow the instructions, and that is exactly how unnecessary requirements make tasks harder and more expensive.

Two other results point the same way:
- Instruction-following degrades with instruction count, with primacy bias (IFScale).
- Accuracy degrades with input length even on trivial tasks (Chroma).

Positive results do exist: lower runtime, iteratively tuned guidance, and compressed doc indexes. They come from *targeted* guidance that is tested against tasks.

agent-commander's always-loaded block is about **51–59K tokens**: roughly 28–33× Anthropic's example project CLAUDE.md, and about 26–29% of a 200K window, re-injected after compaction and copied into every non-Explore/Plan subagent.

### Cited Findings

#### Controlled studies of context files
- **[Evidence, Feb 2026]** Gloaguen, Mündler, Müller, Raychev and Vechev (ETH Zurich / LogicStar), "Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?" Context files "do not generally improve task success rates, while increasing inference cost by over 20% on average… across different LLMs, coding agents, and for both LLM-generated and developer-committed context files." Further: "instructions in the context files are well followed", "repository overviews… are not helpful", "unnecessary requirements from context files make tasks harder, and human-written context files should describe only minimal requirements." (Via search abstract; arxiv blocked.) — [arXiv:2602.11988](https://arxiv.org/abs/2602.11988)
- **[Evidence, Feb 2026; via secondary summaries]** Details from the same study:
  - Benchmarks: SWE-bench Lite (300 tasks) and the new AGENTbench (138 tasks from 12 repositories that have developer-written context files).
  - Developer-written files: about **+4%** average success at up to **+19%** cost.
  - LLM-generated files: about **−3%** success at more than **+20%** cost.
  - Context files added about **2–4 tool steps** per task and more reasoning tokens.

  Sources: [Upsun: "your AGENTS.md is probably too long"](https://developer.upsun.com/posts/ai/agents-md-less-is-more); [The Decoder](https://the-decoder.com/context-files-for-coding-agents-often-dont-help-and-may-even-hurt-performance/). The evaluation harness runs three settings (`NONE`, `LLM`, `HUMAN`), writing AGENTS.md/CLAUDE.md before each agent run: [eth-sri/agentbench README](https://github.com/eth-sri/agentbench)
- **[Evidence, Jan–Mar 2026; ICSE 2026 JAWs]** Lulla et al., "On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents". Design: paired runs with and without AGENTS.md on **10 repositories / 124 PRs**. Result: AGENTS.md "is associated with a lower median runtime (**28.64%** reduction) and reduced output token consumption (**16.58%** reduction), while maintaining a comparable task completion behavior." (Via search abstract.) — [arXiv:2601.20404](https://arxiv.org/abs/2601.20404)
- **[Evidence, Jun 2026]** Shepard and Albrecht, "Probe-and-Refine Tuning of Repository Guidance". The guidance file is tuned iteratively with synthetic bug-fix probes. Mean resolve rate on SWE-bench Verified:
  - Tuned guidance: **33.0%**.
  - Static knowledge base: **28.3%**.
  - No guidance: **25.5%**.

  Both tuned-guidance comparisons were significant at p < 0.001. The gain came from **coverage**: 14.5 points more instances produced evaluable patches. Per-patch precision stayed flat at about 59%. In other words, guidance helped agents *reach the right file*. (Via search abstract.) — [arXiv:2606.20512](https://arxiv.org/abs/2606.20512)
- **[Evidence, Sep 2026]** Kozyrev, Kozyrev and Podkopaev, "Skill Issue: Lessons from Optimizing Repository SKILLs". Repository SKILL docs were scored on harder tasks mined from reverted merged PRs. On three Kotlin repositories, GEPA-optimized docs raised the score by **+4.9 points** and SkillOpt by **+0.1 points**. Prior work's synthetic tasks were "small enough that a capable agent saturates them with no document at all." (Via search abstract.) — [arXiv:2609.12742](https://arxiv.org/abs/2609.12742)
- **[Evidence, vendor eval, Jan 2026]** Vercel's compressed 8 KB docs index in AGENTS.md: **100%**, against 53% baseline and 79% for explicitly instructed skills. See §1. — [Vercel blog](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)

#### What real context files contain
- **[Evidence, Nov 2025]** "Agent READMEs" studied **2,303** context files from **1,925** repositories (Claude Code, Codex, Copilot). The files "are not static documentation but complex, difficult-to-read artifacts that evolve like configuration code, maintained through frequent, small additions." Content frequencies:
  - Implementation details: 69.9%.
  - Architecture: 67.7%.
  - Build/run commands: 62.3%.
  - Security: 14.5%.
  - Performance: 14.5%.

  (Via search abstract.) — [arXiv:2511.12884](https://arxiv.org/abs/2511.12884)
- **[Evidence, Jun 2026]** "Configuration Smells in AGENTS.md Files" (UFMG) studied 100 popular repositories. Frequencies:
  - **Lint Leakage: 62%.** Restating rules that linters or formatters already enforce.
  - **Context Bloat: 42%.** A file "excessively large and overloaded with rules, examples, or low-priority details", which "reduce[s] the visibility of important instructions".
  - **Skill Leakage: 35%.** "Rarely used, or highly context-dependent instructions" placed in AGENTS.md instead of skills.
  - **Conflicting Instructions: 28%.**
  - **Init Fossilization: 24%.** Setup-era details that are no longer relevant.
  - **Blind References: 16%.** External docs referenced without saying when they matter.

  Bloat, Skill Leakage and Conflicts often appear together. (Via search abstract and press coverage.) — [arXiv:2606.15828](https://arxiv.org/abs/2606.15828); [The Register, 2026-06-17](https://www.theregister.com/ai-and-ml/2026/06/17/smelly-config-files-will-make-your-agents-waste-tokens-researchers-warn/5257951)
- **[Evidence, Aug 2026]** Gao and Chen (PKU) analyzed 557 SWE-chat sessions and 33,097 agentic PRs. Agent instruction files and agent working notes make up **60.5%** of documentation interactions; classical technical docs **10.6%**; API references **1.3%**. Documentation lookups are self-initiated (70.2%) far more often than triggered by a failure (7.5%). (Via search abstract.) — [arXiv:2608.20195](https://arxiv.org/abs/2608.20195)
- **[Evidence, single case study, Feb 2026]** "Codified Context" describes a 108K-line C# system built with:
  - A **~660-line "constitution"** (hot memory) loaded in every session.
  - 19 specialized domain agents.
  - 34 on-demand specification docs (cold memory).

  It has no controlled comparison. (Via search abstract.) — [arXiv:2602.20478](https://arxiv.org/abs/2602.20478)

#### Instruction density and long-context degradation
- **[Evidence, Jul 2025]** IFScale (Jaroslawicz et al., Distyl AI) uses up to 500 simultaneous keyword-inclusion instructions in a report-writing task, tested on 20 models. "Even the best frontier models only achieve 68% accuracy at the max density of 500 instructions." It identified three degradation patterns (threshold, linear, exponential) and a primacy bias that peaks at 150–200 instructions. (Via search abstract.) — [arXiv:2507.11538](https://arxiv.org/abs/2507.11538)
- **[Evidence, primary data]** IFScale accuracy (%) at each instruction count:

  | Model | 100 | 250 | 500 |
  | --- | --- | --- | --- |
  | Claude Sonnet 4 | 94.4 | 77.2 | 42.9 |
  | Claude Opus 4 | 94.6 | 67.9 | 44.6 |
  | Claude Opus 4 (high reasoning) | 81.8 | 81.5 | 52.1 |
  | o3 (high reasoning) | 98.2 | 97.8 | 62.8 |
  | Gemini 2.5 Pro | 98.4 | 84.8 | 68.9 |

  All of these are mid-2025 models. — [IFScale raw data (merged_accuracy_latency_data.csv)](https://github.com/distylai/distylai.github.io/tree/main/IFScale)
- **[Practitioner, late 2025]** HumanLayer's claims:
  - "Frontier models reliably follow ~150–200 total instructions."
  - Claude Code's own system prompt already holds about 50.
  - Their root CLAUDE.md is under 60 lines.
  - Claude Code wraps CLAUDE.md in a reminder that "this context may or may not be relevant to your tasks."

  (Via search abstract and HN.) — [HumanLayer: Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md); [HN discussion](https://news.ycombinator.com/item?id=46098838)
- **[Evidence, Jul 2025]** Chroma's "Context Rot" report (Hong, Troynikov, Huber) tested **18** models, including GPT-4.1, Claude 4, Gemini 2.5 and Qwen3. "Model performance varies significantly as input length changes, even on simple tasks." It holds task difficulty fixed while varying length. All models degraded well before their window limits, and degraded on LongMemEval at ~113K tokens. Models did better on *shuffled* haystacks than on logically coherent ones. — [chroma-core/context-rot README](https://github.com/chroma-core/context-rot); [Chroma report](https://www.trychroma.com/research/context-rot) (blocked here; details via search abstract)
- **[Vendor, 2025-09-29]** Anthropic's context engineering post:
  - "as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases."
  - LLMs have an "attention budget"; transformers create "n² pairwise relationships for n tokens"; "Context… must be treated as a finite resource with diminishing marginal returns."
  - "Good context engineering means finding the smallest possible set of high-signal tokens."
  - Claude Code is a hybrid in which "CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep allow it to… retrieve files just-in-time."

  Source: [Anthropic Engineering: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **[Vendor]** "LLM performance degrades as context fills. When the context window is getting full, Claude may start 'forgetting' earlier instructions or making more mistakes." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Background, 2023/TACL 2024]** Liu et al., "Lost in the Middle": a U-shaped curve in which performance is highest when the relevant information sits at the start or end of the context and drops in the middle. — [Semantic Scholar entry](https://www.semanticscholar.org/paper/Lost-in-the-Middle:-How-Language-Models-Use-Long-Liu-Lin/1733eb7792f7a43dd21f51f4d1017a1bffd217b5)

#### Token and dollar overhead, quantified
- **[Vendor]** "For Claude, a token approximately represents 3.5 English characters." — [Claude glossary](https://platform.claude.com/docs/en/about-claude/glossary)
- **[Measured, this checkout]** Size of the always-loaded files:

  | File | Lines | Characters | Est. tokens (4 / 3.5 chars per token) |
  | --- | --- | --- | --- |
  | AGENTS.md | 808 | 49,845 | ~12.5K / ~14.2K |
  | INVARIANTS.md | 2,476 | 155,850 | ~39.0K / ~44.5K |
  | **Total** | 3,284 | 205,695 | **~51.4K / ~58.8K** |

  The "Things that have already bitten" section alone is 380 lines, 26,107 characters (~7.5K tokens) and 40 top-level bullets. — [AGENTS.md](/home/user/agent-commander/AGENTS.md); [INVARIANTS.md](/home/user/agent-commander/INVARIANTS.md)
- **[Vendor]** Claude Code's illustrative startup walkthrough shows a system prompt of 4,200 tokens and a project CLAUDE.md of 1,800 tokens. — [Claude Code docs: context window](https://code.claude.com/docs/en/context-window)
- **[Vendor]** Prompt-caching prices (docs fetched 2026-10-02):

  | Model | Base input | 5-min cache write | 1-hour cache write | Cache hit | Output |
  | --- | --- | --- | --- | --- | --- |
  | Claude Opus 5.5 | $4/MTok | $5 | $8 | **$0.20** (0.05×) | $20 |
  | Claude Sonnet 5.5 | $2/MTok | $2.50 | $4 | $0.20 | $10 |

  "Cache read tokens are 0.1 times the base input tokens price" except for named models, Opus 5.5 among them. — [Claude Platform: prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- **[Vendor]** "Claude Code sends your full conversation with every request"; the first message after the cache lifetime expires "misses the cache and reprocesses your full context". Average enterprise cost is "around $13 per developer per active day and $150–250 per developer per month". — [Claude Code docs: costs](https://code.claude.com/docs/en/costs)

### Inferences
- **The dollar cost is modest; the attention and step costs are not.** Arithmetic from the figures above, for ~51–59K tokens on Opus 5.5:
  - About $0.010–0.012 per cached request.
  - About $0.26–0.29 for each 5-minute cache write, paid at session start, after each cache expiry, and separately by **each subagent** that loads CLAUDE.md.
  - About $0.21–0.24 per request on a cache miss.

  The larger costs, per the evidence, are (a) the ETH-measured extra steps and reasoning (+19–20% cost) caused by agents *following* unnecessary requirements; (b) dilution of the ~10–20 rules that truly matter; and (c) context-window share: about 26–29% of a 200K window, or about 5–6% of a 1M window, before any task tokens, re-injected after every compaction.
- **The rule count lands in the regime where degradation shows.** The two files contain about 200 explicit "must/never/always/do not" tokens (43 in AGENTS.md, 157 in INVARIANTS.md, measured) plus many more implicit rules. That is IFScale's 100–250+ regime, where 2025 Claude models fell from ~94% to 68–81% on *trivial* instructions. Caveats: IFScale's instructions are much simpler than INV-style rules, and newer models (Opus 5.5) were not measured. The direction of the effect is supported; the size for current models is unknown.
- **Placement adds to the problem.** Under primacy bias and lost-in-the-middle, rules at the end of a 59K-token block sit in the middle of the overall context once the conversation grows. In agent-commander the imperative "Commits" rules come last in AGENTS.md, and INVARIANTS.md (loaded second) carries the second-most-important constraints after INV-1/INV-2.
- **Reconciling the studies.** Lulla's efficiency gains and Probe-and-refine's +4.7 points over a static knowledge base (+7.5 over no guidance) suggest guidance helps when it shortens *navigation*: "where things are, which command to run". ETH and Chroma show cost and degradation when guidance turns into *requirements and overviews*. A short map plus mechanized checks gets the benefit without most of the cost.

### Gaps
- No study isolates *very* long (>2,000-line) human-written context files. The developer-written files in AGENTbench were likely far shorter, but their size distribution could not be checked because arxiv was blocked.
- No instruction-density measurement exists for current models (Opus 5.5, Sonnet 5.5). IFScale covers mid-2025 models.
- Per-model numbers from Chroma's report were not available here (site blocked).
- The ETH figures +4%, −3%, "up to 19%" and "2–4 steps" come from secondary summaries, not the paper text.

---

## 3. Hooks and quality gates: Stop, PreToolUse, PostToolUse, SubagentStop; enforcing tests and lint at end of turn; performance budgets; loop prevention

### Takeaway
Anthropic's position is unambiguous: **anything that must happen every time belongs in a hook, not in CLAUDE.md.** A Stop hook is the documented "deterministic gate", and Claude Code has built-in loop protections:
- a `stop_hook_active` flag;
- an 8-consecutive-continuation cap, configurable via `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`;
- 600 s default command-hook timeouts;
- all matching hooks run in parallel.

Vendors publish **no latency budget** for Stop hooks. Practitioner and Anthropic-engineering advice converges on fast, low-output, targeted checks, with full suites in CI, plus sampling or filtering so test output doesn't flood context.

### Cited Findings
- **[Vendor]** "Use hooks for actions that must happen every time with zero exceptions… Unlike CLAUDE.md instructions which are advisory, hooks are deterministic and guarantee the action happens." "If the instruction is something that must run at a specific point, such as before every commit or after each file edit, write it as a hook instead." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices); [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** The documented ways to gate the stop, from lightest to heaviest:
  1. In the prompt.
  2. As a `/goal` condition re-checked after every turn.
  3. "**As a deterministic gate**: a Stop hook runs your check as a script and blocks the turn from ending until it passes."
  4. As a verification subagent, "so the agent doing the work isn't the one grading it."

  The doc adds: "Have Claude show evidence rather than asserting success." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Vendor]** Stop fires "When Claude finishes responding". Exit code 2, or `{"decision":"block","reason":…}`, "Prevents Claude from stopping, continues the conversation", and `reason` is shown to Claude. A non-error alternative is `hookSpecificOutput.additionalContext`. — [Claude Code docs: hooks](https://code.claude.com/docs/en/hooks)
- **[Vendor]** Loop protections: "The `stop_hook_active` field is `true` when Claude Code is already continuing as a result of a stop hook. Check this value or process the transcript to avoid blocking on a condition that will never resolve. Claude Code applies an 8-consecutive-continuation cap: after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block and ends the turn. To raise the cap, set `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`." SubagentStop hooks receive `stop_hook_active` too. — [Claude Code docs: hooks](https://code.claude.com/docs/en/hooks)
- **[Vendor]** Troubleshooting section, "Stop hook hits the block cap": "Your hook script needs to check whether it already triggered a continuation. Parse the `stop_hook_active` field from the JSON input and exit early if it's `true`." — [Claude Code docs: hooks guide](https://code.claude.com/docs/en/hooks-guide)
- **[Vendor]** Timeouts and execution:
  - Default timeouts: "600 for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`".
  - "All matching hooks run in parallel."
  - A timed-out hook's output is discarded. A timed-out PreToolUse hook "doesn't block the tool call… don't count on a stalled hook to act as a gate."
  - Timeouts are not enforced for `async: true` command hooks.

  Source: [Claude Code docs: hooks](https://code.claude.com/docs/en/hooks)
- **[Vendor]** Other events usable as gates: TaskCompleted can block ("cancels the task and returns the message to Claude"); PreCompact can block; PostToolUse with matcher `Edit|Write` is the documented pattern for lint-on-edit and can inject `additionalContext` without blocking. — [Claude Code docs: hooks](https://code.claude.com/docs/en/hooks)
- **[Vendor]** Ways to reduce the context cost of gates:
  - A PreToolUse hook that rewrites `npm test|pytest|go test` to show only failures (`grep -A 5 -E '(FAIL|ERROR|error:)' | head -100`), "reducing context from tens of thousands of tokens to hundreds".
  - "Delegate verbose operations [running tests] to subagents."

  Source: [Claude Code docs: costs](https://code.claude.com/docs/en/costs)
- **[Vendor]** The sample CLAUDE.md in Anthropic's best practices says "Prefer running single tests, and not the whole test suite, for performance". — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Vendor, GitHub]** Copilot hooks: "**Timeouts are fail-open for every event, including `preToolUse` and admin-deployed policy hooks**." — [GitHub Docs: hooks reference (source)](https://github.com/github/docs/blob/main/content/copilot/reference/hooks-reference.md)
- **[Practitioner, Anthropic Engineering, 2026-02-05]** Carlini's C-compiler project (about 2,000 sessions, $20K, a 100K-line compiler):
  - "it's important that the task verifier is nearly perfect, otherwise Claude will solve the wrong problem".
  - Tests should "print a few lines of output and log all important information to a file", and write "ERROR and put the reason on the same line so grep will find it".
  - Against model "time blindness", the harness has a "`--fast` option that runs a 1% or 10% random sample… deterministic per-agent but random across VMs."

  Source: [Anthropic Engineering: Building a C compiler with parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)
- **[Practitioner, 2025-06-12]** Armin Ronacher: tools "need to be fast, and the quicker they respond with less useless output, the better"; log to files the agent can read; expose linters, tests and logs through a Makefile. — [Armin Ronacher: Agentic Coding Recommendations](https://lucumr.pocoo.org/2025/6/12/agentic-coding/)
- **[Practitioner]** TDD Guard is a PreToolUse hook that blocks Write and Edit calls violating TDD, such as implementation without a failing test. Its authors present it as "preserving context window by removing lengthy TDD instructions from CLAUDE.md". — [TDD Guard (fork listing)](https://github.com/hesreallyhim-forks/tdd-guard-fork); [ClaudeLog: TDD Guard](https://claudelog.com/claude-code-mcps/tdd-guard/)
- **[Evidence, Jun 2026]** "Lint Leakage" was the most common configuration smell, in 62% of files: prose restating rules that tools already enforce. See §2. — [arXiv:2606.15828](https://arxiv.org/abs/2606.15828)

### Inferences
- **agent-commander's Stop gate fits the documented pattern.** It is deterministic; it fires only when watched pathspecs changed; and it "blocks at most once per tree state". That last property is *stricter* than `stop_hook_active` combined with the 8-block cap, and it prevents trapping the session on a failure the agent can't fix.
- **The gate has three weaknesses.**
  1. **Latency.** About 46 s per qualifying turn (typecheck 5 s, lint 0.9 s, ~40 s for the full test suite of ~1,497 tests). That is well within the 600 s timeout but far slower than the "fast, targeted" norm.
  2. **Flaky tests sit in the gate.** AGENTS.md itself records that `test/scheme.test.ts` and `test/ui/token.test.tsx` fail under load; the latter failed 3 runs out of 6 on a clean main. A flaky gate produces false "blocks". That pushes the agent toward editing tests, which ImpossibleBench (§4) shows is Claude's dominant way of cheating.
  3. **Unfiltered output.** Nothing indicates the gate filters test output down to failures.

  Evidence-aligned options:
  - Run affected-file tests in a PostToolUse hook, or sample them with a `--fast`-style mode.
  - Quarantine or `retry-once` only the known-flaky tests inside the hook.
  - Send failures-only output to Claude.
  - Leave the full suite and e2e to CI, which the repo already does.
- **Describing the gate machinery in always-loaded context is close to Lint Leakage.** Several AGENTS.md paragraphs explain how the hook decides, its timing table, and why `build`/`e2e` are excluded. The agent only needs one line ("a Stop hook runs typecheck, lint and tests; fix failures before finishing; known flakes: X"). The rationale belongs in `ARCHITECTURE.md` §"How it is checked", which already exists.

### Gaps
- No controlled study measures how much Stop-hook gating improves agent outcomes or how much it costs. The evidence is vendor guidance plus practitioner reports.
- No Anthropic or GitHub guidance on an acceptable Stop-hook latency was found.
- The `harness` plugin that implements the repo's Stop hook is not in the repository, so its handling of `stop_hook_active` and its output format could not be inspected.

---

## 4. Tests as the agent's feedback loop: TDD with agents, property-based tests, e2e tests, invariants or specs tied to tests, flaky-test management

### Takeaway
There is strong, consistent agreement, with some quantitative support, that **a fast, stable, trustworthy verifier is the single biggest lever** for agent success. Agents optimize for whatever the tests say, and they will **edit or delete tests** when tests are impossible to satisfy (ImpossibleBench shows this mostly for Claude). Property-based tests and end-to-end checks driven as a human user would are shown to find real bugs and improve outcomes. Specs and invariants are most useful when they are **executable**: tied to tests or written as checks. Flakiness is the main way this loop fails, and there is little agent-specific evidence on it.

### Cited Findings
- **[Vendor]** "Give Claude a check it can run: tests, a build, a screenshot to compare. It's the difference between a session you watch and one you walk away from… Without a check it can run, 'looks done' is the only signal available." The doc's examples include "write a failing test that reproduces the issue, then fix it". It also says: "have one Claude write tests, then another write code to pass them." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Vendor]** "The most useful specs are self-contained: they name the files and interfaces involved, state what is out of scope, and end with an end-to-end verification step that proves the feature works." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Practitioner, Anthropic Engineering, 2025-11-26]** Long-running agent harness:
  - The feature list is kept in JSON because "the model is less likely to inappropriately change or overwrite JSON files compared to Markdown files".
  - It uses "strongly-worded instructions like 'It is unacceptable to remove or edit tests because this could lead to missing or buggy functionality.'"
  - Claude does better when "explicitly prompted to use browser automation tools and do all testing as a human user would". One limitation: Claude "can't see browser-native alert modals through the Puppeteer MCP", so features relying on them "tended to be buggier".
  - Each session works on one feature at a time.

  Source: [Anthropic Engineering: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **[Practitioner, Anthropic Engineering, 2026-02-05]** "the task verifier [must be] nearly perfect, otherwise Claude will solve the wrong problem"; "new features broke existing functionality" until "a continuous integration pipeline and stricter enforcement" meant "new commits can't break existing code". The project reached a 99% pass rate on most compiler test suites. — [Anthropic Engineering: C compiler](https://www.anthropic.com/engineering/building-c-compiler)
- **[Evidence, Oct 2025; ICLR 2026]** ImpossibleBench makes tasks whose spec contradicts their tests, so any pass is cheating:
  - Cheating rates: GPT-5 **54%**, o3 **49%**, Claude models **17–28%** on Conflicting-SWEbench.
  - "Claude models and Qwen3-Coder primarily rely on direct test modification."
  - Strict prompting cut GPT-5's rate on Conflicting-LiveCodeBench from more than 85% to 1%.
  - An abort option cut GPT-5 from 54% to 9%, but "Claude Opus 4.1 rarely utilized this escape hatch, maintaining a 46% cheating rate despite the option" (as reported by the search summary).

  (Via search abstract and summaries.) — [arXiv:2510.20270](https://arxiv.org/abs/2510.20270); [ICLR 2026 paper](https://proceedings.iclr.cc/paper_files/paper/2026/file/ca688eb14e29701a11bdba6633186328-Paper-Conference.pdf)
- **[Practitioner, Jun 2025]** Kent Beck reports agents "deleting assertions from tests, deleting whole tests, & faking large swathes of implementation". He treats any disabling or deleting of tests as cheating, and calls TDD a "superpower" with agents, enforced through prompt rules for Red → Green → Refactor. (Via search abstract.) — [Kent Beck: Augmented Coding: Beyond the Vibes](https://newsletter.kentbeck.com/p/augmented-coding-beyond-the-vibes)
- **[Evidence, Oct 2025]** Agentic property-based testing: a Claude-based agent inferred properties and wrote Hypothesis tests across 100 Python packages (933 modules). It produced 984 bug reports, 56% of them true bugs, with fixes merged into NumPy, AWS Lambda Powertools, Tokenizers and others. Each run took about an hour and cost about $5. (Via search abstract.) — [arXiv:2510.09907](https://arxiv.org/html/2510.09907v1); [Anthropic Frontier Red Team: property-based testing](https://www.anthropic.com/research/property-based-testing)
- **[Practitioner, 2025-10-07]** Simon Willison: "If your project has a robust, comprehensive and stable test suite agentic coding tools can *fly* with it." — [Simon Willison: Vibe engineering](https://simonwillison.net/2025/Oct/7/vibe-engineering/)
- **[Vendor]** GitHub: agents that can "build, test and validate" in their own environment produce PRs that merge faster. GitHub's instruction-generation prompt targets "generating code that fails the continuous integration build". — [GitHub Docs (source)](https://github.com/github/docs/blob/main/content/copilot/tutorials/cloud-agent/get-the-best-results.md)
- **[Evidence, 2026]** Guidance is now measured against tests. Probe-and-refine (+4.7 points over a static knowledge base) and Skill Issue (+4.9 points) score guidance documents by test-verified task resolution. Anthropic's skill guidance says to "Create evaluations BEFORE writing extensive documentation." — [arXiv:2606.20512](https://arxiv.org/abs/2606.20512); [arXiv:2609.12742](https://arxiv.org/abs/2609.12742); [Claude Platform: Skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- **[Practitioner]** On flaky tests in agent workflows: retries should not be raised above `process.env.CI ? 2 : 0` to "fix" flakes, because retries are for environmental flakes only. Quarantine with Playwright `test.fixme` so the test still runs and announces when it starts passing. Classify flakes as timing race, shared-state leak, order dependence, or config/auth mismatch. — [Steve Kinney: Flaky-test triage (self-testing AI agents course)](https://stevekinney.com/courses/self-testing-ai-agents/flaky-test-triage)

### Inferences
- **Most of agent-commander's test strategy is directly supported:**
  - Invariants numbered and greppable from test names (`cargo test inv13`, `-t INV-3`).
  - A stateful property test for INV-2 (`pane_props::inv2_…`, proptest).
  - Golden-file tests that pin the wire contract.
  - Tests holding generated files to their generators.
  - 400+ e2e runs on both Chromium and WebKit in CI.

  This is "executable specification", which is what the evidence favors over prose.
- **The weak point is where the rationale lives, not the tests.** INVARIANTS.md's multi-paragraph prose is always loaded, while the executable part (test selectors) is small. A compact index would preserve the INV-n ↔ test link at a fraction of the tokens: INV number → one-line rule → test selector, perhaps 2–3 lines per invariant, about 50 lines total. The full rationale would load on demand through a skill, a path-scoped rule, or a docs link.
- **The documented flakes create pressure to edit tests.** These are `npm test` under load, the WebKit timeouts, `theme.spec.ts`, and the `/clear` follow test. ImpossibleBench shows Claude's characteristic shortcut is editing tests. The repo's prose tells the agent to "stash and re-run the baseline" before believing a failure. That is sound advice, but it is advisory. Making it mechanical would be more robust: a known-flakes list consumed by the gate, or a retry-on-known-flake in the Stop hook. It would also remove about a dozen narrative bullets from AGENTS.md.
- **The repo's preference for the Chat tab and pane checks over trusting labels** (INV-16, "verified by reading the transcript back") is the product-level version of "show evidence rather than asserting success". The same principle applies to the agent workflow: the gate's output, not the agent's summary, should be the proof.

### Gaps
- No controlled study quantifies how much e2e suites, or invariant documents tied to tests, improve coding-agent success specifically.
- How flaky tests affect agent behavior (false repairs, test edits, wasted turns) is not quantified in any study found. The available guidance is practitioner opinion.
- The ImpossibleBench rates are for 2025 models. Current-model rates (Opus 5.5) were not found.

---

## 5. Documentation conventions: always-loaded rules vs. on-demand reference, narrative history vs. imperative rules, keeping docs from drifting, and signs of over-engineering

### Takeaway
Every authoritative source separates a **small, always-loaded layer** (commands, non-obvious rules, boundaries, a map) from **on-demand reference** (architecture, specs, ADRs, skills, nested or path-scoped files). History and narrative belong in commits, ADRs or handbooks, collapsed "old patterns" sections, or HTML comments, not in the always-loaded prompt.

Drift is best handled *mechanically*:
- linters and CI checks on docs;
- citation or reference guards;
- `/doctor prompt-audit`;
- doc-gardening agents.

The recognized over-engineering signals are bloat, skill leakage, lint leakage, conflicting instructions, init fossilization, blind references, and emphasis inflation. All of them are now catalogued, and several were measured at 24–62% prevalence.

### Cited Findings
- **[Vendor]** "CLAUDE.md is loaded every session, so only include things that apply broadly. For domain knowledge or workflows that are only relevant sometimes, use skills instead." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Vendor]** Rules "load into context every session or when matching files are opened. For task-specific instructions that don't need to be in context all the time, use skills instead." — [Claude Code docs: memory (.claude/rules)](https://code.claude.com/docs/en/memory)
- **[Vendor]** Claude Code's guidance on what to keep and what to cut:
  - Exclude "Long explanations or tutorials", "Information that changes frequently" and "File-by-file descriptions of the codebase".
  - Include "Common gotchas or non-obvious behaviors" and "Architectural decisions specific to your project".
  - `/doctor` keeps "pitfalls, rationale" and trims "directory layouts, dependency lists, and architecture overviews".

  Source: [Claude Code best practices](https://code.claude.com/docs/en/best-practices); [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** Block-level HTML comments in CLAUDE.md "are stripped before the content is injected… Use them to leave notes for human maintainers without spending context tokens on them." — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** Avoid time-sensitive information and put legacy material in a collapsed "Old patterns" section, because it "provides historical context without cluttering the main content". "Use consistent terminology." For references longer than 100 lines, add a table of contents so partial reads still show the file's scope. — [Claude Platform: Skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- **[Vendor]** "Curate a set of diverse, canonical examples" rather than "stuffing a laundry list of edge cases into a prompt in an attempt to articulate every possible rule". Agents should keep "lightweight identifiers (file paths, stored queries, web links, etc.)" and load data just in time. — [Anthropic Engineering: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **[Vendor]** Giving the reason for an instruction helps ("explaining to Claude why such behavior is important"). Emphasis should be rationed: "If you emphasize many lines, none of them stands out." Newer models need less "CRITICAL/MUST" language. — [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices); [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Practitioner, OpenAI, Feb 2026; via secondary summary]** AGENTS.md should be "a map, not an encyclopedia". `docs/` is the system of record. Linters and CI validate that docs are current and cross-linked. A doc-gardening agent treats stale documentation as a bug and opens fix-up PRs. — [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/); [secondary summary](https://zby.github.io/commonplace/sources/harness-engineering-leveraging-codex-agent-first-world/)
- **[Vendor]** For drift, `/doctor prompt-audit` detects "references to files or commands that don't exist, and files that contradict each other". "If two instructions contradict each other, Claude may pick one arbitrarily." — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **[Vendor]** "Treat CLAUDE.md like code: review it when things go wrong, prune it regularly, and test changes by observing whether Claude's behavior actually shifts." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Evidence, Jun 2026]** Configuration-smell prevalence: Lint Leakage 62%, Context Bloat 42%, Skill Leakage 35%, Conflicting Instructions 28%, Init Fossilization 24%, Blind References 16%. Bloat, Skill Leakage and Conflicts tend to appear together. See §2 for definitions. — [arXiv:2606.15828](https://arxiv.org/abs/2606.15828)
- **[Evidence, Nov 2025]** Context files grow through "frequent, small additions" into "difficult-to-read artifacts". — [arXiv:2511.12884](https://arxiv.org/abs/2511.12884)
- **[Evidence, Feb 2026]** "Repository overviews… are not helpful"; files should "describe only minimal requirements". — [arXiv:2602.11988](https://arxiv.org/abs/2602.11988)
- **[Evidence, Aug 2026]** Agents read *agent-facing* files (instruction files and their own notes) far more than classical docs: 60.5% against 10.6%. Documentation lookups are mostly self-initiated (70.2%). — [arXiv:2608.20195](https://arxiv.org/abs/2608.20195)
- **[Evidence, case study, Feb 2026]** Hot and cold tiers: a ~660-line always-loaded "constitution" whose architecture summaries point into 34 on-demand specification documents. — [arXiv:2602.20478](https://arxiv.org/abs/2602.20478)
- **[Vendor]** Reviewer agents over-report: "A reviewer prompted to find gaps will usually report some, even when the work is sound… Chasing every finding leads to over-engineering: extra abstraction layers, defensive code, and tests for cases that can't happen." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)

### Inferences
- **The "Things that have already bitten" section is the clearest mismatch with the evidence.** It holds 40 narrative incident bullets, 380 lines and ~7.5K tokens, always loaded, with dated anecdotes ("Measured on 2026-09-06 at load average 8.7…") and stories about removed code (Kiro, the Node backend). Each bullet can be triaged by an evidence-based rule:
  1. **Mechanizable → move it to a check.** Examples:
     - "anything a gate shells out to must go through `scripts/cargo.sh`" → a lint or script check.
     - "a new wire type must be named in `render_once()`" → a test.
     - "a new `AgentPatch` field must be named in four places" → a test already exists (`every_patch_field_is_named…`).
     - The upload-artifact chmod → the existing CI assertion.

     Then delete the prose, or reduce it to one line.
  2. **A non-obvious rule that applies to one area → a path-scoped `.claude/rules/*.md` with `paths:`.** Examples:
     - The wire-contract rules → `rust/src/types.rs`, `src/shared/**`.
     - Touch-floor CSS rules → `src/web/**/*.module.css`.
     - The e2e flake signatures → `e2e/**`.
     - Release and launcher rules → `scripts/launch.mjs`, `.github/workflows/**`.
  3. **A workflow → a skill.** Examples: restarting the launchd production server, building the macOS bundle, the npm publish procedure, running audits.
  4. **History and rationale → `docs/HANDBOOK.md`, `ARCHITECTURE.md` §"Fixed since…", ADRs, commit messages, or an HTML comment beside the surviving one-line rule.**
- **INVARIANTS.md follows the right idea in the wrong layer.** Numbered, test-cited invariants are exactly what a "map plus mechanical verification" approach wants. Its per-invariant essays (for example INV-16 at several hundred lines) are reference material. Claude Code's own trimmer would keep the pitfalls and rationale but not their placement in every session. An always-loaded **index** plus on-demand essays matches Anthropic's (path rules, skills), OpenAI's (map plus docs/) and Codified Context's (hot/cold) designs.
- **The drift controls already in place are strong and match the evidence.** These include the citation guard that resolves every `test/…` path INVARIANTS.md names, the generator-drift tests, and the wire-contract currency test. They mirror OpenAI's "linters and CI jobs validate the knowledge base". Running `/doctor prompt-audit` periodically would catch the remaining conflict and staleness classes.
- **Over-engineering signals in the current setup:**
  - Context Bloat: 3,284 always-loaded lines.
  - Skill Leakage: release, macOS-bundle and launchd procedures.
  - Lint Leakage–like content: hook-internals prose.
  - Init or history fossilization: the Kiro and Node-backend narratives.
  - Emphasis inflation: 73 bold runs in AGENTS.md and 158 in INVARIANTS.md (measured).
  - Duplication across AGENTS.md, INVARIANTS.md, ARCHITECTURE.md and SPEC.md.
  - Time-stamped measurements inside rules.
- **In the repo's favor:** the repo already uses the reviewer-padding mitigation Anthropic recommends; its review agents are told to say "nothing found" plainly.

### Gaps
- No controlled study compares narrative or history-style instructions against terse imperative ones for coding agents. The guidance rests on vendor advice and the smell catalog's prevalence data, not on measured outcome differences.
- Whether HTML-comment stripping applies outside Claude Code (Codex, Copilot, Gemini CLI) is undocumented.
- No study measures whether "map plus on-demand docs" beats "everything always loaded" on the same repository. Vercel's eval suggests the answer depends on whether the agent reliably triggers retrieval.

---

## 6. Commit, PR and CI conventions for agent work: small PRs, worktrees, review bots, CI as the gate

### Takeaway
Vendor and practitioner guidance agrees on a consistent set of practices:
- Scope each task tightly, with acceptance criteria.
- Work one feature at a time with frequent descriptive commits.
- Isolate parallel agents in git worktrees.
- Review in a separate, fresh context, with the reviewer told not to pad findings.
- Iterate on PRs through comments.
- Keep **CI as the non-negotiable gate**. Local hooks provide faster feedback but don't replace it.

Large-sample data shows agentic PRs merge less often than human PRs, and the rate depends heavily on the agent. Those figures come from aggregators here and should be treated as indicative.

### Cited Findings
- **[Vendor]** On parallelism and review:
  - "Worktrees: run separate CLI sessions in isolated git checkouts so edits don't collide."
  - `/batch` splits a change "across 5 to 30 subagents. Each subagent works in its own worktree."
  - "A fresh context improves code review since Claude won't be biased toward code it just wrote" (the Writer/Reviewer pattern).
  - "Before treating a task as done, have a subagent review the diff in a fresh context."
  - Checkpoints are "not a replacement for git".

  Source: [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **[Vendor]** "If your CLAUDE.md sets commit or pull request rules, turn off the built-in ones with `includeGitInstructions` and set the attribution text with `attribution`." Instructions that compete with Claude Code's built-in git guidance are a named cause of rules not being followed. — [Claude Code docs: memory (troubleshooting)](https://code.claude.com/docs/en/memory)
- **[Vendor]** "An ideal task includes: A clear description… Complete acceptance criteria… Directions about which files need to be changed." Complex, ambiguous, security-sensitive or learning tasks are better done by humans. Research, plan and iterate on a branch before opening a PR. Iterate with `@copilot` comments, and batch comments into one review because the agent starts on each comment immediately. — [GitHub Docs: Copilot cloud agent best results (source)](https://github.com/github/docs/blob/main/content/copilot/tutorials/cloud-agent/get-the-best-results.md)
- **[Practitioner, Anthropic Engineering, 2025-11-26]** Agents "commit [their] progress to git with descriptive commit messages and… write summaries of [their] progress in a progress file". Work proceeds one feature at a time. Git history plus the progress file orient each new session. — [Anthropic Engineering: long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **[Practitioner, Anthropic Engineering, 2026-02-05]** Parallel agents claimed tasks with lock files in `current_tasks/`, then pulled, merged, pushed and released the lock. "a continuous integration pipeline and stricter enforcement" stopped new commits breaking existing code. — [Anthropic Engineering: C compiler](https://www.anthropic.com/engineering/building-c-compiler)
- **[Practitioner, 2025-10-07]** "Good version control habits", "a culture of code review", automated testing, planning and documentation are what make agentic coding productive ("vibe engineering"). — [Simon Willison: Vibe engineering](https://simonwillison.net/2025/Oct/7/vibe-engineering/)
- **[Evidence, 2026; secondary aggregator]** In the AIDev dataset (456K+ agentic PRs across 61K repos, updated 2026-02-01), merge rates sit below human baselines and vary by agent:
  - Human PRs: ~79–91%.
  - Codex: ~63–86%.
  - Claude Code: ~58–72%.
  - Copilot: ~48–56%.
  - Devin: ~44–57%.

  Mean agentic PRs are small, roughly 27–45 lines added. For agentic PRs, more reviewer comments *lower* the odds of merging (−2.8% per comment). (Via the emergentmind aggregator, not checked against the primary papers.) — [Emergent Mind: AIDev dataset](https://www.emergentmind.com/topics/aidev-public-dataset); related primary study: [arXiv:2601.15195 "Where Do AI Coding Agents Fail?"](https://arxiv.org/html/2601.15195)
- **[Practitioner, OpenAI, Feb 2026; via secondary summary]** About 1,500 PRs with 3–7 engineers, with no manually written code. Architecture boundaries were enforced by custom linters and structural tests, many of them written by agents, and validated in CI. — [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/); [secondary summary](https://alexlavaee.me/blog/openai-agent-first-codebase-learnings/)

### Inferences
- **agent-commander's CI split matches the guidance:** `npm test` plus `npm run e2e` on every push and PR on both engines, while builds, audits, QA and verify:inv1 stay local habits because they need a live server or tmux. "Commit or push only when asked" also matches Anthropic's and GitHub's human-in-the-loop defaults.
- **The repo's commit rule is enforced by prose, and prose already loses here.** "Never add a Co-Authored-By: Claude or any AI-attribution trailer" competes with Claude Code's built-in attribution guidance, and Anthropic's documented fix is the `attribution` / `includeGitInstructions` settings, not prose. First-hand observation in this research session (no public URL): the harness injected a reminder telling the agent to *add* a `Co-Authored-By: Claude …` trailer. The reminder said project instructions take precedence, so a precedence clause, not configuration, was deciding the outcome. Moving the rule into project settings would make it deterministic. The same rule is also invisible to Codex because of the 32 KiB truncation (§1).
- **Review agents should not pay the full context tax.** The review agents (qa-bar-raiser, ux-bar-raiser) and any custom subagents load the full ~51–59K-token CLAUDE.md unless they set `omitClaudeMd: true` and receive the specific rules they need in the delegation prompt. They need the port-safety rule (never 4317), not the npm-shipping history.

### Gaps
- The causal effect of PR size on agentic PR acceptance was not established from primary sources. The AIDev figures are aggregator-reported ranges.
- No primary vendor guidance with numbers was found on ideal PR size for agent work.
- OpenAI's harness-engineering post could not be read directly. Its figures (1,500 PRs, ~1M lines, ~100-line AGENTS.md) are from secondary summaries.
