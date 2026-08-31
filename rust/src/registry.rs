//! Discovers the Claude Code sessions running on this machine.
//!
//! Port of `src/server/registry.ts`.
//!
//! Two sources, deliberately:
//!   - `~/.claude/sessions/<pid>.json` is the fast path. It is read on a short
//!     tick because it is a local file read (sub-millisecond) and it carries the
//!     `tmux` pane id, which the supported CLI does not expose.
//!   - `claude agents --json` is authoritative for *presence*, but costs ~680ms
//!     per call, so it only runs as a periodic reconcile (INV-4). Collapsing the
//!     two into one poll is the mistake this comment exists to prevent: the
//!     fleet list would then refresh at best twice a second on a good machine
//!     and would serialise behind a subprocess on a loaded one.
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
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;

/// The cheap tick: a directory listing plus a few hundred bytes per session.
const TICK: Duration = Duration::from_secs(2);

/// The expensive one. `claude agents --json` costs ~680ms, measured, so it runs
/// here and nowhere near the fast path.
const RECONCILE: Duration = Duration::from_secs(30);

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
                agents.push(agent);
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
    /// Re-entrancy guard. A refresh triggered by the filesystem watch while a
    /// tick is mid-flight is dropped, not queued.
    refreshing: AtomicBool,
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
    /// confirms it or when its session file goes away, so a pid genuinely
    /// reused later is asked about again.
    asked: Mutex<HashSet<String>>,
    /// Set by `stop`, so a refresh already in flight cannot start a subprocess
    /// after the server has been told to shut down.
    stopped: AtomicBool,
    listeners: Listeners<Vec<Agent>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

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
        if self
            .refreshing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let _guard = InFlightGuard(&self.refreshing);

        let real = read_session_files(&self.dir).await;
        let found = match &self.pending {
            Some(pending) => pending.merge(real).await,
            None => real,
        };

        let pass = self.absorb(found);
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
    fn absorb(&self, found: Vec<Agent>) -> PassOutcome {
        let mut agents = self.agents.lock().unwrap();
        let known = self.known.lock().unwrap();
        let mut asked = self.asked.lock().unwrap();
        let mut next: HashMap<String, Agent> = HashMap::with_capacity(found.len());
        let on_disk: HashSet<String> =
            found.iter().map(|agent| agent.session_id.clone()).collect();
        let mut met_an_unrecognised_id = false;
        for agent in found {
            if is_unconfirmed(&agent, &known) {
                // Not a ghost yet — just unconfirmed. Ask the authority now
                // rather than at the next 30s reconcile; `asked` is what keeps
                // that from becoming a loop.
                met_an_unrecognised_id |= asked.insert(agent.session_id.clone());
                continue;
            }
            asked.remove(&agent.session_id);
            carry_enrichment_forward(&agents, &mut next, agent);
        }
        // A session file that has gone away may come back on a reused pid, and
        // that one deserves a fresh question.
        asked.retain(|id| on_disk.contains(id));
        let published = changed(&agents, &next);
        if published {
            *agents = next;
        }
        PassOutcome { published, met_an_unrecognised_id }
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

        let known = read_cli_session_ids(self.runner.as_ref()).await;
        // A CLI that did not answer leaves the previous answer in place rather
        // than dropping the filter — losing the authority must not silently
        // resurrect ghosts, and must not empty the fleet either.
        if known.is_some() {
            *self.known.lock().unwrap() = known;
            self.refresh().await;
        }
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
    if agent.session_id.starts_with("pending:") {
        return false;
    }
    known.as_ref().is_some_and(|confirmed| !confirmed.contains(&agent.session_id))
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
    if next.pane_id.is_some() {
        prev.pane_id = next.pane_id;
    }
    if next.tmux_session.is_some() {
        prev.tmux_session = next.tmux_session;
    }
    if next.attach_blocked_reason.is_some() {
        prev.attach_blocked_reason = next.attach_blocked_reason;
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
        Self::configured(SourceConfig {
            dir: sessions_dir(),
            runner: exec_runner(),
            pending,
            tick: TICK,
            reconcile_every: RECONCILE,
        })
    }

    /// Fully injected, for tests: a temp directory of session files, a stubbed
    /// command runner, and intervals short enough to observe. Nothing in the
    /// test suite may require a real `claude` binary.
    pub fn configured(config: SourceConfig) -> Arc<LiveSource> {
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
                reconciling: AtomicBool::new(false),
                asked: Mutex::new(HashSet::new()),
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
    /// and some filesystems support no watching at all — which is what the tick
    /// is for. `None` on any of those, which is not an error.
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
                inner.refresh().await;
            }
        })
    }

    /// The expensive poll, guarded the same way.
    fn spawn_the_expensive_reconcile(&self) -> JoinHandle<()> {
        let inner = Arc::clone(&self.inner);
        let every = self.inner.reconcile_every;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
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
