//! What a busy agent is running, read from the process table.
//!
//! A Claude agent's transcript says which tool it called; a Kiro agent's says
//! nothing, because there is none to read. The process table knows either way:
//! the tool a busy agent is inside is a child of its process, and `ps` reports
//! when that child started. That is a measurement rather than a claim (INV-11)
//! — a process either exists or it does not — and it is one query for the whole
//! machine however many agents there are (INV-4).
//!
//! The walk starts at the agent's own pid: the CLI process for a Claude session,
//! the pane's root process for a tmux-discovered one.
//!
//! **Only what runs below a shell the agent spawned counts, and that is what
//! separates work from furniture.** Measured against five live Claude sessions:
//! every tool call sat under a `zsh -c source <shell snapshot> && <command>`
//! wrapper, while the MCP servers and the `caffeinate` that keeps the machine
//! awake were direct children of the CLI. Two of those sessions were thinking
//! rather than calling a tool and had nothing but MCP servers under them, so
//! "the newest child" would have captioned them `running node index.js · 1d 2h`
//! — a true sentence about a process and a false one about the agent's work,
//! which is the INV-11 failure this whole feature is meant to avoid. And
//! `caffeinate` is restarted every few minutes, so it was the newest child on
//! three of the five.
//!
//! For a tmux-discovered agent the root *is* the pane's shell, so everything
//! under it qualifies — which is right: what a foreign CLI's pane is running is
//! the only account of its work there is. A shell is never itself the answer,
//! and neither is the agent's own program, or a Kiro sitting in its pane's
//! shell would be reported as running itself.
//!
//! Among what is left, the newest wins, because a tool call started after
//! whatever else the agent has open.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use crate::agent_kinds::{is_shell_command, spec_of};
use crate::env::CommandRunner;
use crate::types::RunningProcess;

/// One row of `ps`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: i64,
    pub ppid: i64,
    /// Epoch milliseconds, to the second — `etime` has no finer resolution.
    pub started_at: i64,
    pub argv: Vec<String>,
}

/// The machine's processes, indexed both ways.
#[derive(Debug, Default)]
pub struct ProcTable {
    by_pid: HashMap<i64, Proc>,
    children: HashMap<i64, Vec<i64>>,
}

/// Reads the process table, or nothing when it could not be read.
#[async_trait]
pub trait ProcApi: Send + Sync + 'static {
    async fn table(&self, now: i64) -> Option<ProcTable>;
}

/// `ps` is portable between macOS and Linux in exactly this spelling: `-axo`
/// with these four columns and `=` to suppress the header. `etime` is
/// `[[dd-]hh:]mm:ss` on both.
const PS_ARGS: &[&str] = &["-axo", "pid=,ppid=,etime=,command="];

/// Generous: one read over a few thousand processes takes tens of milliseconds,
/// and a machine at its process cap may not be able to fork at all.
const PS_TIMEOUT: Duration = Duration::from_secs(5);

/// How much of a command line a card has room for.
const COMMAND_CHARS: usize = 40;

/// How many arguments are allowed to help name the job. Two, because
/// `npm run <script>` needs both and nothing here has needed a third.
const NAMING_ARGS: usize = 2;

const MS_PER_SECOND: i64 = 1_000;
const SECONDS_PER_MINUTE: i64 = 60;
const SECONDS_PER_HOUR: i64 = 3_600;
const SECONDS_PER_DAY: i64 = 86_400;

/// The real thing: one `ps` per call.
pub struct PsReader {
    runner: Arc<dyn CommandRunner>,
}

impl PsReader {
    pub fn new(runner: Arc<dyn CommandRunner>) -> Self {
        PsReader { runner }
    }
}

#[async_trait]
impl ProcApi for PsReader {
    async fn table(&self, now: i64) -> Option<ProcTable> {
        let text = self.runner.run("ps", PS_ARGS, PS_TIMEOUT).await?;
        Some(parse_table(&text, now))
    }
}

/// `etime` → seconds. `02-03:19:32`, `01:02:03`, `00:50`.
pub fn parse_etime(text: &str) -> Option<i64> {
    let (days, clock) = match text.split_once('-') {
        Some((d, rest)) => (d.parse::<i64>().ok()?, rest),
        None => (0, text),
    };
    let mut fields: Vec<i64> = Vec::new();
    for part in clock.split(':') {
        fields.push(part.parse().ok()?);
    }
    let (hours, minutes, seconds) = match fields.as_slice() {
        [m, s] => (0, *m, *s),
        [h, m, s] => (*h, *m, *s),
        _ => return None,
    };
    Some(days * SECONDS_PER_DAY + hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds)
}

