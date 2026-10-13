//! Discovers the Claude Code sessions running on this machine.
//!
//! Port of `src/server/registry.ts`.
//!
//! Two sources, deliberately:
//!   - `~/.claude/sessions/<pid>.json` is the fast path. A write to it is
//!     pushed by a directory watch; the short tick checks what no write
//!     announces — a process that died or a pid handed on — and re-reads the
//!     directory only when that, a waiting spawn or the watch's youth says to.
//!     It carries the `tmux` pane id, which the supported CLI does not expose.
//!   - `claude agents --json` is authoritative for *presence*, but costs ~680ms
//!     per call, so it is never on the fast path (INV-4). Collapsing the two
//!     into one poll is the mistake this comment exists to prevent: the fleet
//!     list would then refresh at best twice a second on a good machine and
//!     would serialise behind a subprocess on a loaded one.
//!
//! The CLI is asked when there is a question for it — an id it has not
//! vouched for, or a pid it vouched for that a different process now holds —
//! and otherwise only as a slow backstop. See `process_start`.
//!
//! Most new sessions never become a question at all. Claude Code writes the
//! start of its own process into the file as `procStart`, and a file naming
//! the process that holds its pid now is the answer the CLI would give; one
//! naming another process is a ghost until the CLI says otherwise, and is
//! held back from the first fleet onwards. See `Evidence`.
//!
//! INV-5: the session file is an internal format. If it disappears or changes
//! shape, agents still list — they just lose the attach capability.

use crate::agent_kinds::CLAUDE_KIND;
use crate::env::{exec_runner, CommandRunner};
use crate::sources::{AgentPatch, AgentSource, Unsubscribe};
use crate::types::{Agent, AgentStatus};
use async_trait::async_trait;
use notify::{RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

/// The cheap tick: a liveness check per session, and the directory read when
/// that check or `must_read` asks for it.
const TICK: Duration = Duration::from_secs(2);

/// The longest the tick goes without reading the directory while the watch
/// is armed and every process is still the one it was.
///
/// The read was every tick, and it was most of what an idle server spent: a
/// millisecond of CPU per pass, measured, for a directory whose every change
/// the watch already reports. What a write cannot announce — a process dying
/// without removing its file, or the kernel handing its pid on — the tick
/// still checks every period, in two syscalls a session. This is the backstop
/// for a watch that lost an event anyway.
const REREAD: Duration = Duration::from_secs(30);

/// How long after the watch is armed every tick still reads.
///
/// macOS drops change events for writes landing within a few ms of a watch
/// being registered (see `limits.rs`), and the server starting is exactly
/// when live sessions write.
const SETTLING: Duration = Duration::from_secs(10);

/// The expensive one. `claude agents --json` costs ~680ms, measured, so it runs
/// here and nowhere near the fast path.
///
/// This is the cadence while a question is open — an id on disk the CLI has
/// not vouched for, or a last call that failed — and the whole cadence on a
/// platform where `process_start` cannot tell one process from another.
const RECONCILE: Duration = Duration::from_secs(30);

/// How often the CLI is asked when nothing is open.
///
/// Its periodic answer used to be the only thing that noticed a session file
/// outliving its process on a pid something else now holds. `process_start`
/// notices that on the cheap tick instead, so what is left for the poll is
/// what no local evidence can show: the CLI ceasing to list a process that is
/// still the one it vouched for. Two calls a minute — over a minute of CPU an
/// hour — was the price of a check that now runs in a syscall.
const BACKSTOP: Duration = Duration::from_secs(300);

/// `claude agents --json` gets this long before it is written off, matching the
/// `execFile` timeout in `registry.ts`.
const CLI_TIMEOUT: Duration = Duration::from_secs(15);

/// `~/.claude/sessions`.
pub fn sessions_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("sessions")
}

/* -------------------------------------------------------------------------- */
/*  Listener fan-out                                                          */
/* -------------------------------------------------------------------------- */

/// A set of callbacks with individually revocable subscriptions.
///
/// The TS side got this for free from `Set<fn>` plus a closure over the
/// function itself; Rust closures are not comparable, so subscriptions carry an
/// id. Lives here rather than in a utilities module because `main.rs` fixes the
/// module list and this is the module that already owns the fleet fan-out;
/// `limits.rs` borrows it.
pub struct Listeners<T> {
    #[allow(clippy::type_complexity)]
    fns: Arc<Mutex<Vec<(u64, Arc<dyn Fn(T) + Send + Sync>)>>>,
    next: AtomicU64,
}

impl<T: Clone + Send + 'static> Listeners<T> {
    pub fn new() -> Self {
        Self { fns: Arc::new(Mutex::new(Vec::new())), next: AtomicU64::new(0) }
    }

    pub fn add(&self, listener: Box<dyn Fn(T) + Send + Sync>) -> Unsubscribe {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.fns.lock().unwrap().push((id, Arc::from(listener)));
        let fns = Arc::clone(&self.fns);
        Box::new(move || {
            fns.lock().unwrap().retain(|(subscription, _)| *subscription != id);
        })
    }

    /// Snapshot under the lock, call outside it. A listener writing to a slow
    /// WebSocket must not be able to hold up whoever is producing the value —
    /// and one that re-subscribes from inside its own callback would otherwise
    /// deadlock on the mutex.
    pub fn emit(&self, value: &T) {
        let subscribed: Vec<_> =
            self.fns.lock().unwrap().iter().map(|(_, listener)| Arc::clone(listener)).collect();
        for listener in subscribed {
            listener(value.clone());
        }
    }

    pub fn clear(&self) {
        self.fns.lock().unwrap().clear();
    }
}

impl<T: Clone + Send + 'static> Default for Listeners<T> {
    fn default() -> Self {
        Self::new()
    }
}

/* -------------------------------------------------------------------------- */
/*  Pure helpers                                                              */
/* -------------------------------------------------------------------------- */

fn to_status(raw: Option<&str>) -> AgentStatus {
    match raw {
        Some("busy") => AgentStatus::Busy,
        Some("idle") => AgentStatus::Idle,
        Some("waiting") => AgentStatus::Waiting,
        // Missing or unrecognised is an absence of evidence, and stays
        // distinguishable from "idle" all the way to the UI (INV-11).
        _ => AgentStatus::Unknown,
    }
}

/// `claude-1786666491:@65.%77` -> session name and pane id.
pub fn parse_tmux_ref(reference: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(r) = reference.filter(|s| !s.is_empty()) else {
        return (None, None);
    };
    // Both delimiters are ASCII, so byte offsets are char boundaries.
    let Some(colon) = r.find(':') else {
        return (None, None);
    };
    let session = r[..colon].to_string();
    let Some(dot) = r.rfind('.') else {
        return (Some(session), None);
    };
    if dot < colon {
        return (Some(session), None);
    }
    let pane = &r[dot + 1..];
    // `%` followed by digits, and nothing else: this string is interpolated into
    // tmux arguments downstream, so a loose match here is a command-injection
    // shaped hole rather than a cosmetic one.
    let ok = pane.len() > 1
        && pane.starts_with('%')
        && pane[1..].bytes().all(|b| b.is_ascii_digit());
    if ok {
        (Some(session), Some(pane.to_string()))
    } else {
        (Some(session), None)
    }
}

/// Is that pid still a process?
///
/// `kill(pid, 0)` performs the permission check and delivers nothing. EPERM
/// means the process exists but belongs to another user, which is still alive
/// for our purposes.
///
/// Unlike Node's `process.kill`, a non-positive pid is refused outright rather
/// than passed through: `kill(0, …)` addresses the whole process group, and a
/// session file claiming pid 0 is malformed input, not a live agent.
fn is_alive(pid: i64) -> bool {
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return false;
    }
    // SAFETY: `kill` with signal 0 has no effect beyond the errno it sets.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// When the process holding `pid` started, in microseconds since the Unix
/// epoch: equal for the same process and different for a pid the kernel has
/// since handed to another. `None` when there is no such process or this
/// platform cannot say.
///
/// This is what tells a reused pid apart without asking the CLI: `is_alive`
/// answers "is something there", and a session file outliving its process is
/// precisely the case where something is — just not the agent.
#[cfg(target_os = "macos")]
pub fn process_start(pid: i64) -> Option<u64> {
    let pid = libc::c_int::try_from(pid).ok().filter(|pid| *pid > 0)?;
    // SAFETY: an all-zero `proc_bsdinfo` is a valid value of a plain C struct.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: the buffer is a `proc_bsdinfo` of exactly the size passed, and
    // the kernel writes at most that many bytes into it.
    let written = unsafe {
        libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size)
    };
    (written == size).then(|| info.pbi_start_tvsec * MICROS_PER_SECOND + info.pbi_start_tvusec)
}

/// Linux: field 22 of `/proc/<pid>/stat`, in clock ticks since boot, put on
/// the epoch by the boot time.
///
/// The boot time is read once. `btime` is recomputed from the wall clock on
/// every read, so a stepped clock would otherwise move the start of a process
/// that has not changed.
#[cfg(target_os = "linux")]
pub fn process_start(pid: i64) -> Option<u64> {
    // Counted from the field after the command name, which is parenthesised
    // and may itself hold spaces or parentheses — hence the last `)`.
    const START_TIME_AFTER_THE_NAME: usize = 19;
    static BOOTED: std::sync::OnceLock<Option<u64>> = std::sync::OnceLock::new();
    let booted = (*BOOTED.get_or_init(|| {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        stat.lines().find_map(|line| line.strip_prefix("btime "))?.trim().parse::<u64>().ok()
    }))?;
    // SAFETY: `sysconf` reads a system constant and has no preconditions.
    let ticks_per_second = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).ok()?;
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_the_name = &stat[stat.rfind(')')? + 1..];
    let ticks: u64 =
        after_the_name.split_whitespace().nth(START_TIME_AFTER_THE_NAME)?.parse().ok()?;
    (ticks_per_second > 0)
        .then(|| booted * MICROS_PER_SECOND + ticks * MICROS_PER_SECOND / ticks_per_second)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_start(_pid: i64) -> Option<u64> {
    None
}

/// What a session file's own `procStart` says about the process holding its
/// pid now.
///
/// Claude Code writes `ps -o lstart` of its own process into the file, which
/// is what the CLI's presence answer turns on: a file naming the process that
/// holds its pid is a live session, and one naming another is a file that
/// outlived its process on a pid the kernel has handed on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Evidence {
    /// The file names the process holding its pid: listed without asking.
    Same,
    /// The file names some other process: held back until the CLI vouches.
    Another,
    /// No `procStart`, one this cannot read, or a pid whose start the kernel
    /// would not give: the CLI decides, as it always has.
    Silent,
}

/// Microseconds in a second, for the kernel's process starts.
const MICROS_PER_SECOND: u64 = 1_000_000;

/// How far apart, in seconds, a written start and the kernel's may be and
/// still name one process. `lstart` drops the fraction, and a pid cannot be
/// handed on twice inside a second.
const SAME_START_SLACK: i64 = 1;

/// Weigh a file's `procStart` against the kernel's start for its pid.
fn evidence(claim: Option<&str>, start: Option<u64>) -> Evidence {
    let (Some(claimed), Some(start)) = (claim.and_then(claimed_start), start) else {
        return Evidence::Silent;
    };
    let Ok(started) = i64::try_from(start / MICROS_PER_SECOND) else { return Evidence::Silent };
    if names_this_start(claimed, started, local_offset(started)) {
        Evidence::Same
    } else {
        Evidence::Another
    }
}

/// Whether a wall-clock `claimed` start, read as if it were UTC, is the
/// process that `started` (seconds since the epoch).
///
/// `lstart` carries no zone. The builds seen here write UTC, and `ps` left to
/// itself writes local time, so either reading of the same second is the same
/// process.
fn names_this_start(claimed: i64, started: i64, local_offset: Option<i64>) -> bool {
    let near = |expected: i64| (claimed - expected).abs() <= SAME_START_SLACK;
    near(started) || local_offset.is_some_and(|offset| near(started + offset))
}

/// The local zone's offset from UTC at `epoch_seconds`, in seconds east.
fn local_offset(epoch_seconds: i64) -> Option<i64> {
    let at = libc::time_t::try_from(epoch_seconds).ok()?;
    // SAFETY: an all-zero `tm` is a valid value of a plain C struct.
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are to live values of the types `localtime_r`
    // takes, and it writes nothing beyond the `tm` it is given.
    let filled = unsafe { libc::localtime_r(&raw const at, &raw mut local) };
    // `c_long`, which is `i64` only where a long is 64 bits.
    (!filled.is_null()).then_some(local.tm_gmtoff as i64)
}

