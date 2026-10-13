//! What a busy agent is running, read from the process table.
//!
//! A Claude agent's transcript says which tool it called; a terminal's says
//! nothing, because there is none to read. The process table knows either way:
//! the tool a busy agent is inside is a child of its process, and `ps` reports
//! when that child started. That is a measurement rather than a claim (INV-11)
//! — a process either exists or it does not — and it is one query for the whole
//! machine however many agents there are (INV-4).
//!
//! On macOS that query is made in-process (`KernelProcs`); elsewhere it is one
//! `ps` (`PsReader`).
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
//! and neither is the agent's own program, or a CLI sitting in its pane's
//! shell would be reported as running itself.
//!
//! Among what is left, the newest wins, because a tool call started after
//! whatever else the agent has open.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use crate::agent_kinds::is_shell_command;
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
///
/// `roots` are the processes the caller is about to walk down from. A reader
/// must include each of them and everything under them, and may leave the
/// rest of the machine out.
#[async_trait]
pub trait ProcApi: Send + Sync + 'static {
    async fn table(&self, now: i64, roots: &[i64]) -> Option<ProcTable>;
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

/// One `ps` per call: the whole machine, whatever the roots.
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
    async fn table(&self, now: i64, _roots: &[i64]) -> Option<ProcTable> {
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
    ProcTable::from_rows(text.lines().filter_map(|line| parse_row(line, now)))
}

/// The cheapest reader this platform has.
#[cfg(target_os = "macos")]
pub fn machine_reader() -> Arc<dyn ProcApi> {
    Arc::new(KernelProcs)
}

/// The cheapest reader this platform has.
#[cfg(not(target_os = "macos"))]
pub fn machine_reader() -> Arc<dyn ProcApi> {
    Arc::new(PsReader::new(Arc::new(crate::env::ExecRunner)))
}

/// The process table read in-process, and only as much of it as is asked for.
///
/// `ps` costs ~40ms of CPU a read, measured, and nearly all of it goes on
/// fetching the arguments of every process on the machine — ~850 here — to
/// answer a question about the handful under the busy agents. This asks the
/// kernel for every process's parent, which costs about a millisecond for the
/// lot, walks down from the roots, and reads start times and arguments only
/// for what it finds there. The start is the kernel's own rather than `etime`
/// counted back from now, so it does not drift a second between passes.
#[cfg(target_os = "macos")]
pub struct KernelProcs;

#[cfg(target_os = "macos")]
#[async_trait]
impl ProcApi for KernelProcs {
    async fn table(&self, _now: i64, roots: &[i64]) -> Option<ProcTable> {
        kernel::table(roots)
    }
}

#[cfg(target_os = "macos")]
mod kernel {
    use super::{Proc, ProcTable, MS_PER_SECOND};
    use libc::c_int;
    use std::collections::{HashMap, HashSet};
    use std::mem::size_of;
    use std::ops::Range;

    /// `struct kinfo_proc` on 64-bit macOS. It opens with `p_starttime`, a
    /// `timeval`: seconds, then microseconds.
    const KINFO_PROC_BYTES: usize = 648;
    const START_SECONDS: Range<usize> = 0..8;
    const START_MICROS: Range<usize> = 8..12;
    const MICROS_PER_MS: i64 = 1_000;
    /// Room for processes started between counting the pids and listing them.
    const PIDS_HEADROOM: usize = 64;

    /// What the short BSD record says about one process.
    struct Entry {
        ppid: i32,
        /// The kernel's name for it, for when its arguments cannot be read.
        comm: String,
    }

    pub(super) fn table(roots: &[i64]) -> Option<ProcTable> {
        let entries = every_entry()?;
        let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
        for (pid, entry) in &entries {
            children.entry(entry.ppid).or_default().push(*pid);
        }
        let mut args = ArgsArea::new()?;
        let rows = under(roots, &children)
            .into_iter()
            .filter_map(|pid| {
                let entry = entries.get(&pid)?;
                Some(Proc {
                    pid: pid.into(),
                    ppid: entry.ppid.into(),
                    started_at: started_at(pid)?,
                    argv: args.argv(pid).unwrap_or_else(|| vec![entry.comm.clone()]),
                })
            })
            .collect::<Vec<Proc>>();
        Some(ProcTable::from_rows(rows))
    }

    /// The roots and everything below them, each once.
    fn under(roots: &[i64], children: &HashMap<i32, Vec<i32>>) -> Vec<i32> {
        let mut seen = HashSet::new();
        let mut found = Vec::new();
        let mut frontier: Vec<i32> =
            roots.iter().filter_map(|root| i32::try_from(*root).ok()).collect();
        while let Some(pid) = frontier.pop() {
            if seen.insert(pid) {
                found.push(pid);
                frontier.extend(children.get(&pid).into_iter().flatten());
            }
        }
        found
    }