fn parse_row(line: &str, now: i64) -> Option<Proc> {
    let mut fields = line.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    let ppid = fields.next()?.parse().ok()?;
    let elapsed = parse_etime(fields.next()?)?;
    let argv: Vec<String> = fields.map(str::to_string).collect();
    if argv.is_empty() {
        return None;
    }
    Some(Proc { pid, ppid, started_at: now - elapsed * MS_PER_SECOND, argv })
}

/// Rows that cannot be read are dropped one at a time, never the table.
pub fn parse_table(text: &str, now: i64) -> ProcTable {
    let mut table = ProcTable::default();
    for row in text.lines().filter_map(|line| parse_row(line, now)) {
        table.children.entry(row.ppid).or_default().push(row.pid);
        table.by_pid.insert(row.pid, row);
    }
    table
}

impl ProcTable {
    pub fn get(&self, pid: i64) -> Option<&Proc> {
        self.by_pid.get(&pid)
    }

    /// Every process under `root`, at any depth, in no particular order.
    ///
    /// A pid is visited once. Nothing in a healthy `ps` parents a process to
    /// itself, but this parses whatever `ps` prints, and a cycle here would
    /// spin inside an enrichment pass — which does not crash, it hangs, and
    /// takes every card's activity line down with it for the life of the
    /// process.
    pub fn descendants(&self, root: i64) -> Vec<&Proc> {
        self.walk(root).into_iter().map(|(proc_, _)| proc_).collect()
    }

    /// Every process under `root` with a shell between it and `root`.
    ///
    /// See the module comment: that is what a tool call has and an MCP server
    /// does not. The root's own row counts as that shell, so a tmux agent —
    /// whose root *is* the pane's shell — has all of its work included.
    fn below_a_shell(&self, root: i64) -> Vec<&Proc> {
        self.walk(root)
            .into_iter()
            .filter(|(_, shell_above)| *shell_above)
            .map(|(proc_, _)| proc_)
            .collect()
    }

    /// Each process under `root`, with whether a shell stands between them.
    fn walk(&self, root: i64) -> Vec<(&Proc, bool)> {
        let mut out = Vec::new();
        let mut seen: HashSet<i64> = HashSet::from([root]);
        let mut frontier = vec![(root, self.by_pid.get(&root).is_some_and(is_shell))];
        while let Some((pid, shell_above)) = frontier.pop() {
            for child in self.children.get(&pid).into_iter().flatten() {
                let Some(proc_) = self.by_pid.get(child) else { continue };
                if !seen.insert(*child) {
                    continue;
                }
                out.push((proc_, shell_above));
                frontier.push((*child, shell_above || is_shell(proc_)));
            }
        }
        out
    }
}