/// `ps -o lstart` — `Mon Oct 12 01:43:15 2026` — as seconds since the epoch,
/// reading the wall clock as UTC. `None` for anything else, including a
/// month name in another language.
fn claimed_start(lstart: &str) -> Option<i64> {
    const MONTHS: [&str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const SECONDS_PER_DAY: i64 = 86_400;
    const SECONDS_PER_HOUR: i64 = 3_600;
    const SECONDS_PER_MINUTE: i64 = 60;
    let [_weekday, month, day, clock, year] =
        <[&str; 5]>::try_from(lstart.split_whitespace().collect::<Vec<_>>()).ok()?;
    let month = MONTHS.iter().position(|name| *name == month)? + 1;
    let day: u32 = day.parse().ok()?;
    let year: i64 = year.parse().ok()?;
    let [hours, minutes, seconds] = <[i64; 3]>::try_from(
        clock.split(':').map(str::parse).collect::<Result<Vec<i64>, _>>().ok()?,
    )
    .ok()?;
    let days = days_since_the_epoch(year, u32::try_from(month).ok()?, day)?;
    Some(days * SECONDS_PER_DAY + hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds)
}

/// Days from 1970-01-01 to a proleptic Gregorian date — Howard Hinnant's
/// `days_from_civil`. `None` for a month or day no calendar has.
fn days_since_the_epoch(year: i64, month: u32, day: u32) -> Option<i64> {
    const DAYS_IN_AN_ERA: i64 = 146_097;
    const YEARS_IN_AN_ERA: i64 = 400;
    const DAYS_BEFORE_THE_EPOCH: i64 = 719_468;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(YEARS_IN_AN_ERA);
    let year_of_era = year - era * YEARS_IN_AN_ERA;
    let shifted_month = i64::from((month + 9) % 12);
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * DAYS_IN_AN_ERA + day_of_era - DAYS_BEFORE_THE_EPOCH)
}

/// Read a string field, treating an empty one as absent.
///
/// That matches the `||` fallbacks in the TS. A session file with `"name": ""`
/// should show `pid 1234`, not a blank.
fn non_empty_field<'a>(record: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    record.get(key).and_then(|field| field.as_str()).filter(|text| !text.is_empty())
}

/// `path.basename`, with the same "fall back to the whole path" behaviour the
/// TS relies on for `/`.
fn folder_of(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

/// Turn one session record into a fleet entry, or nothing.
///
/// Takes a `Value` rather than a typed struct on purpose: this is an internal
/// Claude Code format that may change shape, and a strict deserialiser would
/// throw away an otherwise usable record because one field it does not care
/// about changed type. Field-by-field duck typing is what the TS did and what
/// INV-5 asks for.
pub fn to_agent(file: &serde_json::Value) -> Option<Agent> {
    let session_id = non_empty_field(file, "sessionId")?.to_string();
    let pid = file.get("pid").and_then(|p| p.as_i64())?;
    let cwd = non_empty_field(file, "cwd")?.to_string();

    let (session, pane) = parse_tmux_ref(file.get("tmux").and_then(|t| t.as_str()));
    let mut agent = Agent {
        session_id,
        pid,
        name: non_empty_field(file, "name").map(str::to_string).unwrap_or_else(|| format!("pid {pid}")),
        folder: folder_of(&cwd),
        cwd,
        status: to_status(file.get("status").and_then(|s| s.as_str())),
        // Spelled out rather than left to `Default`, which would be `""` — a
        // kind that matches no spec and therefore denies every capability, with
        // no chat tab, no controls and nothing on screen to say why.
        agent_kind: CLAUDE_KIND.to_string(),
        kind: non_empty_field(file, "kind").unwrap_or("interactive").to_string(),
        started_at: file.get("startedAt").and_then(|s| s.as_i64()).unwrap_or(0),
        version: non_empty_field(file, "version").map(str::to_string),
        waiting_for: non_empty_field(file, "waitingFor").map(str::to_string),
        tmux_session: session,
        ..Default::default()
    };
    // Claude Code records this itself, so the app never has to guess whether a
    // name was chosen or invented.
    if file.get("nameSource").and_then(|s| s.as_str()) == Some("derived") {
        agent.derived_name = Some(true);
    }
    match pane {
        Some(pane) => agent.pane_id = Some(pane),
        None => agent.attach_blocked_reason = Some(why_it_cannot_be_attached(file).to_string()),
    }
    Some(agent)
}

/// Say *which* kind of un-attachable a record is. "No pane" and "a pane
/// reference we could not read" send the user to different places.
fn why_it_cannot_be_attached(file: &serde_json::Value) -> &'static str {
    let has_a_reference =
        file.get("tmux").and_then(|value| value.as_str()).is_some_and(|text| !text.is_empty());
    if has_a_reference {
        "tmux pane id could not be parsed"
    } else {
        "session is not running inside tmux"
    }
}

/// Read every session record, keeping only those whose process is still alive.
pub async fn read_session_files(dir: &Path) -> Vec<Agent> {
    read_session_records(dir).await.into_iter().map(|(agent, _)| agent).collect()
}

/// `read_session_files`, with the `procStart` each record wrote about its own
/// process beside it.
async fn read_session_records(dir: &Path) -> Vec<(Agent, Option<String>)> {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        // No directory at all is the ordinary state on a machine that has never
        // run Claude Code. Empty fleet, no error.
        return Vec::new();
    };
    let mut agents = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.ends_with(".json") {
            continue;
        }
        // Everything below degrades to "skip this one record". A malformed or
        // half-written file must not take down the fleet (INV-5).
        let Ok(raw) = tokio::fs::read_to_string(entry.path()).await else { continue };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        if let Some(agent) = to_agent(&parsed) {
            if is_alive(agent.pid) {
                agents.push((agent, non_empty_field(&parsed, "procStart").map(str::to_string)));
            }
        }
    }
    agents
}

/// The session id this process is currently running, read straight from its
/// own record rather than from anything this app remembers.
///
/// Exists for `/clear`, which is the one control action whose effect is to
/// *replace* the session: Claude Code starts a fresh transcript under a new id
/// and rewrites this file to point at it. Watching the id change is therefore
/// proof the clear landed, and it is a far better sentinel than the transcript
/// — the old file stops being written and the new one is not found by the old
/// id, so there is nothing to poll for there.
///
/// Returns `None` for a missing or malformed record, which is INV-5's case: the
/// caller reports an unverified clear rather than an error.
pub async fn read_session_id(pid: i64) -> Option<String> {
    read_session_id_in(&sessions_dir(), pid).await
}

/// Same, against a directory the caller names. The seam the tests use.
pub async fn read_session_id_in(dir: &Path, pid: i64) -> Option<String> {
    let raw = tokio::fs::read_to_string(dir.join(format!("{pid}.json"))).await.ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed.get("sessionId").and_then(|s| s.as_str()).map(str::to_string)
}