    /// Every process's parent and name. The short record is the one the
    /// kernel hands out for any process, root's included; the full one only
    /// for our own.
    fn every_entry() -> Option<HashMap<i32, Entry>> {
        // SAFETY: a null buffer asks for the count alone.
        let counted = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        let capacity = usize::try_from(counted).ok()? + PIDS_HEADROOM;
        let mut pids: Vec<c_int> = vec![0; capacity];
        let bytes = c_int::try_from(capacity * size_of::<c_int>()).ok()?;
        // SAFETY: the kernel writes at most `bytes` bytes, and the buffer was
        // sized to hold that many.
        let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        pids.truncate(usize::try_from(listed).ok()?);
        Some(pids.into_iter().filter_map(|pid| Some((pid, short_entry(pid)?))).collect())
    }

    fn short_entry(pid: c_int) -> Option<Entry> {
        // SAFETY: an all-zero record is a valid value of a plain C struct.
        let mut info: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
        let size = c_int::try_from(size_of::<libc::proc_bsdshortinfo>()).ok()?;
        // SAFETY: the buffer is a record of exactly the size passed.
        let written = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, 0, (&raw mut info).cast(), size)
        };
        if written != size {
            return None;
        }
        let name: Vec<u8> = info.pbsi_comm.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
        Some(Entry {
            ppid: i32::try_from(info.pbsi_ppid).ok()?,
            comm: String::from_utf8_lossy(&name).into_owned(),
        })
    }

    /// Epoch milliseconds the process started at, from its `kinfo_proc`.
    fn started_at(pid: c_int) -> Option<i64> {
        let mut record = [0u8; KINFO_PROC_BYTES];
        let written = sysctl(&mut [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid], &mut record)?;
        // A pid with no process behind it is answered with nothing at all.
        if written != KINFO_PROC_BYTES {
            return None;
        }
        let seconds = i64::from_ne_bytes(record[START_SECONDS].try_into().ok()?);
        let micros = i32::from_ne_bytes(record[START_MICROS].try_into().ok()?);
        Some(seconds * MS_PER_SECOND + i64::from(micros) / MICROS_PER_MS)
    }

    /// One buffer, sized once, for reading argument areas into.
    ///
    /// Sized to `kern.argmax` because a smaller one is not refused: the
    /// kernel copies the *end* of the area into it, which is environment
    /// rather than arguments.
    struct ArgsArea {
        buffer: Vec<u8>,
    }

    impl ArgsArea {
        fn new() -> Option<Self> {
            let mut max = [0u8; size_of::<c_int>()];
            sysctl(&mut [libc::CTL_KERN, libc::KERN_ARGMAX], &mut max)?;
            let max = usize::try_from(c_int::from_ne_bytes(max)).ok()?;
            Some(Self { buffer: vec![0; max] })
        }

        /// `None` for a process whose arguments are not ours to read — any
        /// other user's — and the caller falls back to its name.
        fn argv(&mut self, pid: c_int) -> Option<Vec<String>> {
            let written = sysctl(&mut [libc::CTL_KERN, libc::KERN_PROCARGS2, pid], &mut self.buffer)?;
            super::parse_procargs(&self.buffer[..written])
        }
    }

    /// Read a sysctl into `buffer`, returning how much of it was written.
    fn sysctl(name: &mut [c_int], buffer: &mut [u8]) -> Option<usize> {
        let mut written = buffer.len();
        let depth = libc::c_uint::try_from(name.len()).ok()?;
        // SAFETY: `buffer` is writable for `written` bytes, the kernel writes
        // at most that many and reports how many it did, and nothing is set.
        let status = unsafe {
            libc::sysctl(
                name.as_mut_ptr(),
                depth,
                buffer.as_mut_ptr().cast(),
                &mut written,
                std::ptr::null_mut(),
                0,
            )
        };
        (status == 0).then_some(written)
    }
}

/// The words of a `KERN_PROCARGS2` area: `argc`, the executable's path, NUL
/// padding, then `argc` NUL-terminated arguments, environment after them.
///
/// Split on whitespace once joined, because that is what a `ps` row is split
/// on: the same process reads the same on a card whichever reader saw it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_procargs(area: &[u8]) -> Option<Vec<String>> {
    let (argc, rest) = area.split_first_chunk::<{ std::mem::size_of::<i32>() }>()?;
    let argc = usize::try_from(i32::from_ne_bytes(*argc)).ok()?;
    let after_the_path = rest.iter().position(|byte| *byte == 0)?;
    let args: Vec<String> = rest[after_the_path..]
        .split(|byte| *byte == 0)
        .filter(|arg| !arg.is_empty())
        .take(argc)
        .map(|arg| String::from_utf8_lossy(arg).into_owned())
        .collect();
    let words: Vec<String> = args.join(" ").split_whitespace().map(str::to_string).collect();
    (!words.is_empty()).then_some(words)
}