fn is_shell(proc_: &Proc) -> bool {
    is_shell_command(basename(&proc_.argv[0]))
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// A shell, or the agent's own program: neither is what the agent is running.
fn is_the_agent_or_its_shell(proc_: &Proc, kind: &str) -> bool {
    if is_shell(proc_) {
        return true;
    }
    let name = basename(&proc_.argv[0]);
    spec_of(kind).is_some_and(|spec| spec.process_names.contains(&name))
}

/// The program and the words that say which job it is doing.
///
/// Arguments up to the first flag, and at most two of them: `npm run build`
/// keeps the script name, which is the whole of what distinguishes one npm run
/// from another, while `cargo test --manifest-path …` stops at `cargo test`
/// rather than trailing a path nobody reads on a card. A path is shown by its
/// basename, so `node /long/path/index.js` reads `node index.js`.
fn describe(proc_: &Proc) -> String {
    let mut words = vec![basename(&proc_.argv[0])];
    words.extend(
        proc_.argv[1..]
            .iter()
            .take_while(|arg| !arg.starts_with('-'))
            .take(NAMING_ARGS)
            .map(|arg| if arg.contains('/') { basename(arg) } else { arg.as_str() }),
    );
    words.join(" ").chars().take(COMMAND_CHARS).collect()
}

/// The newest process under `root` that is work rather than furniture.
///
/// Newest by start time, with the higher pid breaking a tie inside the same
/// second, since a pid handed out later is the later process.
///
/// A root of zero is not a process. `pending.rs` gives a just-spawned agent
/// `pid: 0` until the CLI writes its session file, and a walk from there
/// reaches init and therefore every process on the machine — which would
/// caption that card with whatever the machine started last.
pub fn running_of(table: &ProcTable, root: i64, kind: &str) -> Option<RunningProcess> {
    if root <= 0 {
        return None;
    }
    table
        .below_a_shell(root)
        .into_iter()
        .filter(|p| !is_the_agent_or_its_shell(p, kind))
        .max_by_key(|p| (p.started_at, p.pid))
        .map(|p| RunningProcess { pid: p.pid, command: describe(p), since: p.started_at })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_kinds::CLAUDE_KIND;

    const NOW: i64 = 1_788_600_000_000;

    /* ------------------------------------------------------------ fixtures */

    /*
     * The pids are named because a tree written as six rows of digits is a
     * puzzle rather than a fixture: every assertion below then says which
     * process it means instead of quoting a number back.
     */
    const CLAUDE: i64 = 99_984;
    const INIT: i64 = 1;
    /// Two MCP servers, started with the session and still its direct children.
    const MCP_SERVER: i64 = 107;
    const MCP_BROWSER: i64 = 108;
    /// Claude Code's own keep-awake, restarted every few minutes.
    const KEEP_AWAKE: i64 = 74_644;
    /// A Bash tool call: the shell-snapshot wrapper, the command, its child.
    const SHELL_WRAPPER: i64 = 77_904;
    const TOOL_CALL: i64 = 77_910;
    const TEST_BINARY: i64 = 77_911;
    /// A pane's own shell, and the foreign CLI sitting in it.
    const PANE_SHELL: i64 = 10;
    const KIRO: i64 = 11;
    const KIRO_TOOL: i64 = 12;

    /// One `ps` row. Elapsed time is a string because that is what `ps` prints.
    fn row(pid: i64, ppid: i64, etime: &str, command: &str) -> String {
        format!("{pid} {ppid} {etime} {command}\n")
    }

    /// The tree observed under a live Claude session while this was designed:
    /// two MCP servers and a `caffeinate` as direct children, and a tool call
    /// running through the shell-snapshot wrapper.
    fn live_tree() -> String {
        [
            row(MCP_SERVER, CLAUDE, "02-03:19:32", "/opt/homebrew/bin/node /Users/demo/mcp/build/index.js"),
            row(MCP_BROWSER, CLAUDE, "02-03:19:32", "chrome-devtools-mcp"),
            row(KEEP_AWAKE, CLAUDE, "00:50", "caffeinate -i -t 300"),
            row(SHELL_WRAPPER, CLAUDE, "00:03", "/bin/zsh -c source /Users/demo/.claude/snapshot.sh && cargo test"),
            row(TOOL_CALL, SHELL_WRAPPER, "00:02", "cargo test --manifest-path rust/Cargo.toml"),
            row(TEST_BINARY, TOOL_CALL, "00:01", "/Users/demo/rust/target/debug/deps/agent_commander-abc"),
        ]
        .concat()
    }

    fn table() -> ProcTable {
        parse_table(&live_tree(), NOW)
    }

    /* --------------------------------------------------------- the parser */

    /// A `[[dd-]hh:]mm:ss` clock as its parts, so an expectation below reads
    /// the way the string it is about does.
    struct Clock {
        days: i64,
        hours: i64,
        minutes: i64,
        seconds: i64,
    }

    impl Clock {
        fn as_seconds(&self) -> i64 {
            self.days * SECONDS_PER_DAY
                + self.hours * SECONDS_PER_HOUR
                + self.minutes * SECONDS_PER_MINUTE
                + self.seconds
        }
    }

    #[test]
    fn parses_every_etime_shape_ps_prints() {
        let mm_ss = Clock { days: 0, hours: 0, minutes: 0, seconds: 50 };
        let hh_mm_ss = Clock { days: 0, hours: 1, minutes: 2, seconds: 3 };
        let with_days = Clock { days: 2, hours: 3, minutes: 19, seconds: 32 };
        assert_eq!(parse_etime("00:50"), Some(mm_ss.as_seconds()));
        assert_eq!(parse_etime("01:02:03"), Some(hh_mm_ss.as_seconds()));
        assert_eq!(parse_etime("02-03:19:32"), Some(with_days.as_seconds()));
        assert_eq!(parse_etime("garbage"), None);
        assert_eq!(parse_etime("1:2:3:4"), None);
    }

    #[test]
    fn a_row_that_cannot_be_read_costs_only_itself() {
        const LAUNCHD: i64 = 1;
        const SSHD: i64 = 2;
        let text = format!(
            "{}not a row\n{}",
            row(LAUNCHD, 0, "00:01", "launchd"),
            row(SSHD, LAUNCHD, "00:01", "sshd")
        );
        let table = parse_table(&text, NOW);
        assert!(table.get(LAUNCHD).is_some());
        assert!(table.get(SSHD).is_some());
        assert_eq!(table.descendants(LAUNCHD).len(), 1);
    }

    /* ----------------------------------------------------------- the walk */

    #[test]
    fn walks_every_depth_under_the_root() {
        /// Everything in `live_tree` except the root itself.
        const EVERYTHING_UNDER_CLAUDE: usize = 6;
        let pids: Vec<i64> = table().descendants(CLAUDE).iter().map(|p| p.pid).collect();
        assert_eq!(pids.len(), EVERYTHING_UNDER_CLAUDE);
        assert!(pids.contains(&TEST_BINARY), "a grandchild's child was dropped");
    }

    /// A table that parents a process to itself would otherwise spin here
    /// forever, inside an enrichment pass, taking every card down with it.
    #[test]
    fn a_process_parented_to_itself_does_not_spin() {
        const OUROBOROS: i64 = 7;
        const ITS_CHILD: i64 = 8;
        let text = format!(
            "{}{}",
            row(OUROBOROS, OUROBOROS, "00:01", "ouroboros"),
            row(ITS_CHILD, OUROBOROS, "00:01", "cargo test")
        );
        assert_eq!(parse_table(&text, NOW).descendants(OUROBOROS).len(), 1);
    }

    /* -------------------------------------------------- which one is work */

    #[test]
    fn the_newest_thing_below_a_shell_is_the_tool_call() {
        let running = running_of(&table(), CLAUDE, CLAUDE_KIND).unwrap();
        // Not the shell that wraps it, not the MCP servers that predate it, and
        // not `caffeinate`: the test binary is the youngest thing in the tree.
        assert_eq!(running.pid, TEST_BINARY);
        assert_eq!(running.command, "agent_commander-abc");
        assert_eq!(running.since, NOW - MS_PER_SECOND);
    }

    /// An agent that is thinking has its MCP servers under it and no tool
    /// call. Measured on two of five live sessions, and "the newest child"
    /// would have called a day-old server this agent's current work (INV-11).
    #[test]
    fn an_agent_with_only_its_own_furniture_is_running_nothing() {
        let text = [
            row(MCP_SERVER, CLAUDE, "01-00:00:00", "/opt/homebrew/bin/node /Users/demo/mcp/build/index.js"),
            row(MCP_BROWSER, CLAUDE, "01-00:00:00", "chrome-devtools-mcp"),
            row(KEEP_AWAKE, CLAUDE, "00:50", "caffeinate -i -t 300"),
        ]
        .concat();
        assert_eq!(running_of(&parse_table(&text, NOW), CLAUDE, CLAUDE_KIND), None);
    }

    /// `pending.rs` gives a just-spawned agent `pid: 0` until the CLI writes
    /// its session file. A walk from there reaches init, and from init the
    /// whole machine.
    #[test]
    fn a_root_that_is_not_a_process_claims_nothing() {
        const NOT_A_PROCESS: i64 = 0;
        let text = [
            row(INIT, NOT_A_PROCESS, "10:00", "/sbin/launchd"),
            row(PANE_SHELL, INIT, "00:01", "/bin/zsh -c make"),
            row(KIRO, PANE_SHELL, "00:01", "make all"),
        ]
        .concat();
        assert_eq!(running_of(&parse_table(&text, NOW), NOT_A_PROCESS, CLAUDE_KIND), None);
    }

    #[test]
    fn a_shell_is_never_the_answer_even_when_it_is_the_newest() {
        let text = row(SHELL_WRAPPER, CLAUDE, "00:01", "/bin/zsh -c sleep 5");
        assert_eq!(running_of(&parse_table(&text, NOW), CLAUDE, CLAUDE_KIND), None);
    }

    /// A Kiro in a pane's shell: the walk from the pane's root finds the CLI
    /// itself before anything else, and must not report it as its own tool.
    #[test]
    fn the_agents_own_program_is_skipped() {
        let busy = [
            row(PANE_SHELL, INIT, "10:00", "-zsh"),
            row(KIRO, PANE_SHELL, "09:00", "kiro-cli chat"),
            row(KIRO_TOOL, KIRO, "00:30", "npm test"),
        ]
        .concat();
        let running = running_of(&parse_table(&busy, NOW), INIT, "kiro").unwrap();
        assert_eq!(running.command, "npm test");

        let idle = [
            row(PANE_SHELL, INIT, "10:00", "-zsh"),
            row(KIRO, PANE_SHELL, "09:00", "kiro-cli chat"),
        ]
        .concat();
        assert_eq!(running_of(&parse_table(&idle, NOW), INIT, "kiro"), None);
    }

    #[test]
    fn nothing_under_the_root_or_no_root_at_all_is_none() {
        assert_eq!(running_of(&table(), INIT, CLAUDE_KIND), None);
        assert_eq!(running_of(&ProcTable::default(), CLAUDE, CLAUDE_KIND), None);
    }

    /// The other half of the rule, and why a tmux agent still reports: its
    /// root is the pane's own shell, so everything under it is its work.
    #[test]
    fn a_pane_whose_root_is_a_shell_reports_what_runs_in_it() {
        let text = [
            row(PANE_SHELL, INIT, "10:00", "-zsh"),
            row(KIRO, PANE_SHELL, "09:00", "kiro-cli chat"),
            row(KIRO_TOOL, KIRO, "00:30", "npm test"),
        ]
        .concat();
        let running = running_of(&parse_table(&text, NOW), PANE_SHELL, "kiro").unwrap();
        assert_eq!(running.command, "npm test");
    }

    /* ------------------------------------------------------ the description */

    #[test]
    fn describes_a_command_by_the_words_that_name_the_job() {
        const UNDER_ONE_ROOT: i64 = 9;
        const NODE: i64 = 1;
        const CARGO: i64 = 2;
        const NPM: i64 = 3;
        const CLANG: i64 = 4;
        const VERY_LONG: i64 = 5;
        let text = [
            row(NODE, UNDER_ONE_ROOT, "00:01", "/opt/homebrew/bin/node /Users/demo/mcp/build/index.js"),
            row(CARGO, UNDER_ONE_ROOT, "00:01", "cargo test --manifest-path rust/Cargo.toml"),
            row(NPM, UNDER_ONE_ROOT, "00:01", "npm run verify:layout"),
            row(CLANG, UNDER_ONE_ROOT, "00:01", "clang -x c -arch arm64 symbols.o"),
            row(VERY_LONG, UNDER_ONE_ROOT, "00:01", &format!("python3 {}", "x".repeat(COMMAND_CHARS * 2))),
        ]
        .concat();
        let table = parse_table(&text, NOW);
        let described = |pid| describe(table.get(pid).unwrap());
        assert_eq!(described(NODE), "node index.js");
        assert_eq!(described(CARGO), "cargo test");
        // The script name is the whole of what tells one `npm run` from
        // another, and stopping at the first argument threw it away.
        assert_eq!(described(NPM), "npm run verify:layout");
        // Nothing before the first flag: the program alone is what is known.
        assert_eq!(described(CLANG), "clang");
        assert_eq!(described(VERY_LONG).chars().count(), COMMAND_CHARS);
    }

    #[test]
    fn a_tie_on_the_second_goes_to_the_later_pid() {
        const WRAPPER: i64 = 4;
        const ALPHA: i64 = 5;
        const BETA: i64 = 6;
        let text = [
            row(WRAPPER, INIT, "00:02", "/bin/zsh -c work"),
            row(ALPHA, WRAPPER, "00:01", "alpha"),
            row(BETA, WRAPPER, "00:01", "beta"),
        ]
        .concat();
        let running = running_of(&parse_table(&text, NOW), INIT, CLAUDE_KIND).unwrap();
        assert_eq!(running.command, "beta");
    }
}