/// The supported presence check. `None` when the CLI is unavailable — which is
/// not the same as "no sessions", and is why the caller keeps the previous
/// answer instead of emptying the fleet.
pub async fn read_cli_session_ids(runner: &dyn CommandRunner) -> Option<HashSet<String>> {
    let out = runner.run("claude", &["agents", "--json"], CLI_TIMEOUT).await?;
    let rows: serde_json::Value = serde_json::from_str(&out).ok()?;
    let rows = rows.as_array()?;
    Some(
        rows.iter()
            .filter_map(|r| r.get("sessionId").and_then(|s| s.as_str()))
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// Waiting first, then busy, then idle, then unknown; ties broken by name.
///
/// The name comparison stands in for JS `localeCompare`: lowercase first so
/// `apple` sorts before `Banana` the way a reader expects, with the original
/// spelling as the tiebreak so the order is total and stable. Full Unicode
/// collation would need an ICU dependency and would not change any ordering
/// this app has ever produced.
pub fn sort_agents(agents: &[Agent]) -> Vec<Agent> {
    /// Where each status sits in the fleet order. `UNKNOWN` is last on purpose:
    /// an absence of evidence must not displace an agent that really is waiting
    /// on somebody (INV-11).
    fn rank(status: AgentStatus) -> u8 {
        const WAITING: u8 = 0;
        const BUSY: u8 = 1;
        const IDLE: u8 = 2;
        const UNKNOWN: u8 = 3;
        match status {
            AgentStatus::Waiting => WAITING,
            AgentStatus::Busy => BUSY,
            AgentStatus::Idle => IDLE,
            AgentStatus::Unknown => UNKNOWN,
        }
    }
    let mut out = agents.to_vec();
    out.sort_by(|a, b| {
        rank(a.status)
            .cmp(&rank(b.status))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// Did anything the fleet view renders actually move?
///
/// Deliberately narrow: enrichment fields (activity, tokens, …) are excluded
/// because `enrich` + `notify` broadcast those on their own path, and including
/// them here would make every transcript byte re-broadcast the whole fleet.
fn changed(before: &HashMap<String, Agent>, after: &HashMap<String, Agent>) -> bool {
    if before.len() != after.len() {
        return true;
    }
    for (id, agent) in after {
        let Some(previous) = before.get(id) else { return true };
        if previous.status != agent.status
            || previous.name != agent.name
            || previous.cwd != agent.cwd
            || previous.waiting_for != agent.waiting_for
            || previous.pane_id != agent.pane_id
        {
            return true;
        }
    }
    false
}

/* -------------------------------------------------------------------------- */
/*  Pending sessions                                                          */
/* -------------------------------------------------------------------------- */

/// The seam `pending.ts`'s `PendingStore.merge` plugs into.
///
/// Sessions started from this app appear in the fleet immediately, before they
/// have registered themselves, so a workspace-trust prompt can be answered from
/// the browser instead of the terminal the user opened this app to avoid. The
/// store itself lives in `pending.rs`; the registry only needs "given the real
/// agents, what should the list be".
#[async_trait]
pub trait PendingMerge: Send + Sync + 'static {
    async fn merge(&self, real: Vec<Agent>) -> Vec<Agent>;

    /// Whether any spawn is still waiting to register. A waiting one is
    /// shown, and dropped, only by a read — so while there is one, every tick
    /// reads. Unknown counts as waiting.
    fn waiting(&self) -> bool {
        true
    }
}

/// The real store satisfies the seam directly.
///
/// Spelled with the fully-qualified call rather than `self.merge(...)`: the
/// inherent method and the trait method have the same name, and while Rust
/// resolves that in favour of the inherent one, a reader should not have to
/// know that to be sure this is not infinite recursion.
#[async_trait]
impl PendingMerge for crate::pending::PendingStore {
    async fn merge(&self, real: Vec<Agent>) -> Vec<Agent> {
        crate::pending::PendingStore::merge(self, real).await
    }

    fn waiting(&self) -> bool {
        self.size() > 0
    }
}

/* -------------------------------------------------------------------------- */
/*  The live source                                                           */
/* -------------------------------------------------------------------------- */

struct Inner {
    dir: PathBuf,
    tick: Duration,
    reconcile_every: Duration,
    runner: Arc<dyn CommandRunner>,
    pending: Option<Arc<dyn PendingMerge>>,
    agents: Mutex<HashMap<String, Agent>>,
    /// Session ids the CLI last confirmed, or `None` if it has never answered.
    known: Mutex<Option<HashSet<String>>>,
    /// Re-entrancy guard. A refresh asked for while one is mid-flight does not
    /// start a second: it sets `wanted`, and the one in flight reads again
    /// once it is done.
    refreshing: AtomicBool,
    /// A refresh was asked for while one was in flight. Not dropped: that pass
    /// may have read the directory before the change landed, and with the tick
    /// no longer re-reading every period nothing else would read it for
    /// `REREAD`.
    wanted: AtomicBool,
    /// How long the tick may skip the directory read; `None` reads every tick.
    reread: Option<Duration>,
    /// When the directory watch was armed; `None` while there is none.
    armed_at: Mutex<Option<Instant>>,
    /// When the directory was last read.
    read_at: Mutex<Option<Instant>>,
    /// The same guard for the expensive pass. `registry.ts` leaves this one
    /// implicit — only `#refreshing` exists there, and a 30s interval against a
    /// ~680ms call never collides in practice. "Never in practice" is not the
    /// property INV-4 asks for, and the startup pass plus the first scheduled
    /// pass *can* collide on a machine slow enough, so it is explicit here.
    reconciling: AtomicBool,
    /// Session ids the CLI has not confirmed, that we have already asked about.
    ///
    /// A session written to disk but absent from `known` is either brand new or
    /// a ghost, and the two are told apart by asking the CLI — which happens on
    /// the 30s reconcile. Waiting for it meant an agent started in a terminal
    /// stayed invisible for up to half a minute, in an app whose whole claim is
    /// that you can see every agent at a glance.
    ///
    /// So an unrecognised id triggers a reconcile now. This set is what keeps
    /// that from becoming a 2s `claude agents --json` loop: a ghost is asked
    /// about once, not once per scan. An id leaves the set when the CLI
    /// confirms it, when it declines one whose file names another process (see
    /// `declined`), or when its session file goes away, so a pid genuinely
    /// reused later is asked about again.
    asked: Mutex<HashSet<String>>,
    /// When the process behind each session id started, as `process_start`
    /// read it the first time that id was seen on that pid. A start that has
    /// moved means the kernel handed the pid to somebody else, and whatever
    /// the CLI said about the session is no longer about the process there.
    started: Mutex<HashMap<String, (i64, u64)>>,
    /// `process_start`, as a seam: a test cannot make the kernel reuse a pid.
    start_of: Arc<StartReader>,
    /// Ids on disk whose file names another process than the one holding its
    /// pid, as of the last pass.
    contradicted: Mutex<HashSet<String>>,
    /// Contradicted ids the CLI has since declined to list. Settled rather
    /// than open: the file cannot start naming the right process, so asking
    /// again every period would be a poll on a certainty. A new start on the
    /// pid, or the file going away, reopens it.
    declined: Mutex<HashSet<String>>,
    /// When the CLI last answered. `None` before its first answer and after a
    /// call that failed, both of which leave a question open.
    answered_at: Mutex<Option<std::time::Instant>>,
    /// How long the periodic pass may go without asking while no question is
    /// open. `None` asks every period, which is what a platform without
    /// `process_start` needs: there the poll is the only thing that notices a
    /// reused pid.
    backstop: Option<Duration>,
    /// Set by `stop`, so a refresh already in flight cannot start a subprocess
    /// after the server has been told to shut down.
    stopped: AtomicBool,
    listeners: Listeners<Vec<Agent>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// Reads a process's start, as `process_start` does.
type StartReader = dyn Fn(i64) -> Option<u64> + Send + Sync;

/// Resets an in-flight flag however the work exits, standing in for the TS
/// `finally`.
struct InFlightGuard<'a>(&'a AtomicBool);
impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Inner {
    fn list(&self) -> Vec<Agent> {
        let agents = self.agents.lock().unwrap();
        let snapshot: Vec<Agent> = agents.values().cloned().collect();
        drop(agents);
        sort_agents(&snapshot)
    }

    async fn refresh(self: &Arc<Self>) {
        loop {
            if self
                .refreshing
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                self.wanted.store(true, Ordering::SeqCst);
                return;
            }
            {
                let _guard = InFlightGuard(&self.refreshing);
                self.wanted.store(false, Ordering::SeqCst);
                self.read_the_directory().await;
            }
            // Checked after the guard is released, so a request that saw the
            // pass still in flight is either this re-read or its own pass.
            if !self.wanted.load(Ordering::SeqCst) {
                return;
            }
        }
    }

    /// Whether this tick has to read the directory, or can trust that the
    /// watch would have said so.
    ///
    /// It reads while the watch is unarmed or still settling, once `REREAD`
    /// has passed, while a spawn waits to register, and when a process behind
    /// a listed session has died or been replaced — the one change no write
    /// announces.
    fn must_read(&self) -> bool {
        let Some(reread) = self.reread else { return true };
        let settled = self.armed_at.lock().unwrap().is_some_and(|at| at.elapsed() >= SETTLING);
        let fresh = self.read_at.lock().unwrap().is_some_and(|at| at.elapsed() < reread);
        let waiting = self.pending.as_ref().is_some_and(|pending| pending.waiting());
        !(settled && fresh) || waiting || self.a_process_moved()
    }

    /// A listed session whose process has exited, or whose pid a process with
    /// another start now holds. Two syscalls a session, against a directory
    /// read and a parse of every file.
    fn a_process_moved(&self) -> bool {
        let agents = self.agents.lock().unwrap();
        let started = self.started.lock().unwrap();
        agents.values().filter(|agent| !crate::pending::is_placeholder(agent)).any(|agent| {
            let was = started.get(&agent.session_id).filter(|(pid, _)| *pid == agent.pid);
            !is_alive(agent.pid)
                || was.is_some_and(|(pid, start)| (self.start_of)(*pid) != Some(*start))
        })
    }

    async fn read_the_directory(self: &Arc<Self>) {
        *self.read_at.lock().unwrap() = Some(Instant::now());
        let records = read_session_records(&self.dir).await;
        let claims: HashMap<String, String> = records
            .iter()
            .filter_map(|(agent, claim)| Some((agent.session_id.clone(), claim.clone()?)))
            .collect();
        let real = records.into_iter().map(|(agent, _)| agent).collect();
        let found = match &self.pending {
            Some(pending) => pending.merge(real).await,
            None => real,
        };

        let pass = self.absorb(found, &claims);
        if pass.published {
            let list = self.list();
            self.listeners.emit(&list);
        }
        // Asked *after* the map is published, because this pass can already say
        // everything it knows. It is asked even when nothing was published: an
        // unrecognised id changes nothing precisely *because* it was skipped,
        // which is the case that most needs the CLI.
        if pass.met_an_unrecognised_id {
            self.ask_the_authority_now();
        }
    }

    /// Fold one pass's session records into the live map.
    ///
    /// One lock held from read to write. `enrich` runs from the transcript
    /// tailer on another task, and a read-compute-write with the lock dropped in
    /// the middle would silently discard whatever enrichment landed in the gap.
    /// The TS got this for free from the event loop; here it has to be asked
    /// for.
    fn absorb(&self, found: Vec<Agent>, claims: &HashMap<String, String>) -> PassOutcome {
        let mut agents = self.agents.lock().unwrap();
        let mut ledger = self.ledger();
        ledger.contradicted.clear();
        let mut next: HashMap<String, Agent> = HashMap::with_capacity(found.len());
        let on_disk: HashSet<String> =
            found.iter().map(|agent| agent.session_id.clone()).collect();
        for agent in found {
            let start = self.start_of_process(&agent);
            ledger.forget_a_moved_start(&agent, start);
            let claim = claims.get(&agent.session_id).map(String::as_str);
            let listed = match evidence(claim, start) {
                Evidence::Same => ledger.vouch(&agent),
                Evidence::Another => ledger.hold_unless_listed(&agent),
                Evidence::Silent => ledger.admit_on_the_clis_word(&agent, &agents, &on_disk),
            };
            if listed {
                ledger.asked.remove(&agent.session_id);
                carry_enrichment_forward(&agents, &mut next, agent);
            }
        }
        ledger.forget_what_left(&on_disk);
        let published = changed(&agents, &next);
        if published {
            *agents = next;
        }
        PassOutcome { published, met_an_unrecognised_id: ledger.met_an_unrecognised_id }
    }

    /// The presence bookkeeping, locked in the one order every pass takes it.
    fn ledger(&self) -> Ledger<'_> {
        Ledger {
            known: self.known.lock().unwrap(),
            asked: self.asked.lock().unwrap(),
            started: self.started.lock().unwrap(),
            contradicted: self.contradicted.lock().unwrap(),
            declined: self.declined.lock().unwrap(),
            met_an_unrecognised_id: false,
        }
    }

    /// When the process behind `agent` started. A placeholder has no process
    /// of its own to vouch for.
    fn start_of_process(&self, agent: &Agent) -> Option<u64> {
        if crate::pending::is_placeholder(agent) {
            return None;
        }
        (self.start_of)(agent.pid)
    }

    /// Close the questions a contradicted file put to the CLI once it has
    /// declined to list them. Only questions put before this call count: a
    /// file written while it ran may simply have been too late for it.
    fn settle(&self, put: &HashSet<String>, listed: &HashSet<String>) {
        let mut asked = self.asked.lock().unwrap();
        let contradicted = self.contradicted.lock().unwrap();
        let mut declined = self.declined.lock().unwrap();
        for id in put.iter().filter(|id| contradicted.contains(*id) && !listed.contains(*id)) {
            asked.remove(id);
            declined.insert(id.clone());
        }
    }

    /// Whether the periodic pass has nothing to put to the CLI: no id on disk
    /// is waiting on its word, its last call answered, and that answer is
    /// younger than the backstop.
    fn nothing_to_ask(&self) -> bool {
        let Some(backstop) = self.backstop else { return false };
        let answered_at = *self.answered_at.lock().unwrap();
        self.asked.lock().unwrap().is_empty()
            && answered_at.is_some_and(|at| at.elapsed() < backstop)
    }

    /// Put the question to the authority, without waiting for the answer.
    ///
    /// Not awaited on purpose: the pass that found the unrecognised id has
    /// already published everything it knows, and the answer arrives on the
    /// reconcile's own refresh. Boxed because that refresh can lead back here,
    /// and an async cycle needs one indirection to have a size.
    fn ask_the_authority_now(self: &Arc<Self>) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let ask: Pin<Box<dyn Future<Output = ()> + Send>> = Box::pin(inner.reconcile());
            ask.await;
        });
    }

    /// Cross-check presence against the supported CLI, dropping ghosts.
    async fn reconcile(self: Arc<Self>) {
        // Dropped, not queued: a second ~680ms subprocess started while the
        // first is still running would buy nothing and would be the first step
        // towards a pile of them on a loaded machine (INV-4).
        if self
            .reconciling
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let _guard = InFlightGuard(&self.reconciling);

        let put = self.asked.lock().unwrap().clone();
        let known = read_cli_session_ids(self.runner.as_ref()).await;
        *self.answered_at.lock().unwrap() = known.as_ref().map(|_| std::time::Instant::now());
        // A CLI that did not answer leaves the previous answer in place rather
        // than dropping the filter — losing the authority must not silently
        // resurrect ghosts, and must not empty the fleet either.
        let Some(listed) = known else { return };
        self.settle(&put, &listed);
        *self.known.lock().unwrap() = Some(listed);
        self.refresh().await;
    }
}

/// What one `absorb` pass holds locked while it decides who is listed.
struct Ledger<'a> {
    known: MutexGuard<'a, Option<HashSet<String>>>,
    asked: MutexGuard<'a, HashSet<String>>,
    started: MutexGuard<'a, HashMap<String, (i64, u64)>>,
    contradicted: MutexGuard<'a, HashSet<String>>,
    declined: MutexGuard<'a, HashSet<String>>,
    /// The pass met a session id nobody has asked the CLI about yet.
    met_an_unrecognised_id: bool,
}

impl Ledger<'_> {
    /// Record when the process behind `agent` started. A start that has moved
    /// since its id was last seen on the same pid means the kernel handed the
    /// pid on: the CLI's word was about whoever held it before, so it is taken
    /// back, and so is any question settled about it.
    fn forget_a_moved_start(&mut self, agent: &Agent, start: Option<u64>) {
        let Some(start) = start else { return };
        let before = self.started.insert(agent.session_id.clone(), (agent.pid, start));
        if before.is_some_and(|(pid, then)| pid == agent.pid && then != start) {
            if let Some(confirmed) = self.known.as_mut() {
                confirmed.remove(&agent.session_id);
            }
            self.declined.remove(&agent.session_id);
        }
    }

    /// The file names the process holding its pid: the answer the CLI would
    /// give, read from the kernel rather than from a ~680ms subprocess.
    fn vouch(&mut self, agent: &Agent) -> bool {
        vouch_for(&mut self.known, &agent.session_id);
        true
    }

    /// The file names another process: a ghost until the CLI lists it. Held
    /// back from the very first fleet, not only once the CLI has first
    /// answered, and asked about once rather than every period.
    fn hold_unless_listed(&mut self, agent: &Agent) -> bool {
        let id = &agent.session_id;
        if self.known.as_ref().is_some_and(|confirmed| confirmed.contains(id)) {
            return true;
        }
        self.contradicted.insert(id.clone());
        if !self.declined.contains(id) {
            self.met_an_unrecognised_id |= self.asked.insert(id.clone());
        }
        false
    }

    /// Nothing to weigh: listed on the CLI's word, as before `procStart` was
    /// read.
    fn admit_on_the_clis_word(
        &mut self,
        agent: &Agent,
        current: &HashMap<String, Agent>,
        on_disk: &HashSet<String>,
    ) -> bool {
        if !is_unconfirmed(agent, &self.known) {
            return true;
        }
        if succeeds_a_confirmed_session(agent, current, on_disk) {
            // `/clear` in flight: vouch for the new id ourselves until the
            // CLI's next answer replaces this set — see the fn.
            vouch_for(&mut self.known, &agent.session_id);
            return true;
        }
        // Not a ghost yet — just unconfirmed. Ask the authority now rather
        // than at the next 30s reconcile; `asked` is what keeps that from
        // becoming a loop.
        self.met_an_unrecognised_id |= self.asked.insert(agent.session_id.clone());
        false
    }

    /// A session file that has gone away may come back on a reused pid, and
    /// that one deserves a fresh question.
    fn forget_what_left(&mut self, on_disk: &HashSet<String>) {
        self.asked.retain(|id| on_disk.contains(id));
        self.started.retain(|id, _| on_disk.contains(id));
        let contradicted = &self.contradicted;
        self.declined.retain(|id| contradicted.contains(id));
    }
}