impl ProcTable {
    /// Index rows both ways.
    fn from_rows(rows: impl IntoIterator<Item = Proc>) -> Self {
        let mut table = ProcTable::default();
        for row in rows {
            table.children.entry(row.ppid).or_default().push(row.pid);
            table.by_pid.insert(row.pid, row);
        }
        table
    }

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

/// A shell is never what the agent is running; it is how it runs things.
///
/// This used to also skip the agent's own program by name, for a kind that
/// was found from tmux by its process name. No kind is, now: Claude Code
/// rewrites its process title to its version number and a terminal's root
/// *is* its shell, so the name list had nothing left to say.
fn is_the_agent_or_its_shell(proc_: &Proc, _kind: &str) -> bool {
    is_shell(proc_)
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
    use crate::agent_kinds::{CLAUDE_KIND, TERMINAL_KIND};

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
    /// A pane's own shell, and the program somebody ran in it.
    const PANE_SHELL: i64 = 10;
    const IN_SHELL: i64 = 11;
    const IN_SHELL_TOOL: i64 = 12;

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
            row(IN_SHELL, PANE_SHELL, "00:01", "make all"),
        ]
        .concat();
        assert_eq!(running_of(&parse_table(&text, NOW), NOT_A_PROCESS, CLAUDE_KIND), None);
    }

    #[test]
    fn a_shell_is_never_the_answer_even_when_it_is_the_newest() {
        let text = row(SHELL_WRAPPER, CLAUDE, "00:01", "/bin/zsh -c sleep 5");
        assert_eq!(running_of(&parse_table(&text, NOW), CLAUDE, CLAUDE_KIND), None);
    }

    #[test]
    fn nothing_under_the_root_or_no_root_at_all_is_none() {
        assert_eq!(running_of(&table(), INIT, CLAUDE_KIND), None);
        assert_eq!(running_of(&ProcTable::default(), CLAUDE, CLAUDE_KIND), None);
    }

    /// The other half of the rule, and why a terminal still reports: its root
    /// is the pane's own shell, so everything under it is its work — the
    /// newest thing, not the program that started it.
    #[test]
    fn a_pane_whose_root_is_a_shell_reports_what_runs_in_it() {
        let text = [
            row(PANE_SHELL, INIT, "10:00", "-zsh"),
            row(IN_SHELL, PANE_SHELL, "09:00", "make watch"),
            row(IN_SHELL_TOOL, IN_SHELL, "00:30", "npm test"),
        ]
        .concat();
        let running = running_of(&parse_table(&text, NOW), PANE_SHELL, TERMINAL_KIND).unwrap();
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

    /* ------------------------------------------------- the kernel reader */

    /// A `KERN_PROCARGS2` area as the kernel lays it out.
    fn args_area(path: &str, args: &[&str], environment: &[&str]) -> Vec<u8> {
        let argc = i32::try_from(args.len()).unwrap();
        let mut area = argc.to_ne_bytes().to_vec();
        area.extend_from_slice(path.as_bytes());
        // The path is padded out with NULs before the first argument.
        area.extend_from_slice(&[0; 4]);
        for text in args.iter().chain(environment) {
            area.extend_from_slice(text.as_bytes());
            area.push(0);
        }
        area
    }

    #[test]
    fn reads_the_arguments_and_stops_before_the_environment() {
        let area = args_area("/usr/bin/cargo", &["cargo", "test", "--quiet"], &["HOME=/Users/demo"]);
        assert_eq!(parse_procargs(&area).unwrap(), ["cargo", "test", "--quiet"]);
    }

    /// The same words `ps` would have printed, so a card reads the same
    /// whichever reader saw the process.
    #[test]
    fn splits_an_argument_with_spaces_the_way_a_ps_row_is_split() {
        let area = args_area("/bin/zsh", &["/bin/zsh", "-c", "source snap.sh && cargo test"], &[]);
        let from_ps = parse_table(&row(TOOL_CALL, CLAUDE, "00:01", "/bin/zsh -c source snap.sh && cargo test"), NOW);
        assert_eq!(parse_procargs(&area).unwrap(), from_ps.get(TOOL_CALL).unwrap().argv);
    }

    #[test]
    fn an_area_with_no_arguments_is_nothing() {
        assert!(parse_procargs(&args_area("/bin/true", &[], &[])).is_none());
        assert!(parse_procargs(&[]).is_none());
    }

    /// The real kernel, against a child this test starts: it is found under
    /// its parent with its own arguments and a start time of about now, and
    /// what is not under the root is left out.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn the_kernel_reader_finds_a_child_under_its_root_and_nothing_else() {
        const SLEEP_SECONDS: &str = "30";
        const CLOCK_SLACK_MS: i64 = 5_000;
        let mut child = std::process::Command::new("sleep").arg(SLEEP_SECONDS).spawn().unwrap();
        let own = i64::from(std::process::id());
        let child_pid = i64::from(child.id());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let table = KernelProcs.table(now, &[own]).await.unwrap();
        let _ = child.kill();
        let _ = child.wait();

        let found = table.get(child_pid).expect("the child is under its parent");
        assert_eq!(found.ppid, own);
        assert_eq!(found.argv, ["sleep", SLEEP_SECONDS]);
        assert!((found.started_at - now).abs() < CLOCK_SLACK_MS, "started {} vs now {now}", found.started_at);
        assert!(table.get(own).is_some(), "the root itself is in the table");
        assert!(table.get(INIT).is_none(), "the rest of the machine was read in");
    }
}