/// What one `absorb` pass found, reported back to `refresh` so the locks it
/// held are released before either answer is acted on.
struct PassOutcome {
    /// Something the fleet view renders moved, so the new map went live and
    /// wants broadcasting.
    published: bool,
    /// The pass met a session id the CLI has never vouched for and that nobody
    /// has asked about yet.
    met_an_unrecognised_id: bool,
}

/// A pid can be reused, and the CLI is the authority on what is really live.
/// Pending entries are ours rather than the CLI's, so they are exempt.
fn is_unconfirmed(agent: &Agent, known: &Option<HashSet<String>>) -> bool {
    if crate::pending::is_placeholder(agent) {
        return false;
    }
    known.as_ref().is_some_and(|confirmed| !confirmed.contains(&agent.session_id))
}

/// `/clear` rewrites `<pid>.json` with a fresh id, and the process that wrote it
/// is one the CLI already vouched for under its previous id. Waiting for the
/// next `claude agents --json` to confirm the new one left a gap of a scan plus
/// a reconcile — one to three seconds — in which the agent was in the fleet
/// under neither id, and a browser open on it had nowhere to be but the fleet.
///
/// Two things have to be true of the session it replaces. It must be under a
/// *different* id: the same id on the same pid is the ghost the presence check
/// exists for — a session file outliving its process, on a pid something else
/// now holds — and it must keep being dropped once the CLI stops listing it.
/// And it must be *gone from disk*: `/clear` rewrites one file, so the old id
/// and the new never coexist there, whereas a second file claiming a live
/// session's pid is precisely the shape of a ghost and gets the question. A
/// placeholder is ours, not the CLI's, and vouches for nothing.
fn succeeds_a_confirmed_session(
    agent: &Agent,
    current: &HashMap<String, Agent>,
    on_disk: &HashSet<String>,
) -> bool {
    current.values().any(|prior| {
        prior.pid == agent.pid
            && prior.session_id != agent.session_id
            && !on_disk.contains(&prior.session_id)
            && !crate::pending::is_placeholder(prior)
    })
}

/// Add an id to the CLI's last answer as if it had been in it. Nothing to add
/// to when the CLI has never answered, and then nothing is filtered either.
fn vouch_for(known: &mut Option<HashSet<String>>, session_id: &str) {
    if let Some(confirmed) = known.as_mut() {
        confirmed.insert(session_id.to_string());
    }
}

/// Keep enrichment that the transcript tailer laid down: the session file has
/// no idea about activity lines or token counts, and a plain overwrite would
/// blank them twice a second.
fn carry_enrichment_forward(
    previous: &HashMap<String, Agent>,
    next: &mut HashMap<String, Agent>,
    agent: Agent,
) {
    let Some(prior) = previous.get(&agent.session_id) else {
        next.insert(agent.session_id.clone(), agent);
        return;
    };
    let mut merged = prior.clone();
    overlay(&mut merged, agent);
    next.insert(merged.session_id.clone(), merged);
}

/// Apply a freshly-read session record over the agent we already had.
///
/// This is `{ ...prev, ...agent }` spelled out. The distinction between the two
/// halves below is not stylistic: in the TS, `toAgent` *always* assigns the
/// first group and assigns the second only when the record carries it, so a
/// spread leaves an absent optional field at its previous value rather than
/// clearing it. Reproducing that exactly is what keeps `enrich` working —
/// `waitingFor` in particular is also written by the transcript enricher, and a
/// blanket overwrite here would stomp it twice a second.
///
/// Known consequence, carried across deliberately: a `waitingFor` that the
/// session file stops reporting lingers until something clears it. It is
/// invisible in practice because the UI only renders it while `status` is
/// `waiting`, and `status` *is* overwritten every pass.
fn overlay(prev: &mut Agent, next: Agent) {
    // Always present in a record we accepted at all.
    prev.pid = next.pid;
    prev.name = next.name;
    prev.cwd = next.cwd;
    prev.folder = next.folder;
    prev.status = next.status;
    prev.kind = next.kind;
    prev.started_at = next.started_at;
    // Conditionally present: absent means "unchanged", not "cleared".
    if next.waiting_for.is_some() {
        prev.waiting_for = next.waiting_for;
    }
    if next.version.is_some() {
        prev.version = next.version;
    }
    /*
     * These two are the one pair here that is mutually exclusive, so they are
     * merged as a pair rather than each on the general "absent means
     * unchanged" rule. `read_session_file` sets exactly one of them — a pane,
     * or the reason there is not one — and the general rule cannot express
     * that: an agent first seen before its pane existed keeps the reason for
     * ever, and afterwards carries both a pane id *and* a sentence saying it
     * has none.
     *
     * That was survivable while only `pane_id` was read. It stopped being so
     * when the card's status rail started drawing `attach_blocked_reason` as
     * an unreachable mark: a freshly spawned agent, which is precisely the one
     * that registers before its pane is known, wore a struck ring for the rest
     * of its life while being perfectly attachable.
     */
    if next.pane_id.is_some() {
        prev.pane_id = next.pane_id;
        prev.attach_blocked_reason = None;
    } else if next.attach_blocked_reason.is_some() {
        prev.attach_blocked_reason = next.attach_blocked_reason;
        prev.pane_id = None;
    }
    if next.tmux_session.is_some() {
        prev.tmux_session = next.tmux_session;
    }
    if next.derived_name.is_some() {
        prev.derived_name = next.derived_name;
    }
}

/// Everything a `LiveSource` is built from.
///
/// A struct rather than five positional arguments: two of them are `Duration`s
/// that a call site could otherwise tell apart only by their order, and getting
/// the cheap tick and the ~680ms reconcile the wrong way round is the one
/// mistake INV-4 exists to prevent.
pub struct SourceConfig {
    pub dir: PathBuf,
    pub runner: Arc<dyn CommandRunner>,
    pub pending: Option<Arc<dyn PendingMerge>>,
    /// The cheap pass: a directory listing plus a few hundred bytes.
    pub tick: Duration,
    /// The expensive one, `claude agents --json`.
    pub reconcile_every: Duration,
}

/// The real fleet: session files on a short tick, `claude agents --json` on a
/// long one.
pub struct LiveSource {
    inner: Arc<Inner>,
}

impl LiveSource {
    /// The shipped configuration.
    #[allow(clippy::new_ret_no_self)]
    pub fn new() -> Arc<dyn AgentSource> {
        Self::shipped(None)
    }

    /// Same, with spawned-but-unregistered sessions merged in. `cli.ts` passes
    /// the `PendingStore` here so a session that is still on its trust prompt is
    /// visible and attachable.
    pub fn new_with_pending(pending: Arc<dyn PendingMerge>) -> Arc<dyn AgentSource> {
        Self::shipped(Some(pending))
    }

    fn shipped(pending: Option<Arc<dyn PendingMerge>>) -> Arc<dyn AgentSource> {
        let config = SourceConfig {
            dir: sessions_dir(),
            runner: exec_runner(),
            pending,
            tick: TICK,
            reconcile_every: RECONCILE,
        };
        // Our own start is readable exactly when every agent's is.
        let backstop = process_start(i64::from(std::process::id())).map(|_| BACKSTOP);
        Self::assembled(config, Arc::new(process_start), backstop, Some(REREAD))
    }

    /// Fully injected, for tests: a temp directory of session files, a stubbed
    /// command runner, and intervals short enough to observe. Nothing in the
    /// test suite may require a real `claude` binary.
    pub fn configured(config: SourceConfig) -> Arc<LiveSource> {
        Self::assembled(config, Arc::new(process_start), None, None)
    }

    /// `configured`, plus how a process's start is read, how long the
    /// periodic pass may stay quiet with no question open, and how long the
    /// tick may go without reading the directory (`None`: every tick).
    fn assembled(
        config: SourceConfig,
        start_of: Arc<StartReader>,
        backstop: Option<Duration>,
        reread: Option<Duration>,
    ) -> Arc<LiveSource> {
        Arc::new(LiveSource {
            inner: Arc::new(Inner {
                dir: config.dir,
                tick: config.tick,
                reconcile_every: config.reconcile_every,
                runner: config.runner,
                pending: config.pending,
                agents: Mutex::new(HashMap::new()),
                known: Mutex::new(None),
                refreshing: AtomicBool::new(false),
                wanted: AtomicBool::new(false),
                reread,
                armed_at: Mutex::new(None),
                read_at: Mutex::new(None),
                reconciling: AtomicBool::new(false),
                asked: Mutex::new(HashSet::new()),
                started: Mutex::new(HashMap::new()),
                contradicted: Mutex::new(HashSet::new()),
                declined: Mutex::new(HashSet::new()),
                start_of,
                answered_at: Mutex::new(None),
                backstop,
                stopped: AtomicBool::new(false),
                listeners: Listeners::new(),
                tasks: Mutex::new(Vec::new()),
                watcher: Mutex::new(None),
            }),
        })
    }
}

impl LiveSource {
    /// Low-latency path: a session file appearing or changing refreshes at once
    /// instead of waiting out the tick. Not the guarantee — macOS drops change
    /// events for writes landing within a few ms of the watch being registered,
    /// and some filesystems support no watching at all — which is why the tick
    /// reads every period until the watch has settled, and every `REREAD` after.
    /// `None` on any of those, which is not an error.
    fn watch_the_sessions_directory(&self) -> Option<JoinHandle<()>> {
        let (events, mut arrivals) = tokio::sync::mpsc::unbounded_channel::<()>();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event.is_ok() {
                    let _ = events.send(());
                }
            })
            .ok()?;
        watcher.watch(&self.inner.dir, RecursiveMode::NonRecursive).ok()?;
        *self.inner.watcher.lock().unwrap() = Some(watcher);
        *self.inner.armed_at.lock().unwrap() = Some(Instant::now());

        let inner = Arc::clone(&self.inner);
        Some(tokio::spawn(async move {
            while arrivals.recv().await.is_some() {
                // Drain the burst: one write to one session file can arrive as
                // several events, and they all want the same single re-read.
                while arrivals.try_recv().is_ok() {}
                inner.refresh().await;
            }
        }))
    }

    /// The cheap poll, re-arming *after* the work completes rather than on a
    /// fixed schedule (INV-4). `tokio::time::interval` is deliberately not used:
    /// its default missed-tick behaviour bursts to catch up, which on a machine
    /// that stalled would stack reads exactly the way a Node `setInterval`
    /// without a re-entrancy guard does.
    fn spawn_the_cheap_tick(&self) -> JoinHandle<()> {
        let inner = Arc::clone(&self.inner);
        let tick = self.inner.tick;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tick).await;
                if inner.must_read() {
                    inner.refresh().await;
                }
            }
        })
    }

    /// The expensive poll, guarded the same way. It wakes every period but
    /// asks only when there is something to ask — see `nothing_to_ask`.
    fn spawn_the_expensive_reconcile(&self) -> JoinHandle<()> {
        let inner = Arc::clone(&self.inner);
        let every = self.inner.reconcile_every;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                if inner.nothing_to_ask() {
                    continue;
                }
                // Sleep-then-work means the next ~680ms call cannot start until
                // this one has finished; the gap between calls is the interval,
                // never less.
                Arc::clone(&inner).reconcile().await;
            }
        })
    }
}

#[async_trait]
impl AgentSource for LiveSource {
    fn list(&self) -> Vec<Agent> {
        self.inner.list()
    }

    fn get(&self, session_id: &str) -> Option<Agent> {
        self.inner.agents.lock().unwrap().get(session_id).cloned()
    }

    fn on_change(&self, listener: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe {
        self.inner.listeners.add(listener)
    }

    /// Merge transcript-derived detail onto an agent without a full refresh.
    fn enrich(&self, session_id: &str, patch: AgentPatch) {
        let mut agents = self.inner.agents.lock().unwrap();
        // Silently ignore an unknown session: the tailer can outlive the agent
        // by one tick, and that is not worth an error path.
        if let Some(agent) = agents.get_mut(session_id) {
            patch.apply(agent);
        }
    }

    /// Push the current list to listeners after out-of-band enrichment.
    fn notify(&self) {
        let list = self.inner.list();
        self.inner.listeners.emit(&list);
    }

    async fn start(&self) -> anyhow::Result<()> {
        // First read is awaited, so the first HTTP response already has a fleet
        // rather than an empty list that fills in a moment later.
        self.inner.refresh().await;

        // The authoritative pass is kicked off but not awaited: it costs ~680ms
        // and nothing on the first paint depends on it.
        {
            let inner = Arc::clone(&self.inner);
            tokio::spawn(async move { inner.reconcile().await });
        }

        let mut tasks = self.inner.tasks.lock().unwrap();
        tasks.extend(self.watch_the_sessions_directory());
        tasks.push(self.spawn_the_cheap_tick());
        tasks.push(self.spawn_the_expensive_reconcile());
        Ok(())
    }

    fn stop(&self) {
        // Set before the tasks are aborted, so a refresh already in flight
        // cannot spawn a `claude agents --json` on the way out.
        self.inner.stopped.store(true, Ordering::SeqCst);
        for t in self.inner.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
        *self.inner.watcher.lock().unwrap() = None;
        self.inner.listeners.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A pane and a reason there is no pane are mutually exclusive, and stay
    /// that way across a merge.
    ///
    /// `overlay`'s general rule is "absent means unchanged, not cleared",
    /// which is right for every other optional field and wrong for this pair:
    /// `read_session_file` sets exactly one of them. An agent first seen
    /// before its pane existed — a freshly spawned one, which is the common
    /// case — otherwise keeps the reason for ever and ends up carrying a pane
    /// id *and* a sentence saying it has none. The card's status rail draws
    /// that sentence as an unreachable mark, so it wore a struck ring while
    /// being perfectly attachable.
    #[test]
    fn a_pane_clears_the_reason_there_was_none_and_the_reverse() {
        let blocked = Agent {
            attach_blocked_reason: Some("session is not running inside tmux".into()),
            ..Default::default()
        };

        let mut gained = blocked.clone();
        overlay(&mut gained, Agent { pane_id: Some("%7".into()), ..Default::default() });
        assert_eq!(gained.pane_id.as_deref(), Some("%7"));
        assert_eq!(gained.attach_blocked_reason, None, "a pane means it is attachable");

        let mut lost = Agent { pane_id: Some("%7".into()), ..Default::default() };
        overlay(&mut lost, blocked);
        assert_eq!(lost.attach_blocked_reason.as_deref(), Some("session is not running inside tmux"));
        assert_eq!(lost.pane_id, None, "a reason means there is no pane to keep");
    }

    /* ---- the clock these tests run on -------------------------------------
       Spelled out rather than left inline: several tests below turn on one span
       being longer or shorter than another — a stub that costs more than the
       interval scheduling it, a reconcile that outlives the test that
       configured it — and a bare `20` at the call site says none of that. */

    /// Longer than any test here, so the loop it paces never fires on its own
    /// and the test drives it by hand.
    const LONGER_THAN_THE_TEST: Duration = Duration::from_secs(3600);
    /// The ordinary tick for these tests: several cheap reads inside one test,
    /// slow enough that a read which should not have happened still shows.
    const TEST_TICK: Duration = Duration::from_millis(20);
    /// A touch slower, where the test also has to watch an unchanged fleet
    /// decline to re-broadcast.
    const UNHURRIED_TICK: Duration = Duration::from_millis(30);
    /// The cheapest tick used here, for the two tests that count cheap reads
    /// against expensive ones.
    const RAPID_TICK: Duration = Duration::from_millis(10);
    /// Fast enough to collide with the burst of filesystem events it is
    /// deliberately run underneath.
    const HAMMERED_TICK: Duration = Duration::from_millis(5);

    /// Slow enough that `A_COUPLE_OF_RECONCILES` holds one startup pass plus at
    /// most a couple of scheduled ones.
    const UNHURRIED_RECONCILE: Duration = Duration::from_millis(400);
    /// Deliberately far shorter than the work it schedules: a fixed-rate
    /// scheduler would stack calls here, one that re-arms after completion
    /// cannot.
    const RECONCILE_SHORTER_THAN_ITS_WORK: Duration = Duration::from_millis(20);
    /// Prompt enough that the authority's verdict lands inside the test.
    const PROMPT_RECONCILE: Duration = Duration::from_millis(30);

    /// What the stubbed `claude agents --json` costs, standing in for the
    /// measured ~680ms.
    const CHEAP_CLI: Duration = Duration::from_millis(20);
    /// The same, made dear enough to overrun the interval scheduling it.
    const COSTLY_CLI: Duration = Duration::from_millis(120);

    /// Long enough for several ticks to have found nothing new.
    const SEVERAL_QUIET_TICKS: Duration = Duration::from_millis(200);
    /// Long enough for a startup reconcile plus one or two scheduled ones.
    const A_COUPLE_OF_RECONCILES: Duration = Duration::from_millis(500);
    /// Long enough for several `COSTLY_CLI` reconciles, so their spacing can be
    /// measured.
    const SEVERAL_COSTLY_RECONCILES: Duration = Duration::from_millis(700);
    /// Long enough for a few ticks to have run over the enrichment, had they
    /// been going to blank it.
    const A_FEW_TICKS: Duration = Duration::from_millis(120);
    /// Long enough for a reconcile fired from inside a refresh to finish.
    const ONE_RECONCILE: Duration = Duration::from_millis(60);
    /// How long `wait_until` gives a condition. Generous on purpose: it guards
    /// against a hang, it is not itself a timing assertion.
    const PATIENCE: Duration = Duration::from_secs(5);

    /// One startup pass plus at most a couple of scheduled ones, against the
    /// ~50 cheap ticks the same window holds.
    const MOST_RECONCILES_THE_WINDOW_ALLOWS: usize = 3;

    /* ---- the fixtures ---- */

    /// A plausible pid, for records where the number itself carries no meaning.
    const SOME_PID: i64 = 4321;
    /// The pid in records whose liveness is beside the point: those tests read
    /// a record, they never go looking for the process.
    const UNCHECKED_PID: i64 = 7;
    /// A pid no session file was written for.
    const PID_WITH_NO_RECORD: i64 = 999;
    /// INV-5's wrong-shape case: the id is there, it is just not a string.
    const A_NUMBER_WHERE_THE_ID_BELONGS: i64 = 7;
    /// Session files written all at once, so watch events and the tick are
    /// certain to overlap.
    const BURST_SIZE: usize = 40;
    /// A token count the session file knows nothing about, so finding it intact
    /// after a refresh proves the enrichment survived.
    const ENRICHED_TOKENS: i64 = 12;

    /// A stubbed `claude` (and anything else), recording when each call started
    /// and finished so overlap is observable.
    struct FakeCli {
        out: Mutex<Option<String>>,
        /// Artificial cost per call, standing in for the measured ~680ms.
        cost: Duration,
        calls: Arc<AtomicUsize>,
        in_flight: Arc<AtomicUsize>,
        max_in_flight: Arc<AtomicUsize>,
        starts: Arc<Mutex<Vec<std::time::Instant>>>,
    }

    impl FakeCli {
        fn new(out: Option<&str>, cost: Duration) -> Arc<Self> {
            Arc::new(Self {
                out: Mutex::new(out.map(str::to_string)),
                cost,
                calls: Arc::new(AtomicUsize::new(0)),
                in_flight: Arc::new(AtomicUsize::new(0)),
                max_in_flight: Arc::new(AtomicUsize::new(0)),
                starts: Arc::new(Mutex::new(Vec::new())),
            })
        }
    }

    #[async_trait]
    impl CommandRunner for FakeCli {
        async fn run(&self, _bin: &str, _args: &[&str], _timeout: Duration) -> Option<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.starts.lock().unwrap().push(std::time::Instant::now());
            let n = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(n, Ordering::SeqCst);
            tokio::time::sleep(self.cost).await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            self.out.lock().unwrap().clone()
        }
    }

    fn write_session(dir: &Path, name: &str, body: serde_json::Value) {
        std::fs::write(dir.join(name), serde_json::to_string(&body).unwrap()).unwrap();
    }

    fn live_session(session_id: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionId": session_id,
            // Our own pid is guaranteed alive, which keeps the liveness check
            // real instead of stubbed out.
            "pid": std::process::id(),
            "cwd": "/Users/me/Projects/thing",
            "status": "busy",
            "tmux": "claude-1786666491:@65.%77",
        })
    }

    /* ---- pure helpers ---- */

    #[test]
    fn parses_a_full_tmux_reference() {
        let (s, p) = parse_tmux_ref(Some("claude-1786666491:@65.%77"));
        assert_eq!(s.as_deref(), Some("claude-1786666491"));
        assert_eq!(p.as_deref(), Some("%77"));
    }

    #[test]
    fn keeps_the_session_when_the_pane_is_unreadable() {
        // A window index with no pane id.
        let (s, p) = parse_tmux_ref(Some("claude-1:@65"));
        assert_eq!(s.as_deref(), Some("claude-1"));
        assert!(p.is_none());
        // A pane that is not `%<digits>` is refused rather than passed to tmux.
        let (s, p) = parse_tmux_ref(Some("claude-1:@65.%77; rm -rf /"));
        assert_eq!(s.as_deref(), Some("claude-1"));
        assert!(p.is_none());
        assert_eq!(parse_tmux_ref(Some("claude-1:@65.%")).1, None);
        assert_eq!(parse_tmux_ref(Some("claude-1:@65.77")).1, None);
    }

    #[test]
    fn yields_nothing_for_a_reference_with_no_session() {
        assert_eq!(parse_tmux_ref(None), (None, None));
        assert_eq!(parse_tmux_ref(Some("")), (None, None));
        assert_eq!(parse_tmux_ref(Some("no-colon-here")), (None, None));
        // A dot before the colon is part of the session name, not a pane.
        let (s, p) = parse_tmux_ref(Some("a.b:c"));
        assert_eq!(s.as_deref(), Some("a.b"));
        assert!(p.is_none());
    }

    #[test]
    fn builds_an_agent_from_a_complete_record() {
        let a = to_agent(&serde_json::json!({
            "sessionId": "abc",
            "pid": SOME_PID,
            "cwd": "/Users/me/Projects/thing",
            "status": "waiting",
            "waitingFor": "dialog open",
            "version": "2.1.0",
            "nameSource": "derived",
            "name": "the parser",
            "tmux": "claude-9:@1.%12",
        }))
        .expect("agent");
        assert_eq!(a.name, "the parser");
        assert_eq!(a.folder, "thing");
        assert_eq!(a.status, AgentStatus::Waiting);
        assert_eq!(a.waiting_for.as_deref(), Some("dialog open"));
        assert_eq!(a.pane_id.as_deref(), Some("%12"));
        assert_eq!(a.tmux_session.as_deref(), Some("claude-9"));
        assert_eq!(a.derived_name, Some(true));
        assert_eq!(a.kind, "interactive");
        assert!(a.attach_blocked_reason.is_none());
    }

    #[test]
    fn refuses_a_record_missing_what_the_ui_needs() {
        assert!(to_agent(&serde_json::json!({ "pid": 1, "cwd": "/x" })).is_none());
        assert!(to_agent(&serde_json::json!({ "sessionId": "a", "cwd": "/x" })).is_none());
        assert!(to_agent(&serde_json::json!({ "sessionId": "a", "pid": 1 })).is_none());
        // A pid that is not a number is as good as absent.
        assert!(to_agent(&serde_json::json!({ "sessionId": "a", "pid": "1", "cwd": "/x" })).is_none());
    }

    /// A record we can only partly read still lists — it just cannot be
    /// attached to, and says why (INV-5).
    #[test]
    fn degrades_a_record_it_can_only_partly_read() {
        let a = to_agent(&serde_json::json!({ "sessionId": "a", "pid": UNCHECKED_PID, "cwd": "/x" }))
            .expect("agent");
        assert_eq!(a.name, format!("pid {UNCHECKED_PID}"));
        assert_eq!(a.status, AgentStatus::Unknown);
        assert!(a.pane_id.is_none());
        assert_eq!(a.attach_blocked_reason.as_deref(), Some("session is not running inside tmux"));

        let b = to_agent(&serde_json::json!({
            "sessionId": "b", "pid": UNCHECKED_PID, "cwd": "/x", "tmux": "garbage",
        }))
        .expect("agent");
        assert_eq!(b.attach_blocked_reason.as_deref(), Some("tmux pane id could not be parsed"));

        // An unrecognised status is `unknown`, not a rejected record.
        let c = to_agent(&serde_json::json!({
            "sessionId": "c", "pid": UNCHECKED_PID, "cwd": "/x", "status": "exploding",
        }))
        .expect("agent");
        assert_eq!(c.status, AgentStatus::Unknown);
    }

    /// A session file is a Claude Code session, and the record has to say so.
    ///
    /// `Agent` derives `Default`, so a forgotten field is `""` — a kind that
    /// matches no spec and therefore denies every capability: no chat tab, no
    /// slash commands, and nothing on screen to explain why.
    #[test]
    fn every_agent_from_a_session_file_names_its_kind() {
        let a = to_agent(&serde_json::json!({ "sessionId": "a", "pid": UNCHECKED_PID, "cwd": "/x" }))
            .expect("agent");
        assert_eq!(a.agent_kind, CLAUDE_KIND);
        assert!(crate::agent_kinds::allows_slash_commands(&a.agent_kind));
        assert!(crate::agent_kinds::has_transcripts(&a.agent_kind));
    }

    #[tokio::test]
    async fn no_agent_reaches_the_fleet_with_an_empty_kind() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "a.json", live_session("a"));
        write_session(dir.path(), "b.json", live_session("b"));
        for agent in read_session_files(dir.path()).await {
            assert!(!agent.agent_kind.is_empty(), "{} has no kind", agent.session_id);
        }
    }

    /* ---- the session id, which is how `/clear` is verified ---- */

    #[tokio::test]
    async fn reads_the_session_id_a_pid_is_running_now() {
        let dir = tempfile::tempdir().unwrap();
        let record = format!("{SOME_PID}.json");
        write_session(dir.path(), &record, serde_json::json!({ "sessionId": "before" }));
        assert_eq!(read_session_id_in(dir.path(), SOME_PID).await.as_deref(), Some("before"));

        // `/clear` rewrites this file in place, under a new id.
        write_session(dir.path(), &record, serde_json::json!({ "sessionId": "after" }));
        assert_eq!(read_session_id_in(dir.path(), SOME_PID).await.as_deref(), Some("after"));
    }

    /// INV-5: a record that is missing, torn or the wrong shape is `None`, and
    /// the caller reports an unverified clear rather than an error.
    #[tokio::test]
    async fn an_unreadable_session_record_yields_no_id_rather_than_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_session_id_in(dir.path(), PID_WITH_NO_RECORD).await.is_none());
        std::fs::write(dir.path().join("1.json"), r#"{"sessionId":"a"#).unwrap();
        assert!(read_session_id_in(dir.path(), 1).await.is_none());
        write_session(
            dir.path(),
            "2.json",
            serde_json::json!({ "sessionId": A_NUMBER_WHERE_THE_ID_BELONGS }),
        );
        assert!(read_session_id_in(dir.path(), 2).await.is_none());
    }

    #[test]
    fn sorts_waiting_first_then_busy_idle_unknown_then_by_name() {
        let mk = |name: &str, status| Agent {
            session_id: name.into(),
            name: name.into(),
            status,
            ..Default::default()
        };
        let sorted = sort_agents(&[
            mk("zeta", AgentStatus::Idle),
            mk("Banana", AgentStatus::Idle),
            mk("apple", AgentStatus::Idle),
            mk("ghost", AgentStatus::Unknown),
            mk("worker", AgentStatus::Busy),
            mk("blocked", AgentStatus::Waiting),
        ]);
        let names: Vec<&str> = sorted.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["blocked", "worker", "apple", "Banana", "zeta", "ghost"]);
    }

    #[tokio::test]
    async fn skips_malformed_records_without_losing_the_fleet() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "good.json", live_session("good"));
        std::fs::write(dir.path().join("torn.json"), r#"{"sessionId":"torn","pi"#).unwrap();
        std::fs::write(dir.path().join("notjson.json"), "hello").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), "{}").unwrap();
        // A record whose process is long gone.
        write_session(
            dir.path(),
            "dead.json",
            serde_json::json!({ "sessionId": "dead", "pid": 2_000_000_001i64, "cwd": "/x" }),
        );

        let agents = read_session_files(dir.path()).await;
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].session_id, "good");
    }

    #[tokio::test]
    async fn an_absent_sessions_directory_is_an_empty_fleet() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_session_files(&dir.path().join("nope")).await.is_empty());
    }

    #[tokio::test]
    async fn cli_presence_is_none_when_the_binary_is_absent() {
        let cli = FakeCli::new(None, Duration::ZERO);
        assert!(read_cli_session_ids(cli.as_ref()).await.is_none());
    }

    #[tokio::test]
    async fn cli_presence_is_none_when_the_output_is_not_a_list() {
        let cli = FakeCli::new(Some("not json"), Duration::ZERO);
        assert!(read_cli_session_ids(cli.as_ref()).await.is_none());
        let cli = FakeCli::new(Some(r#"{"sessionId":"a"}"#), Duration::ZERO);
        assert!(read_cli_session_ids(cli.as_ref()).await.is_none());
    }

    #[tokio::test]
    async fn cli_presence_collects_session_ids() {
        let cli = FakeCli::new(Some(r#"[{"sessionId":"a"},{},{"sessionId":"b"}]"#), Duration::ZERO);
        let ids = read_cli_session_ids(cli.as_ref()).await.expect("ids");
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("a") && ids.contains("b"));
    }

    /* ---- the source ---- */

    #[tokio::test]
    async fn lists_sessions_and_broadcasts_on_change() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "a.json", live_session("a"));
        let cli = FakeCli::new(None, Duration::ZERO);
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: cli.clone(),
            pending: None,
            tick: UNHURRIED_TICK,
            reconcile_every: LONGER_THAN_THE_TEST,
        });

        let seen = Arc::new(AtomicUsize::new(0));
        let s = Arc::clone(&seen);
        let _keep = src.on_change(Box::new(move |_| {
            s.fetch_add(1, Ordering::SeqCst);
        }));

        src.start().await.unwrap();
        assert_eq!(src.list().len(), 1);
        assert!(src.get("a").is_some());

        write_session(dir.path(), "b.json", live_session("b"));
        wait_until(|| src.list().len() == 2).await;
        assert!(seen.load(Ordering::SeqCst) >= 1);

        // A tick that finds nothing new must not re-broadcast.
        let before = seen.load(Ordering::SeqCst);
        tokio::time::sleep(SEVERAL_QUIET_TICKS).await;
        assert_eq!(seen.load(Ordering::SeqCst), before);
        src.stop();
    }

    /// The two-tier scheme, asserted as a ratio rather than a timetable: the
    /// cheap read runs many times over a span in which the ~680ms authority
    /// runs once or twice.
    #[tokio::test]
    async fn the_expensive_authority_stays_off_the_fast_path() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "a.json", live_session("a"));
        let cli = FakeCli::new(Some(r#"[{"sessionId":"a"}]"#), CHEAP_CLI);
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: cli.clone(),
            pending: None,
            tick: RAPID_TICK,
            reconcile_every: UNHURRIED_RECONCILE,
        });
        src.start().await.unwrap();
        tokio::time::sleep(A_COUPLE_OF_RECONCILES).await;
        src.stop();

        // One at startup plus at most a couple of scheduled passes, against
        // ~50 cheap ticks in the same window.
        let calls = cli.calls.load(Ordering::SeqCst);
        assert!(
            (1..=MOST_RECONCILES_THE_WINDOW_ALLOWS).contains(&calls),
            "claude was called {calls} times in {A_COUPLE_OF_RECONCILES:?}"
        );
    }

    /// INV-4: a poll cannot overlap itself or outrun its own cost. The stub
    /// costs far more than the interval, so a fixed-rate scheduler would stack
    /// calls; re-arming after completion cannot.
    #[tokio::test]
    async fn the_reconcile_never_overlaps_itself_or_outruns_its_cost() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "a.json", live_session("a"));
        let cost = COSTLY_CLI;
        let cli = FakeCli::new(Some(r#"[{"sessionId":"a"}]"#), cost);
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: cli.clone(),
            pending: None,
            tick: RAPID_TICK,
            reconcile_every: RECONCILE_SHORTER_THAN_ITS_WORK,
        });
        src.start().await.unwrap();
        tokio::time::sleep(SEVERAL_COSTLY_RECONCILES).await;
        src.stop();

        assert_eq!(
            cli.max_in_flight.load(Ordering::SeqCst),
            1,
            "two reconciles were in flight at once"
        );
        let starts = cli.starts.lock().unwrap().clone();
        assert!(starts.len() >= 2, "not enough passes to judge spacing");
        for pair in starts.windows(2) {
            let gap = pair[1] - pair[0];
            assert!(
                gap >= cost,
                "a pass started {gap:?} after the previous one, inside its {cost:?} cost"
            );
        }
    }

    /// The fast path is guarded the same way: a filesystem event landing during
    /// a tick is dropped rather than queued into a second concurrent scan.
    #[tokio::test]
    async fn a_refresh_cannot_overlap_itself() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "a.json", live_session("a"));
        let cli = FakeCli::new(None, Duration::ZERO);
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: cli,
            pending: None,
            tick: HAMMERED_TICK,
            reconcile_every: LONGER_THAN_THE_TEST,
        });
        src.start().await.unwrap();
        // Hammer the directory: every write is a watch event, and the tick is
        // running underneath. Nothing here may panic or double-count.
        for i in 0..BURST_SIZE {
            write_session(dir.path(), &format!("s{i}.json"), live_session(&format!("s{i}")));
        }
        wait_until(|| src.list().len() == BURST_SIZE + 1).await;
        src.stop();
    }

    /// The CLI is the authority on presence: a session file whose id the CLI
    /// does not list is a ghost from a reused pid and is dropped.
    #[tokio::test]
    async fn drops_a_session_the_cli_does_not_confirm() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "a.json", live_session("a"));
        write_session(dir.path(), "ghost.json", live_session("ghost"));
        let cli = FakeCli::new(Some(r#"[{"sessionId":"a"}]"#), Duration::ZERO);
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: cli,
            pending: None,
            tick: TEST_TICK,
            reconcile_every: PROMPT_RECONCILE,
        });
        src.start().await.unwrap();
        wait_until(|| src.list().len() == 1).await;
        assert_eq!(src.list()[0].session_id, "a");
        src.stop();
    }

    /// ...but a CLI that never answers must not empty the fleet.
    #[tokio::test]
    async fn keeps_everything_when_the_cli_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "a.json", live_session("a"));
        write_session(dir.path(), "b.json", live_session("b"));
        let cli = FakeCli::new(None, Duration::ZERO);
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: cli,
            pending: None,
            tick: TEST_TICK,
            reconcile_every: RECONCILE_SHORTER_THAN_ITS_WORK,
        });
        src.start().await.unwrap();
        tokio::time::sleep(SEVERAL_QUIET_TICKS).await;
        assert_eq!(src.list().len(), 2);
        src.stop();
    }

    /// Pending entries are ours, not the CLI's, so the presence filter must not
    /// eat the session someone just spawned.
    #[tokio::test]
    async fn a_pending_session_survives_the_presence_filter() {
        struct OnePending;
        #[async_trait]
        impl PendingMerge for OnePending {
            async fn merge(&self, real: Vec<Agent>) -> Vec<Agent> {
                let mut out = vec![Agent {
                    session_id: "pending:claude-1".into(),
                    name: "starting".into(),
                    status: AgentStatus::Waiting,
                    ..Default::default()
                }];
                out.extend(real);
                out
            }
        }

        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "a.json", live_session("a"));
        let cli = FakeCli::new(Some(r#"[{"sessionId":"a"}]"#), Duration::ZERO);
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: cli,
            pending: Some(Arc::new(OnePending)),
            tick: TEST_TICK,
            reconcile_every: RECONCILE_SHORTER_THAN_ITS_WORK,
        });
        src.start().await.unwrap();
        tokio::time::sleep(SEVERAL_QUIET_TICKS).await;
        let ids: Vec<String> = src.list().into_iter().map(|a| a.session_id).collect();
        assert!(ids.contains(&"pending:claude-1".to_string()), "got {ids:?}");
        assert!(ids.contains(&"a".to_string()));
        src.stop();
    }

    /// Enrichment survives the next session-file read; the file knows nothing
    /// about activity lines and must not blank them twice a second.
    #[tokio::test]
    async fn a_refresh_does_not_blank_enrichment() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), "a.json", live_session("a"));
        let cli = FakeCli::new(None, Duration::ZERO);
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: cli,
            pending: None,
            tick: TEST_TICK,
            reconcile_every: LONGER_THAN_THE_TEST,
        });
        src.start().await.unwrap();
        src.enrich(
            "a",
            AgentPatch {
                activity: Some("Edit: src/app.ts".into()),
                tokens: Some(ENRICHED_TOKENS),
                ..Default::default()
            },
        );
        tokio::time::sleep(A_FEW_TICKS).await;
        let a = src.get("a").expect("agent");
        assert_eq!(a.activity.as_deref(), Some("Edit: src/app.ts"));
        assert_eq!(a.tokens, Some(ENRICHED_TOKENS));
        // ...while the session file stays authoritative for its own fields.
        assert_eq!(a.status, AgentStatus::Busy);
        src.stop();
    }

    #[tokio::test]
    async fn notify_pushes_the_current_list_and_unsubscribe_stops_it() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(None, Duration::ZERO);
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: cli,
            pending: None,
            tick: LONGER_THAN_THE_TEST,
            reconcile_every: LONGER_THAN_THE_TEST,
        });
        let seen = Arc::new(AtomicUsize::new(0));
        let s = Arc::clone(&seen);
        let off = src.on_change(Box::new(move |_| {
            s.fetch_add(1, Ordering::SeqCst);
        }));
        src.notify();
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        off();
        src.notify();
        assert_eq!(seen.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_dead_or_nonsense_pid_is_not_alive() {
        assert!(is_alive(std::process::id() as i64));
        assert!(!is_alive(0));
        assert!(!is_alive(-1));
        // Beyond any plausible pid_t on the platforms this ships to.
        assert!(!is_alive(2_000_000_001));
    }

    /* ---- INV-4: an unconfirmed session is asked about, once ---- */

    /// A source with no loops running, so a test drives `refresh` and
    /// `reconcile` itself and every `claude agents --json` is one it asked for.
    fn presence_source(dir: &Path, cli: Arc<FakeCli>) -> Arc<LiveSource> {
        LiveSource::configured(SourceConfig {
            dir: dir.into(),
            runner: cli,
            pending: None,
            tick: LONGER_THAN_THE_TEST,
            reconcile_every: LONGER_THAN_THE_TEST,
        })
    }

    /// Let a `reconcile` fired from inside a refresh run to completion.
    async fn settle() {
        tokio::time::sleep(ONE_RECONCILE).await;
    }

    /// The 30s reconcile is the wrong latency for the common case: an agent
    /// someone just started in a terminal was invisible for up to half a
    /// minute, in an app whose whole claim is that you can see every agent at a
    /// glance.
    #[tokio::test]
    async fn inv4_does_not_wait_for_the_slow_reconcile_to_show_a_new_agent() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let src = presence_source(dir.path(), cli.clone());

        write_session(dir.path(), "live-one.json", live_session("live-one"));
        Arc::clone(&src.inner).reconcile().await;
        assert_eq!(src.list().len(), 1);
        let asked_so_far = cli.calls.load(Ordering::SeqCst);

        // A second agent appears on disk. The CLI has not been asked about it
        // yet, so on the old behaviour this refresh dropped it silently.
        *cli.out.lock().unwrap() =
            Some(r#"[{"sessionId":"live-one"},{"sessionId":"live-two"}]"#.into());
        write_session(dir.path(), "live-two.json", live_session("live-two"));
        src.inner.refresh().await;
        settle().await;

        assert_eq!(cli.calls.load(Ordering::SeqCst), asked_so_far + 1);
        let mut ids: Vec<String> = src.list().into_iter().map(|a| a.session_id).collect();
        ids.sort();
        assert_eq!(ids, ["live-one", "live-two"]);
    }

    /// The thing that has to be true for the above to be safe: a ghost that is
    /// never confirmed must not turn the 30s reconcile into a 2s one.
    #[tokio::test]
    async fn inv4_asks_once_for_a_ghost_not_once_per_scan() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let src = presence_source(dir.path(), cli.clone());

        write_session(dir.path(), "live-one.json", live_session("live-one"));
        Arc::clone(&src.inner).reconcile().await;
        let asked_so_far = cli.calls.load(Ordering::SeqCst);

        // A session file whose process is alive but which the CLI will never
        // confirm: a reused pid, which is what the presence check exists for.
        write_session(dir.path(), "ghost.json", live_session("ghost"));
        for _ in 0..5 {
            src.inner.refresh().await;
            settle().await;
        }

        assert_eq!(cli.calls.load(Ordering::SeqCst), asked_so_far + 1);
        assert_eq!(src.list().len(), 1, "a ghost reached the fleet");
        assert_eq!(src.list()[0].session_id, "live-one");
    }

    /// A pid genuinely reused later deserves a fresh question rather than being
    /// remembered as a ghost for the life of the process.
    #[tokio::test]
    async fn inv4_asks_again_when_the_same_id_comes_back_after_its_file_went_away() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let src = presence_source(dir.path(), cli.clone());

        write_session(dir.path(), "live-one.json", live_session("live-one"));
        Arc::clone(&src.inner).reconcile().await;
        let asked_so_far = cli.calls.load(Ordering::SeqCst);

        write_session(dir.path(), "ghost.json", live_session("ghost"));
        src.inner.refresh().await;
        settle().await;
        assert_eq!(cli.calls.load(Ordering::SeqCst), asked_so_far + 1);

        std::fs::remove_file(dir.path().join("ghost.json")).unwrap();
        src.inner.refresh().await;
        write_session(dir.path(), "ghost.json", live_session("ghost"));
        src.inner.refresh().await;
        settle().await;

        assert_eq!(cli.calls.load(Ordering::SeqCst), asked_so_far + 2);
    }

    /// `/clear` rewrites the session file with a new id. The process is the one
    /// the CLI already confirmed, so the agent is listed under the new id on
    /// the very pass that finds it — not after a reconcile, and not with a gap
    /// in which it is under neither.
    #[tokio::test]
    async fn inv8_a_cleared_session_is_listed_under_its_new_id_on_sight() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"before"}]"#), Duration::ZERO);
        let src = presence_source(dir.path(), cli.clone());

        write_session(dir.path(), "own-pid.json", live_session("before"));
        Arc::clone(&src.inner).reconcile().await;
        assert_eq!(src.list()[0].session_id, "before");
        let asked_so_far = cli.calls.load(Ordering::SeqCst);

        // Same file, same pid, a fresh id: what Claude Code writes on `/clear`.
        write_session(dir.path(), "own-pid.json", live_session("after"));
        src.inner.refresh().await;

        let ids: Vec<String> = src.list().into_iter().map(|a| a.session_id).collect();
        assert_eq!(ids, ["after"], "the new id waited for the CLI, or the old one lingered");
        // And it stays listed on the next pass without the CLI having been
        // asked in between.
        src.inner.refresh().await;
        settle().await;
        assert_eq!(src.list()[0].session_id, "after");
        assert_eq!(cli.calls.load(Ordering::SeqCst), asked_so_far);
    }

    /// The other half of the rule above: the *same* id under the same pid is
    /// the ghost, and vouching for it would resurrect exactly what the presence
    /// check drops.
    #[tokio::test]
    async fn inv8_succession_does_not_vouch_for_a_ghost_under_its_own_id() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let src = presence_source(dir.path(), cli.clone());

        write_session(dir.path(), "own-pid.json", live_session("live-one"));
        Arc::clone(&src.inner).reconcile().await;
        assert_eq!(src.list().len(), 1);

        // The CLI stops listing it; the file, and the pid, are still there.
        *cli.out.lock().unwrap() = Some("[]".into());
        Arc::clone(&src.inner).reconcile().await;
        assert_eq!(src.list().len(), 0, "a ghost was vouched for");
    }

    /// With no presence answer yet there is nothing to be unrecognised
    /// against, and everything on disk is shown. A refresh here must not spawn
    /// anything.
    #[tokio::test]
    async fn inv4_does_not_ask_before_the_cli_has_ever_answered() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let src = presence_source(dir.path(), cli.clone());

        write_session(dir.path(), "live-one.json", live_session("live-one"));
        src.inner.refresh().await;
        settle().await;

        assert_eq!(cli.calls.load(Ordering::SeqCst), 0);
        assert_eq!(src.list().len(), 1);
    }

    /// A refresh that finds nothing to publish must still put the question:
    /// an unrecognised id changes nothing precisely *because* it was skipped.
    #[tokio::test]
    async fn inv4_asks_even_when_the_pass_publishes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some("[]"), Duration::ZERO);
        let src = presence_source(dir.path(), cli.clone());

        Arc::clone(&src.inner).reconcile().await;
        let asked_so_far = cli.calls.load(Ordering::SeqCst);
        assert!(src.list().is_empty());

        write_session(dir.path(), "new.json", live_session("new"));
        src.inner.refresh().await;
        settle().await;

        assert_eq!(cli.calls.load(Ordering::SeqCst), asked_so_far + 1);
    }

    /* ---- INV-4: the CLI is asked when there is a question for it ---- */

    /// A process start the test can move, standing in for the kernel handing
    /// a pid to somebody else.
    fn movable_start() -> (Arc<AtomicU64>, Arc<StartReader>) {
        let start = Arc::new(AtomicU64::new(1));
        let reader = start.clone();
        (start, Arc::new(move |_pid| Some(reader.load(Ordering::SeqCst))))
    }

    /// `presence_source`, reading process starts from `start_of` and allowed
    /// to stay quiet for `backstop` with nothing to ask.
    fn anchored_source(
        dir: &Path,
        cli: Arc<FakeCli>,
        start_of: Arc<StartReader>,
        reconcile_every: Duration,
    ) -> Arc<LiveSource> {
        let config = SourceConfig {
            dir: dir.into(),
            runner: cli,
            pending: None,
            tick: LONGER_THAN_THE_TEST,
            reconcile_every,
        };
        LiveSource::assembled(config, start_of, Some(LONGER_THAN_THE_TEST), None)
    }

    /// `anchored_source`, with a tick allowed to skip the read for longer than
    /// the test and a watch armed long enough ago to have settled.
    fn quiet_source(
        dir: &Path,
        start_of: Arc<StartReader>,
        pending: Option<Arc<dyn PendingMerge>>,
    ) -> Arc<LiveSource> {
        let config = SourceConfig {
            dir: dir.into(),
            runner: FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO),
            pending,
            tick: LONGER_THAN_THE_TEST,
            reconcile_every: LONGER_THAN_THE_TEST,
        };
        let quiet = Some(LONGER_THAN_THE_TEST);
        let src = LiveSource::assembled(config, start_of, quiet, quiet);
        *src.inner.armed_at.lock().unwrap() = Some(Instant::now() - SETTLING);
        src
    }

    /// INV-4: an idle fleet costs a liveness check a tick, not a read and a
    /// parse of every session file — and only once the watch can be trusted.
    #[tokio::test]
    async fn inv4_a_settled_tick_skips_the_read_while_nothing_moved() {
        let dir = tempfile::tempdir().unwrap();
        let (_start, start_of) = movable_start();
        let src = quiet_source(dir.path(), start_of, None);
        write_session(dir.path(), "live-one.json", live_session("live-one"));
        Arc::clone(&src.inner).reconcile().await;
        assert_eq!(src.list().len(), 1);
        assert!(!src.inner.must_read());

        *src.inner.armed_at.lock().unwrap() = Some(Instant::now());
        assert!(src.inner.must_read(), "a watch this young may have missed a write");
        *src.inner.armed_at.lock().unwrap() = None;
        assert!(src.inner.must_read(), "with no watch, every tick reads");
    }

    /// The change no write announces: the kernel handing the pid on. The quiet
    /// tick sees it on the next period, not at `REREAD`.
    #[tokio::test]
    async fn inv4_a_pid_handed_on_makes_the_quiet_tick_read() {
        let dir = tempfile::tempdir().unwrap();
        let (start, start_of) = movable_start();
        let src = quiet_source(dir.path(), start_of, None);
        write_session(dir.path(), "live-one.json", live_session("live-one"));
        Arc::clone(&src.inner).reconcile().await;
        assert!(!src.inner.must_read());

        start.store(2, Ordering::SeqCst);
        assert!(src.inner.must_read());
    }

    /// A process that dies without removing its file changes nothing on disk.
    #[tokio::test]
    async fn inv4_a_process_that_died_makes_the_quiet_tick_read() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let mut record = live_session("live-one");
        record["pid"] = child.id().into();
        let src = quiet_source(dir.path(), Arc::new(process_start), None);
        write_session(dir.path(), "live-one.json", record);
        Arc::clone(&src.inner).reconcile().await;
        assert_eq!(src.list().len(), 1);
        assert!(!src.inner.must_read());

        child.kill().unwrap();
        child.wait().unwrap();
        assert!(src.inner.must_read());
    }

    /// A spawn waiting to register is shown, and dropped, only by a read.
    #[tokio::test]
    async fn inv4_a_spawn_waiting_to_register_keeps_the_tick_reading() {
        struct StillStarting;
        #[async_trait]
        impl PendingMerge for StillStarting {
            async fn merge(&self, real: Vec<Agent>) -> Vec<Agent> {
                real
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let (_start, start_of) = movable_start();
        let src = quiet_source(dir.path(), start_of, Some(Arc::new(StillStarting)));
        Arc::clone(&src.inner).reconcile().await;
        assert!(src.inner.must_read());
    }

    /// A refresh asked for while one is in flight is owed, not dropped: that
    /// pass may have read the directory before the change landed, and the
    /// quiet tick will not read it again for `REREAD`.
    #[tokio::test]
    async fn inv4_a_refresh_asked_for_mid_flight_reads_again() {
        #[derive(Default)]
        struct Held {
            passes: AtomicUsize,
            entered: tokio::sync::Notify,
            release: tokio::sync::Notify,
        }
        #[async_trait]
        impl PendingMerge for Held {
            async fn merge(&self, real: Vec<Agent>) -> Vec<Agent> {
                if self.passes.fetch_add(1, Ordering::SeqCst) == 0 {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                real
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let held = Arc::new(Held::default());
        let src = LiveSource::configured(SourceConfig {
            dir: dir.path().into(),
            runner: FakeCli::new(Some("[]"), Duration::ZERO),
            pending: Some(held.clone()),
            tick: LONGER_THAN_THE_TEST,
            reconcile_every: LONGER_THAN_THE_TEST,
        });
        let inner = Arc::clone(&src.inner);
        let in_flight = tokio::spawn(async move { inner.refresh().await });
        held.entered.notified().await;

        src.inner.refresh().await;
        assert_eq!(held.passes.load(Ordering::SeqCst), 1, "no second pass alongside");
        held.release.notify_one();
        in_flight.await.unwrap();
        assert_eq!(held.passes.load(Ordering::SeqCst), 2, "the pass in flight read again");
    }

    /// What the 30s reconcile used to be the only defence against: the
    /// session file outlives its process and the pid goes to somebody else.
    /// `is_alive` says yes; the start says it is not the same process, and the
    /// agent leaves the fleet on that pass rather than at the next poll.
    #[tokio::test]
    async fn inv4_a_pid_another_process_now_holds_is_dropped_and_asked_about() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let (start, start_of) = movable_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, LONGER_THAN_THE_TEST);

        write_session(dir.path(), "live-one.json", live_session("live-one"));
        Arc::clone(&src.inner).reconcile().await;
        assert_eq!(src.list().len(), 1);
        let asked_so_far = cli.calls.load(Ordering::SeqCst);

        *cli.out.lock().unwrap() = Some("[]".into());
        start.fetch_add(1, Ordering::SeqCst);
        src.inner.refresh().await;
        assert!(src.list().is_empty(), "a reused pid stayed in the fleet");
        settle().await;

        assert_eq!(cli.calls.load(Ordering::SeqCst), asked_so_far + 1, "the CLI was not asked");
        src.inner.refresh().await;
        assert!(src.list().is_empty());
    }

    /// The same process seen again is the ordinary case, and asks nothing.
    #[tokio::test]
    async fn inv4_an_unmoved_start_asks_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let (_start, start_of) = movable_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, LONGER_THAN_THE_TEST);

        write_session(dir.path(), "live-one.json", live_session("live-one"));
        Arc::clone(&src.inner).reconcile().await;
        let asked_so_far = cli.calls.load(Ordering::SeqCst);
        for _ in 0..5 {
            src.inner.refresh().await;
            settle().await;
        }

        assert_eq!(cli.calls.load(Ordering::SeqCst), asked_so_far);
        assert_eq!(src.list().len(), 1);
    }

    /// With every agent vouched for and the pids still theirs, the periodic
    /// pass has nothing to put to a ~680ms subprocess and does not.
    #[tokio::test]
    async fn inv4_the_periodic_pass_is_quiet_with_nothing_to_ask() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let (_start, start_of) = movable_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, PROMPT_RECONCILE);

        write_session(dir.path(), "live-one.json", live_session("live-one"));
        src.start().await.unwrap();
        wait_until(|| cli.calls.load(Ordering::SeqCst) >= 1).await;
        tokio::time::sleep(SEVERAL_QUIET_TICKS).await;

        assert_eq!(cli.calls.load(Ordering::SeqCst), 1, "only the startup pass should have asked");
        src.stop();
    }

    /// An open question keeps the old cadence: a ghost the CLI refused, or an
    /// agent it has not caught up with yet, is asked about every period.
    #[tokio::test]
    async fn inv4_an_open_question_is_asked_every_period() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let (_start, start_of) = movable_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, PROMPT_RECONCILE);

        write_session(dir.path(), "live-one.json", live_session("live-one"));
        write_session(dir.path(), "ghost.json", live_session("ghost"));
        src.start().await.unwrap();
        tokio::time::sleep(SEVERAL_QUIET_TICKS).await;

        // Startup, the ask on sight, then one per period for the ghost.
        let calls = cli.calls.load(Ordering::SeqCst);
        assert!(calls > 2, "the open question was asked {calls} times");
        assert_eq!(src.list().len(), 1, "a ghost reached the fleet");
        src.stop();
    }

    /// A CLI that failed has not answered anything, so the question stays
    /// open and the next period asks again.
    #[tokio::test]
    async fn inv4_a_failed_call_is_retried_on_the_next_period() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(None, Duration::ZERO);
        let (_start, start_of) = movable_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, PROMPT_RECONCILE);

        write_session(dir.path(), "live-one.json", live_session("live-one"));
        src.start().await.unwrap();
        tokio::time::sleep(SEVERAL_QUIET_TICKS).await;

        let calls = cli.calls.load(Ordering::SeqCst);
        assert!(calls > 1, "a failed call was asked {calls} times");
        src.stop();
    }

    /* ---- INV-4: a file naming its own process is its own answer ---- */

    /// `procStart` as Claude Code writes it, and the kernel's start of the same
    /// process, a quarter of a second in.
    const OWN_START: &str = "Mon Oct 12 01:43:15 2026";
    const OWN_START_SECS: u64 = 1_791_769_395;
    const OWN_START_MICROS: u64 = OWN_START_SECS * MICROS_PER_SECOND + 250_000;
    /// A start no process on the pid has: the file outlived the one it names.
    const STALE_START: &str = "Mon Jan  5 09:00:00 2026";

    fn claiming(session_id: &str, proc_start: &str) -> serde_json::Value {
        let mut session = live_session(session_id);
        session["procStart"] = proc_start.into();
        session
    }

    /// Every pid started at `OWN_START`, until the test moves it.
    fn own_start() -> (Arc<AtomicU64>, Arc<StartReader>) {
        let start = Arc::new(AtomicU64::new(OWN_START_MICROS));
        let reader = start.clone();
        (start, Arc::new(move |_pid| Some(reader.load(Ordering::SeqCst))))
    }

    #[test]
    fn lstart_is_read_as_a_utc_wall_clock() {
        assert_eq!(claimed_start(OWN_START), i64::try_from(OWN_START_SECS).ok());
        assert_eq!(claimed_start(STALE_START), Some(1_767_603_600));
        assert_eq!(claimed_start("Thu Feb 29 23:59:59 2024"), Some(1_709_251_199));
        for unreadable in ["", "yesterday", "Mo 12 Okt 01:43:15 2026", "Mon Oct 12 01:43 2026"] {
            assert_eq!(claimed_start(unreadable), None, "{unreadable:?}");
        }
    }

    /// `lstart` names no zone, so a start written in local time is the same
    /// process as one written in UTC — and nothing else is.
    #[test]
    fn either_reading_of_a_zoneless_start_is_the_same_process() {
        const EAST_OF_UTC: i64 = -4 * 3_600;
        let started = 1_000_000;
        assert!(names_this_start(started, started, None));
        assert!(names_this_start(started + EAST_OF_UTC, started, Some(EAST_OF_UTC)));
        assert!(!names_this_start(started + EAST_OF_UTC, started, None));
        assert!(!names_this_start(started - 2, started, Some(0)));
    }

    #[test]
    fn evidence_is_silent_without_both_sides() {
        assert_eq!(evidence(None, Some(OWN_START_MICROS)), Evidence::Silent);
        assert_eq!(evidence(Some(OWN_START), None), Evidence::Silent);
        assert_eq!(evidence(Some("not a date"), Some(OWN_START_MICROS)), Evidence::Silent);
        assert_eq!(evidence(Some(OWN_START), Some(OWN_START_MICROS)), Evidence::Same);
        assert_eq!(evidence(Some(STALE_START), Some(OWN_START_MICROS)), Evidence::Another);
    }

    /// An agent started in a terminal is listed on the pass that finds its
    /// file, without a ~680ms call: the file names the process on its pid.
    #[tokio::test]
    async fn inv4_a_file_naming_its_own_process_is_listed_without_asking() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let (_start, start_of) = own_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, LONGER_THAN_THE_TEST);

        write_session(dir.path(), "live-one.json", claiming("live-one", OWN_START));
        Arc::clone(&src.inner).reconcile().await;
        let asked_so_far = cli.calls.load(Ordering::SeqCst);

        write_session(dir.path(), "newcomer.json", claiming("newcomer", OWN_START));
        src.inner.refresh().await;
        settle().await;

        let mut ids: Vec<String> = src.list().into_iter().map(|a| a.session_id).collect();
        ids.sort();
        assert_eq!(ids, ["live-one", "newcomer"]);
        assert_eq!(cli.calls.load(Ordering::SeqCst), asked_so_far, "the CLI was asked");
    }

    /// A file naming another process is a ghost from the first pass, not
    /// only once the CLI has first answered: the first fleet a tab is sent
    /// used to carry it.
    #[tokio::test]
    async fn inv4_a_file_naming_another_process_never_reaches_the_fleet() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), ONE_RECONCILE);
        let (_start, start_of) = own_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, LONGER_THAN_THE_TEST);

        write_session(dir.path(), "live-one.json", claiming("live-one", OWN_START));
        write_session(dir.path(), "ghost.json", claiming("ghost", STALE_START));
        src.inner.refresh().await;
        let first: Vec<String> = src.list().into_iter().map(|a| a.session_id).collect();
        assert_eq!(first, ["live-one"], "a ghost reached the first fleet");

        wait_until(|| cli.calls.load(Ordering::SeqCst) == 1).await;
        settle().await;
        assert_eq!(src.list().len(), 1);
    }

    /// Once the CLI has declined a file that names another process, the
    /// question is settled: the file cannot start naming the right one, and
    /// asking every period was two calls a minute for a certainty.
    #[tokio::test]
    async fn inv4_a_declined_ghost_is_not_asked_about_every_period() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"live-one"}]"#), Duration::ZERO);
        let (_start, start_of) = own_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, PROMPT_RECONCILE);

        write_session(dir.path(), "live-one.json", claiming("live-one", OWN_START));
        write_session(dir.path(), "ghost.json", claiming("ghost", STALE_START));
        src.start().await.unwrap();
        tokio::time::sleep(SEVERAL_QUIET_TICKS).await;

        assert_eq!(cli.calls.load(Ordering::SeqCst), 1, "the settled ghost was asked again");
        assert_eq!(src.list().len(), 1, "a ghost reached the fleet");
        src.stop();
    }

    /// The CLI keeps the last word over a file that seems to name another
    /// process — a zone neither reading expects, say.
    #[tokio::test]
    async fn inv4_a_contradicted_file_the_cli_lists_is_shown() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some(r#"[{"sessionId":"odd-zone"}]"#), Duration::ZERO);
        let (_start, start_of) = own_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, LONGER_THAN_THE_TEST);

        write_session(dir.path(), "odd-zone.json", claiming("odd-zone", STALE_START));
        src.inner.refresh().await;
        assert!(src.list().is_empty());
        settle().await;

        assert_eq!(src.list().len(), 1, "the CLI's word was overruled");
    }

    /// A pid handed to another process after its session was listed: the file
    /// now names a process that is not there, and the agent leaves the fleet.
    #[tokio::test]
    async fn inv4_a_listed_session_whose_pid_is_handed_on_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let cli = FakeCli::new(Some("[]"), Duration::ZERO);
        let (start, start_of) = own_start();
        let src = anchored_source(dir.path(), cli.clone(), start_of, LONGER_THAN_THE_TEST);

        write_session(dir.path(), "live-one.json", claiming("live-one", OWN_START));
        Arc::clone(&src.inner).reconcile().await;
        assert_eq!(src.list().len(), 1);

        start.fetch_add(3_600 * MICROS_PER_SECOND, Ordering::SeqCst);
        src.inner.refresh().await;
        assert!(src.list().is_empty(), "a reused pid stayed in the fleet");
    }

    async fn wait_until(mut check: impl FnMut() -> bool) {
        let until = std::time::Instant::now() + PATIENCE;
        while std::time::Instant::now() < until {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not met in time");
    }
}
