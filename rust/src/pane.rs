//! tmux adapters.
//!
//! INV-1: nothing in this file may create an interactive tmux client. We never
//! run `new-session`, and the only client this app attaches is the control-mode
//! one in [`crate::tmux_client`]. Control mode is what makes that safe: such a
//! client has no size to impose (tmux reports its `client_height` as empty) and
//! acquires one only by asking with `refresh-client -C`, which neither file
//! ever sends. This machine runs tmux with `window-size latest` and
//! `aggressive-resize on`, so a browser-shaped client *would* reflow a TUI that
//! a working agent is drawing into — which is why the Attach view is a capture
//! and not a pty.
//!
//! Every operation here is *one* tmux round trip. It used to be two — a paste
//! was `load-buffer` then `paste-buffer`, and a frame was `display-message`
//! then `capture-pane` — and since the cost of a tmux command is almost
//! entirely the cost of *reaching* tmux rather than of the work asked for
//! (`display-message -p ok` measured p50 72.8ms against a bare fork+exec at
//! 3.0ms), halving the number of round trips halved the latency. Commands are
//! joined with `;`, which tmux reads as a command sequence. Do not "tidy" a
//! combined command back into two calls.
//!
//! Each round trip prefers the persistent control client and falls back to
//! spawning a one-shot tmux. The fallback is not a rare path to be tolerated:
//! it is what runs for the first second of every session, and whenever the
//! control client is restarting.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::oneshot;

use crate::sources::{PaneApi, PaneMeta, PaneSample};
use crate::tmux_client::{tmux_control, TmuxControl};

const TMUX: &str = "tmux";

/// Prefix for the paste buffers this app creates. Never used on its own: see
/// [`buffer_name`] for why one shared name was a way to type into the wrong
/// agent.
const BUFFER_PREFIX: &str = "agent-commander";

static BUFFER_SEQ: AtomicU64 = AtomicU64::new(0);

/// A fresh buffer name for every paste.
///
/// `load-buffer` and `paste-buffer` are now issued as a single tmux command
/// sequence, which removes the await that used to sit between them — but it
/// does not make one shared name safe. Two sequences still interleave at the
/// server, and with one name the second load could still land between the first
/// load and the first paste. The name stays per-paste for the same reason it
/// always did: with a shared one, two overlapping pastes interleaved as
/// load(A) -> load(B) -> paste(A's pane) and the first paste put *B's text*
/// into A's agent.
///
/// The pid is in the name because a second agent-commander on the same machine
/// shares the tmux server, and therefore its buffer namespace.
fn buffer_name() -> String {
    let n = BUFFER_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    format!("{BUFFER_PREFIX}-{}-{}", process::id(), n)
}

/// tmux pane ids look like `%77`. Reject anything else before it reaches argv.
pub fn is_pane_id(pane_id: &str) -> bool {
    match pane_id.strip_prefix('%') {
        Some(digits) => !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

fn assert_pane(pane_id: &str) -> Result<(), PaneError> {
    if is_pane_id(pane_id) {
        Ok(())
    } else {
        Err(PaneError::msg(format!(
            "refusing to use malformed pane id: {pane_id}"
        )))
    }
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct PaneError {
    pub message: String,
    /// The spawn was refused for want of a process slot, so tmux never ran and
    /// nothing was written. The one failure it is safe to retry.
    pub eagain: bool,
}

impl PaneError {
    pub fn msg(message: impl Into<String>) -> Self {
        PaneError { message: message.into(), eagain: false }
    }
    fn eagain(message: impl Into<String>) -> Self {
        PaneError { message: message.into(), eagain: true }
    }
}

/// Everything `display-message` is asked for in one line.
const META_FORMAT: &str =
    "#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}|#{alternate_on}|#{pane_dead}";

fn parse_meta(line: &str) -> Result<PaneMeta, PaneError> {
    let line = line.trim();
    let parts: Vec<&str> = line.split('|').collect();
    if parts.len() < 6 {
        return Err(PaneError::msg(format!(
            "unexpected display-message output: {line}"
        )));
    }
    let num = |i: usize| -> usize { parts[i].trim().parse::<usize>().unwrap_or(0) };
    Ok(PaneMeta {
        cols: num(0),
        rows: num(1),
        cursor_x: num(2),
        cursor_y: num(3),
        alternate: parts[4] == "1",
        dead: parts[5] == "1",
    })
}

/// tmux trims trailing blank lines, so pad back out to the pane's height.
fn pad_capture(mut lines: Vec<String>, rows: usize) -> Vec<String> {
    if lines.len() > rows {
        lines.truncate(rows);
    }
    while lines.len() < rows {
        lines.push(String::new());
    }
    lines
}

fn split_lines(out: &str) -> Vec<String> {
    // A trailing newline from tmux would otherwise become a phantom final line.
    let body = out.strip_suffix('\n').unwrap_or(out);
    body.split('\n').map(str::to_string).collect()
}

/* ------------------------------------------------------- command construction */

fn strs(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

fn meta_args(pane_id: &str) -> Vec<String> {
    strs(&["display-message", "-p", "-t", pane_id, META_FORMAT])
}

/// The same command spelled for control mode.
///
/// The format string is single-quoted so that tmux's argument lexer hands
/// `#{pane_width}` to `display-message` *unexpanded*. Double quotes would have
/// tmux expand it first, against whichever pane the control client considers
/// current — which is never the pane being asked about, so the terminal would
/// have been sized from another agent's window.
fn meta_cmd(pane_id: &str) -> String {
    format!("display-message -p -t {pane_id} '{META_FORMAT}'")
}

fn capture_args(pane_id: &str) -> Vec<String> {
    strs(&["capture-pane", "-e", "-p", "-t", pane_id])
}

fn capture_cmd(pane_id: &str) -> String {
    format!("capture-pane -e -p -t {pane_id}")
}

fn sample_args(pane_id: &str) -> Vec<String> {
    let mut args = meta_args(pane_id);
    args.push(";".to_string());
    args.extend(capture_args(pane_id));
    args
}

fn sample_cmds(pane_id: &str) -> Vec<String> {
    vec![meta_cmd(pane_id), capture_cmd(pane_id)]
}

fn key_args(pane_id: &str, key_name: &str) -> Vec<String> {
    strs(&["send-keys", "-t", pane_id, key_name])
}

fn key_cmd(pane_id: &str, key_name: &str) -> String {
    format!("send-keys -t {pane_id} {key_name}")
}

/// The control-mode form of a paste: load the staged file, paste it, maybe submit.
///
/// `-d` deletes the buffer once it has been pasted; `-p` is bracketed paste, so
/// multi-line input and shell-special characters arrive as text rather than
/// being re-interpreted as keypresses.
fn paste_cmds(buffer: &str, file: &str, pane_id: &str, submit: bool) -> Vec<String> {
    let mut cmds = vec![
        format!("load-buffer -b {buffer} '{file}'"),
        format!("paste-buffer -b {buffer} -t {pane_id} -p -d"),
    ];
    if submit {
        cmds.push(key_cmd(pane_id, "Enter"));
    }
    cmds
}

/// The spawn form of the same sequence; the text arrives on stdin as `-`.
fn paste_args(buffer: &str, pane_id: &str, submit: bool) -> Vec<String> {
    let mut args = strs(&["load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-b", buffer,
        "-t", pane_id, "-p", "-d"]);
    if submit {
        args.push(";".to_string());
        args.extend(key_args(pane_id, "Enter"));
    }
    args
}

/* ------------------------------------------------------------- the two paths */

/// Reaching tmux by spawning a fresh client. The fallback path, and the only
/// one that can write to stdin.
#[async_trait]
pub trait OneShot: Send + Sync + 'static {
    /// A single attempt. The `EAGAIN` retry lives in [`Panes::run`], above this.
    async fn run_once(&self, args: &[String], stdin: Option<&str>) -> Result<String, PaneError>;
}

/// Reaching tmux through the long-lived control client.
#[async_trait]
pub trait Control: Send + Sync + 'static {
    fn ready(&self) -> bool;
    async fn run(&self, commands: &[String]) -> Result<String, PaneError>;
}

pub struct LiveOneShot;

#[async_trait]
impl OneShot for LiveOneShot {
    async fn run_once(&self, args: &[String], stdin: Option<&str>) -> Result<String, PaneError> {
        use std::process::Stdio;
        let mut cmd = tokio::process::Command::new(TMUX);
        cmd.args(args)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                return Err(if is_eagain(&err) {
                    PaneError::eagain(format!("spawn tmux EAGAIN: {err}"))
                } else {
                    PaneError::msg(err.to_string())
                })
            }
        };
        if let Some(text) = stdin {
            use tokio::io::AsyncWriteExt;
            if let Some(mut pipe) = child.stdin.take() {
                let _ = pipe.write_all(text.as_bytes()).await;
                let _ = pipe.shutdown().await;
            }
        }
        let out = match tokio::time::timeout(Duration::from_secs(5), child.wait_with_output()).await
        {
            Ok(Ok(out)) => out,
            Ok(Err(err)) => return Err(PaneError::msg(err.to_string())),
            Err(_) => return Err(PaneError::msg("tmux timed out")),
        };
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(PaneError::msg(if stderr.is_empty() {
                format!("tmux exited with {}", out.status)
            } else {
                stderr
            }));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

/// Did this spawn fail because the machine is out of process slots?
///
/// Rust maps `EAGAIN` to [`std::io::ErrorKind::WouldBlock`]; the raw code is
/// checked too because the mapping is not guaranteed for every platform, and
/// getting this wrong in the other direction — retrying "no such pane" — would
/// type into a live agent twice.
fn is_eagain(err: &std::io::Error) -> bool {
    if err.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }
    // EAGAIN is 35 on macOS, 11 on Linux.
    matches!(err.raw_os_error(), Some(11) | Some(35))
}

pub struct LiveControl(&'static TmuxControl);

#[async_trait]
impl Control for LiveControl {
    fn ready(&self) -> bool {
        self.0.ready()
    }
    async fn run(&self, commands: &[String]) -> Result<String, PaneError> {
        self.0.run(commands).await.map_err(|e| PaneError::msg(e.to_string()))
    }
}

/// How many times a spawn refused for want of a process slot is retried.
///
/// This is not defensive padding. On a machine sitting at 2840 processes
/// against a `kern.maxprocperuid` of 2666 — 109 tmux panes and 33 Claude
/// sessions will do it — spawning returns `EAGAIN` readily, and it did so twice
/// while this path was being measured. Before this, one `EAGAIN` dropped the
/// character the user had just typed, or stopped their terminal outright.
const SPAWN_RETRIES: usize = 4;
const SPAWN_RETRY_BASE_MS: u64 = 20;

/* ------------------------------------------------------------- write ordering */

/// One in-flight tmux write per pane, in the order the user asked for them.
///
/// Unique buffer names stop two pastes from swapping payloads, but they do not
/// order them: a paste followed by `send-keys Enter` must not have the Enter
/// overtake the text it submits. Reads (`meta`, `capture`, `sample`) stay off
/// this chain — they touch nothing, and they run several times a second.
///
/// Shape note: the TS chains promises, so a write takes its place in the queue
/// when the function is *called*. A Rust async fn does nothing until it is
/// polled, so a write takes its place when it is first polled — which for every
/// real caller (each write is driven by its own task) is the same order.
static WRITE_QUEUES: OnceLock<Mutex<HashMap<String, (u64, oneshot::Receiver<()>)>>> =
    OnceLock::new();
static QUEUE_SEQ: AtomicU64 = AtomicU64::new(0);

fn write_queues() -> &'static Mutex<HashMap<String, (u64, oneshot::Receiver<()>)>> {
    WRITE_QUEUES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A place in one pane's write queue. Held for the duration of the write; when
/// it is dropped — whether the write succeeded or failed — the next one runs.
/// A failed write must not poison the pane's queue for every later one.
struct Ticket {
    pane_id: String,
    seq: u64,
    prior: Option<oneshot::Receiver<()>>,
    _done: oneshot::Sender<()>,
}

impl Ticket {
    fn take(pane_id: &str) -> Ticket {
        let (done, rx) = oneshot::channel();
        let seq = QUEUE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
        let prior = write_queues()
            .lock()
            .unwrap()
            .insert(pane_id.to_string(), (seq, rx))
            .map(|(_, rx)| rx);
        Ticket { pane_id: pane_id.to_string(), seq, prior, _done: done }
    }

    async fn wait(&mut self) {
        if let Some(prior) = self.prior.take() {
            // `Err` means the previous writer was dropped without signalling,
            // which is exactly what a failed write does. Its turn is over
            // either way.
            let _ = prior.await;
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut queues = write_queues().lock().unwrap();
        if queues.get(&self.pane_id).map(|(seq, _)| *seq) == Some(self.seq) {
            queues.remove(&self.pane_id);
        }
    }
}

/* ------------------------------------------------------------------- staging */

/// `mkdtemp`, not a predictable name in the shared temp root.
///
/// The buffer names this would otherwise use are predictable — pid and a
/// counter — and the temp root is world-writable, so another local user could
/// pre-create a symlink at the path we are about to write and have the user's
/// prompt text land wherever they pointed it. A 0700 directory with a random
/// name is what closes that; the pid in the prefix is only so a later run can
/// tell its own leftovers from a live instance's.
const STAGE_PREFIX: &str = "agent-commander-paste-";

static STAGE_DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn stage_slot() -> &'static Mutex<Option<PathBuf>> {
    STAGE_DIR.get_or_init(|| Mutex::new(None))
}

fn staging_dir() -> std::io::Result<PathBuf> {
    let mut slot = stage_slot().lock().unwrap();
    if let Some(dir) = slot.as_ref() {
        if dir.is_dir() {
            return Ok(dir.clone());
        }
    }
    let dir = create_stage_dir(&std::env::temp_dir())?;
    *slot = Some(dir.clone());
    Ok(dir)
}

fn create_stage_dir(root: &Path) -> std::io::Result<PathBuf> {
    use rand::{distributions::Alphanumeric, Rng};
    use std::os::unix::fs::DirBuilderExt;
    let mut last = None;
    for _ in 0..8 {
        let suffix: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(8)
            .map(char::from)
            .collect();
        let dir = root.join(format!("{STAGE_PREFIX}{}-{suffix}", process::id()));
        // Not `create_dir_all`: a non-recursive create fails if the path
        // already exists, which is what makes claiming the name atomic.
        match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => return Ok(dir),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => last = Some(err),
            Err(err) => return Err(err),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("could not create a staging directory")))
}

/// Write a paste's text where tmux can read it, or return `None` to say it
/// could not be done — in which case nothing has been sent and the caller is
/// free to take the other path.
///
/// The text goes through a file rather than onto the command line because the
/// control client has no stdin to pipe it down — stdin *is* the command
/// channel. Putting it in the command instead would mean quoting arbitrary user
/// text for tmux's lexer, where a stray quote is not a rendering bug but a
/// command boundary. INV-2 says what reaches an agent is what was typed for it;
/// a file keeps that true without a quoting rule to get wrong.
async fn stage(buffer: &str, text: &str) -> Option<PathBuf> {
    let dir = staging_dir().ok()?;
    let file = dir.join(buffer);
    let as_str = file.to_str()?;
    // A quote or a backslash in the path would break out of the argument when
    // the command line is built. Nothing this app generates has one, but the
    // temp root belongs to the system, so it is checked rather than assumed.
    if as_str.contains('\'') || as_str.contains('\\') {
        return None;
    }
    use tokio::io::AsyncWriteExt;
    // 0600: this is the user's prompt text sitting in a shared temp root.
    let mut handle = {
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&file)
            .await
            .ok()?
    };
    handle.write_all(text.as_bytes()).await.ok()?;
    handle.flush().await.ok()?;
    Some(file)
}

/// Clean up the staging directory on shutdown. Best effort by design.
pub async fn cleanup() {
    let dir = stage_slot().lock().unwrap().take();
    if let Some(dir) = dir {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}

/// Remove staging directories left by runs that did not get to shut down.
///
/// [`cleanup`] runs on SIGINT and SIGTERM, which covers quitting the app. It
/// does not cover SIGKILL, a crash, or a reboot — and this directory is created
/// once per run, so without a sweep those leftovers accumulate in the temp root
/// for as long as the machine goes without clearing it. They are empty in the
/// ordinary case, because each paste unlinks its own file; a run killed
/// mid-paste can leave one 0600 file behind, which is the better reason to
/// clear them out rather than to leave them lying around.
///
/// Directories belonging to a live pid are left alone: a second
/// agent-commander on the same machine is a supported arrangement, and its
/// staging directory is none of this one's business.
pub async fn sweep_stale_staging(root: &Path) -> usize {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return 0;
    };
    let mut removed = 0usize;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix(STAGE_PREFIX) else { continue };
        // An unparseable pid means a directory from before this naming; it
        // cannot be attributed to a live process, so it is safe to drop.
        let pid = rest.split('-').next().unwrap_or("").parse::<i32>().ok();
        if let Some(pid) = pid {
            if pid > 0 && pid_alive(pid) {
                continue;
            }
        }
        let _ = tokio::fs::remove_dir_all(entry.path()).await;
        removed += 1;
    }
    removed
}

extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

fn pid_alive(pid: i32) -> bool {
    // Signal 0 asks the kernel whether it could deliver, without delivering.
    if unsafe { kill(pid, 0) } == 0 {
        return true;
    }
    // EPERM means it exists and belongs to someone else.
    std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied
}

/* --------------------------------------------------------------- the adapter */

/// The tmux-backed implementation of [`PaneApi`], with both of its paths.
pub struct Panes {
    control: Arc<dyn Control>,
    once: Arc<dyn OneShot>,
}

impl Panes {
    pub fn live() -> Panes {
        Panes {
            control: Arc::new(LiveControl(tmux_control())),
            once: Arc::new(LiveOneShot),
        }
    }

    /// For tests: two fakes standing in for the two ways of reaching tmux.
    pub fn with(control: Arc<dyn Control>, once: Arc<dyn OneShot>) -> Panes {
        Panes { control, once }
    }

    /// Spawn a one-shot tmux, retrying only a refusal that ran nothing.
    async fn run(&self, args: &[String], stdin: Option<&str>) -> Result<String, PaneError> {
        let mut attempt = 0usize;
        loop {
            match self.once.run_once(args, stdin).await {
                Ok(out) => return Ok(out),
                Err(err) => {
                    if !err.eagain || attempt >= SPAWN_RETRIES {
                        return Err(err);
                    }
                    tokio::time::sleep(Duration::from_millis(
                        SPAWN_RETRY_BASE_MS * (attempt as u64 + 1),
                    ))
                    .await;
                    attempt += 1;
                }
            }
        }
    }

    /// Run a read, through the control client when it is up.
    ///
    /// `args` is the spawn form; `commands` is the same sequence already
    /// spelled for control mode, one string per command. They are passed
    /// separately rather than derived from each other because the two have
    /// different quoting rules, and deriving one from the other is exactly the
    /// kind of cleverness that would put a `'` somewhere surprising. The slice
    /// is not cosmetic either: its length is how the client knows how many
    /// reply blocks the line will produce.
    ///
    /// A failed read is retried down the other path, because reading a pane
    /// twice costs a round trip and changes nothing. Writes must not do this.
    async fn exec_read(&self, args: &[String], commands: &[String]) -> Result<String, PaneError> {
        if self.control.ready() {
            match self.control.run(commands).await {
                Ok(out) => return Ok(out),
                // The client died, timed out, or tmux refused. It restarts
                // itself; this call still has a user waiting on it, so it is
                // tried the old way rather than failed.
                Err(_) => return self.run(args, None).await,
            }
        }
        self.run(args, None).await
    }

    /// Run a write, through the control client when it is up — and only once.
    ///
    /// The difference from [`Panes::exec_read`] is the entire point of this
    /// function. A write that fails *after* it reached tmux has an unknown
    /// outcome: a sequence of `load-buffer ; paste-buffer ; send-keys` that
    /// reports an error at the last step has already put the text into the
    /// pane, and a client that timed out may well have delivered everything.
    /// Retrying that down the spawn path would type the user's text into a live
    /// agent a second time — which is exactly what INV-2 forbids: re-sending is
    /// the user's decision, not the app's.
    ///
    /// So the path is chosen *before* anything is sent, and a failure after
    /// that is reported rather than retried. The one retry that remains is
    /// inside [`Panes::run`], for `EAGAIN`, and it is safe for the same reason
    /// it is needed: the process never started, so nothing was written.
    async fn exec_write(&self, args: &[String], commands: &[String]) -> Result<String, PaneError> {
        if self.control.ready() {
            return self.control.run(commands).await;
        }
        self.run(args, None).await
    }

    /// Read the pane's geometry and cursor without touching it.
    pub async fn read_meta(&self, pane_id: &str) -> Result<PaneMeta, PaneError> {
        assert_pane(pane_id)?;
        let out = self
            .exec_read(&meta_args(pane_id), &[meta_cmd(pane_id)])
            .await?;
        parse_meta(out.split('\n').next().unwrap_or(""))
    }

    /// Capture the pane's visible content with ANSI escapes preserved.
    /// Returns exactly `rows` lines: tmux trims trailing blanks, so we pad.
    pub async fn capture(&self, pane_id: &str, rows: usize) -> Result<Vec<String>, PaneError> {
        assert_pane(pane_id)?;
        let out = self
            .exec_read(&capture_args(pane_id), &[capture_cmd(pane_id)])
            .await?;
        Ok(pad_capture(split_lines(&out), rows))
    }

    /// Geometry and content in a single round trip.
    ///
    /// This is what the Attach view actually polls. As two calls it cost p50
    /// 141ms against a 140ms frame budget — the poll could not keep up with its
    /// own timer, and every missed tick was a frame the user did not see. As
    /// one call it is p50 69ms spawned and roughly 20ms through the control
    /// client.
    pub async fn read_sample(&self, pane_id: &str) -> Result<PaneSample, PaneError> {
        assert_pane(pane_id)?;
        let out = self
            .exec_read(&sample_args(pane_id), &sample_cmds(pane_id))
            .await?;
        let mut lines = split_lines(&out);
        let head = if lines.is_empty() { String::new() } else { lines.remove(0) };
        let meta = parse_meta(&head)?;
        Ok(PaneSample { meta, lines: pad_capture(lines, meta.rows) })
    }

    /// Send text to the pane as a bracketed paste, so multi-line input and
    /// shell-special characters arrive intact rather than being re-interpreted
    /// as keypresses. `submit` presses Enter afterwards, in the same command
    /// sequence.
    pub async fn paste(&self, pane_id: &str, text: &str, submit: bool) -> Result<(), PaneError> {
        assert_pane(pane_id)?;
        if text.is_empty() && !submit {
            return Ok(());
        }
        let mut ticket = Ticket::take(pane_id);
        ticket.wait().await;

        if text.is_empty() {
            self.exec_write(&key_args(pane_id, "Enter"), &[key_cmd(pane_id, "Enter")])
                .await?;
            return Ok(());
        }

        let buffer = buffer_name();

        // Staging happens first and completely, so the choice between the two
        // paths is made before a single byte reaches tmux. Anything that goes
        // wrong here — no temp dir, a full disk, a temp root with a quote in
        // its name — has written nothing, so taking the spawn path instead
        // carries none of the double-delivery risk `exec_write` exists to
        // avoid.
        let file = if self.control.ready() { stage(&buffer, text).await } else { None };

        if let Some(file) = file {
            let cmds = paste_cmds(&buffer, &file.to_string_lossy(), pane_id, submit);
            let result = self.control.run(&cmds).await;
            let _ = tokio::fs::remove_file(&file).await;
            return match result {
                Ok(_) => Ok(()),
                Err(err) => {
                    // The buffer may have been loaded before the sequence
                    // stopped, and these names are per-paste, so it would sit
                    // in the tmux server for as long as it runs. Deleting a
                    // buffer cannot deliver anything to an agent, so unlike the
                    // paste itself this is safe to issue blindly.
                    let _ = self.control.run(&[format!("delete-buffer -b {buffer}")]).await;
                    // The paste itself is issued, outcome unknown, and
                    // therefore not retried. See `exec_write`.
                    Err(err)
                }
            };
        }

        match self.run(&paste_args(&buffer, pane_id, submit), Some(text)).await {
            Ok(_) => Ok(()),
            Err(err) => {
                // A sequence that failed part-way can leave its buffer behind,
                // and these are per-call, so they would accumulate for the life
                // of the tmux server rather than being overwritten by the next
                // paste.
                let _ = self.run(&strs(&["delete-buffer", "-b", &buffer]), None).await;
                Err(err)
            }
        }
    }

    /// Send a single control key. The caller must have validated it against
    /// `ALLOWED_KEYS`.
    pub async fn key(&self, pane_id: &str, key_name: &str) -> Result<(), PaneError> {
        assert_pane(pane_id)?;
        // Same queue as paste: an Enter must not overtake the text it submits.
        let mut ticket = Ticket::take(pane_id);
        ticket.wait().await;
        self.exec_write(&key_args(pane_id, key_name), &[key_cmd(pane_id, key_name)])
            .await?;
        Ok(())
    }

    /// End a whole tmux session. Used only as the forced fallback when an agent
    /// has ignored `/exit`; this creates no client, so INV-1 is unaffected.
    pub async fn kill_session(&self, session: &str) -> Result<(), PaneError> {
        if session.is_empty()
            || !session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
        {
            return Err(PaneError::msg(format!(
                "refusing to use malformed session name: {session}"
            )));
        }
        self.run(&strs(&["kill-session", "-t", session]), None).await?;
        Ok(())
    }

    /// True when a tmux server is reachable at all.
    pub async fn available(&self) -> bool {
        self.run(&strs(&["display-message", "-p", "ok"]), None).await.is_ok()
    }

    /// Diagnostic snapshot used by the INV-1 regression test.
    ///
    /// `client_flags` is in there deliberately: the control client is allowed
    /// to exist only because of what it is, so a change that turned it into an
    /// ordinary client has to show up as a difference rather than as a quiet
    /// resize.
    pub async fn client_snapshot(&self) -> String {
        let clients = self
            .run(
                &strs(&[
                    "list-clients",
                    "-F",
                    "#{client_name} #{client_width}x#{client_height} #{client_session} #{client_flags}",
                ]),
                None,
            )
            .await
            .unwrap_or_default();
        let panes = self
            .run(
                &strs(&["list-panes", "-a", "-F", "#{pane_id} #{pane_width}x#{pane_height}"]),
                None,
            )
            .await
            .unwrap_or_default();
        format!("{clients}\n---\n{panes}")
    }
}

#[async_trait]
impl PaneApi for Panes {
    async fn meta(&self, pane_id: &str) -> anyhow::Result<PaneMeta> {
        Ok(self.read_meta(pane_id).await?)
    }

    async fn capture(&self, pane_id: &str, rows: usize) -> anyhow::Result<Vec<String>> {
        Ok(Panes::capture(self, pane_id, rows).await?)
    }

    async fn sample(&self, pane_id: &str) -> anyhow::Result<PaneSample> {
        Ok(self.read_sample(pane_id).await?)
    }

    async fn paste(&self, pane_id: &str, text: &str, submit: bool) -> anyhow::Result<()> {
        Ok(Panes::paste(self, pane_id, text, submit).await?)
    }

    async fn key(&self, pane_id: &str, key_name: &str) -> anyhow::Result<()> {
        Ok(Panes::key(self, pane_id, key_name).await?)
    }
}

/// The public handle other modules construct.
pub struct TmuxPanes;

impl TmuxPanes {
    pub fn new() -> Arc<dyn PaneApi> {
        Arc::new(Panes::live())
    }
}

/// The process-wide adapter, for the calls that are not on the `PaneApi` trait.
pub fn live_panes() -> &'static Panes {
    static PANES: OnceLock<Panes> = OnceLock::new();
    PANES.get_or_init(Panes::live)
}

/// One pane's geometry, for callers that are not holding a `PaneApi`.
pub async fn meta(pane_id: &str) -> Result<PaneMeta, PaneError> {
    live_panes().read_meta(pane_id).await
}

pub async fn kill_session(session: &str) -> Result<(), PaneError> {
    live_panes().kill_session(session).await
}

pub async fn available() -> bool {
    live_panes().available().await
}

pub async fn client_snapshot() -> String {
    live_panes().client_snapshot().await
}

/* --------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    //! INV-2, on the way out: the text that reaches an agent is the text that
    //! was typed for it — once, to that agent, in the order it was typed.
    //!
    //! tmux is faked here rather than driven: INV-1 forbids this suite from
    //! creating a session, and the properties under test are about ordering and
    //! about which of the two paths a call takes, both of which a recorded argv
    //! shows exactly.

    use super::*;
    use std::sync::atomic::AtomicBool;

    /* ------------------------------------------------------ pure pieces */

    #[test]
    fn only_real_pane_ids_reach_argv() {
        for good in ["%0", "%77", "%1234"] {
            assert!(is_pane_id(good), "{good}");
        }
        for bad in ["", "%", "77", "%7a", "%-1", "%77;kill-server", "$1", "%77 "] {
            assert!(!is_pane_id(bad), "{bad}");
        }
        let err = assert_pane("%; kill-server").unwrap_err();
        assert!(err.message.contains("malformed pane id"), "{err}");
    }

    #[tokio::test]
    async fn session_names_are_checked_before_kill_session() {
        // The same rule as the pane id, for the one command that ends a whole
        // session. A shell metacharacter here would be a command boundary.
        let (_c, once, panes) = rig();
        let err = panes.kill_session("work; rm -rf /").await.unwrap_err();
        assert!(err.message.contains("malformed session name"), "{err}");
        assert!(once.calls().is_empty());
    }

    #[test]
    fn every_paste_gets_a_buffer_of_its_own() {
        // With one shared name, two overlapping pastes interleaved as load(A)
        // -> load(B) -> paste(into A) and put B's text into A's agent.
        let names: Vec<String> = (0..4).map(|_| buffer_name()).collect();
        let unique: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(unique.len(), 4);
        // The pid is in the name because a second agent-commander on the same
        // machine shares the tmux server, and so its buffer namespace.
        for name in &names {
            assert!(name.starts_with(&format!("{BUFFER_PREFIX}-{}-", process::id())), "{name}");
        }
    }

    #[test]
    fn parses_all_six_fields_of_one_display_message() {
        let m = parse_meta("150|47|2|21|1|0").unwrap();
        assert_eq!(
            (m.cols, m.rows, m.cursor_x, m.cursor_y, m.alternate, m.dead),
            (150, 47, 2, 21, true, false)
        );
        // `dead` is load-bearing: a dead pane's last capture is a memory, not a
        // reading, and `control` refuses to act on one.
        assert!(parse_meta("80|24|0|0|0|1").unwrap().dead);
        assert!(parse_meta("80|24|0|0|0|0").is_ok());
        assert!(parse_meta("80|24|0").is_err());
        // A field tmux could not resolve reads as zero rather than failing the
        // whole frame.
        assert_eq!(parse_meta("|24|0|0|0|0").unwrap().cols, 0);
    }

    #[test]
    fn pads_a_capture_back_out_to_the_pane_height() {
        // tmux trims trailing blank lines; a short capture drawn as-is would
        // leave the previous frame's rows on screen underneath it.
        assert_eq!(pad_capture(vec!["a".into()], 3), vec!["a", "", ""]);
        assert_eq!(pad_capture(vec!["a".into(), "b".into(), "c".into()], 2), vec!["a", "b"]);
    }

    #[test]
    fn a_trailing_newline_is_not_a_phantom_row() {
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\nb"), vec!["a", "b"]);
        assert_eq!(split_lines(""), vec![""]);
    }

    #[test]
    fn the_format_string_is_single_quoted_for_control_mode() {
        // Double quotes would have tmux expand `#{pane_width}` first, against
        // whichever pane the control client considers current — which is never
        // the pane being asked about, so the terminal would have been sized
        // from another agent's window.
        let cmd = meta_cmd("%77");
        assert_eq!(cmd, format!("display-message -p -t %77 '{META_FORMAT}'"));
        assert!(!cmd.contains('"'));
        // The spawn form takes the same string as one argv entry, unquoted.
        assert_eq!(meta_args("%77").last().unwrap(), META_FORMAT);
    }

    #[test]
    fn a_sample_is_one_round_trip_of_two_commands() {
        // Two calls cost p50 141ms against a 140ms frame budget; one costs ~20ms
        // through the control client. Splitting this back up is the regression.
        let cmds = sample_cmds("%1");
        assert_eq!(cmds.len(), 2);
        assert!(cmds[0].starts_with("display-message"));
        assert!(cmds[1].starts_with("capture-pane"));
        let args = sample_args("%1");
        assert_eq!(args.iter().filter(|a| *a == ";").count(), 1);
        assert_eq!(args[0], "display-message");
        assert!(args.contains(&"capture-pane".to_string()));
    }

    #[test]
    fn a_paste_is_one_sequence_of_load_paste_and_maybe_submit() {
        let cmds = paste_cmds("buf1", "/tmp/x/buf1", "%9", true);
        assert_eq!(
            cmds,
            vec![
                "load-buffer -b buf1 '/tmp/x/buf1'",
                "paste-buffer -b buf1 -t %9 -p -d",
                "send-keys -t %9 Enter",
            ]
        );
        assert_eq!(paste_cmds("buf1", "/tmp/x/buf1", "%9", false).len(), 2);

        let args = paste_args("buf1", "%9", true);
        assert_eq!(args.iter().filter(|a| *a == ";").count(), 2);
        // `-` is stdin: the spawn path is the only one that can pipe the text.
        assert_eq!(args[3], "-");
        assert!(args.contains(&"-p".to_string()) && args.contains(&"-d".to_string()));
    }

    #[test]
    fn tells_no_process_slots_apart_from_no_such_pane() {
        use std::io::{Error, ErrorKind};
        assert!(is_eagain(&Error::from(ErrorKind::WouldBlock)));
        assert!(is_eagain(&Error::from_raw_os_error(35)));
        assert!(is_eagain(&Error::from_raw_os_error(11)));
        // Retrying anything else would type into a live agent twice.
        assert!(!is_eagain(&Error::from(ErrorKind::NotFound)));
        assert!(!is_eagain(&Error::other("no such pane")));
    }

    /* --------------------------------------------------------- the fakes */

    #[derive(Default)]
    struct FakeControl {
        up: AtomicBool,
        calls: Mutex<Vec<Vec<String>>>,
        fail: Mutex<Option<String>>,
        reply: Mutex<Option<String>>,
    }

    impl FakeControl {
        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
        fn flat(&self) -> Vec<String> {
            self.calls().into_iter().flatten().collect()
        }
    }

    #[async_trait]
    impl Control for Arc<FakeControl> {
        fn ready(&self) -> bool {
            self.up.load(Ordering::Relaxed)
        }
        async fn run(&self, commands: &[String]) -> Result<String, PaneError> {
            self.calls.lock().unwrap().push(commands.to_vec());
            match self.fail.lock().unwrap().clone() {
                Some(msg) => Err(PaneError::msg(msg)),
                None => Ok(self
                    .reply
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| "80|24|0|0|0|0".to_string())),
            }
        }
    }

    #[derive(Clone, Debug)]
    struct Call {
        args: Vec<String>,
        stdin: Option<String>,
    }

    #[derive(Default)]
    struct FakeOnce {
        calls: Mutex<Vec<Call>>,
        /// An invocation whose argv contains any of these fails the way tmux
        /// refusing a target does.
        fail: Mutex<Vec<String>>,
        /// argv[0] -> how many spawns to refuse for want of a process slot
        /// before letting one through. A refused spawn ran nothing.
        eagain: Mutex<HashMap<String, usize>>,
        /// argv[0] -> latency, so an interleaving is forced rather than hoped for.
        delay: Mutex<HashMap<String, u64>>,
        reply: Mutex<Option<String>>,
    }

    impl FakeOnce {
        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
        /// The individual tmux commands an invocation carried: one invocation
        /// is a command *sequence* joined by `;`, so looking only at argv[0]
        /// would report a paste-buffer that is plainly there as missing.
        fn commands_in(args: &[String]) -> Vec<Vec<String>> {
            let mut out: Vec<Vec<String>> = vec![Vec::new()];
            for arg in args {
                if arg == ";" {
                    out.push(Vec::new());
                } else {
                    out.last_mut().unwrap().push(arg.clone());
                }
            }
            out.into_iter().filter(|c| !c.is_empty()).collect()
        }
        /// Every tmux command run, across every invocation, in order.
        fn all_commands(&self) -> Vec<Vec<String>> {
            self.calls().iter().flat_map(|c| Self::commands_in(&c.args)).collect()
        }
        /// The text each pane actually received, in the order it received it.
        fn delivered_to(&self, pane_id: &str) -> Vec<String> {
            let mut loaded: HashMap<String, String> = HashMap::new();
            for call in self.calls() {
                for cmd in Self::commands_in(&call.args) {
                    if cmd[0] == "load-buffer" {
                        loaded.insert(cmd[2].clone(), call.stdin.clone().unwrap_or_default());
                    }
                }
            }
            self.all_commands()
                .into_iter()
                .filter(|cmd| cmd[0] == "paste-buffer" && cmd.contains(&pane_id.to_string()))
                .map(|cmd| {
                    let i = cmd.iter().position(|a| a == "-b").unwrap() + 1;
                    loaded.get(&cmd[i]).cloned().unwrap_or_else(|| "<unknown buffer>".into())
                })
                .collect()
        }
    }

    #[async_trait]
    impl OneShot for Arc<FakeOnce> {
        async fn run_once(&self, args: &[String], stdin: Option<&str>) -> Result<String, PaneError> {
            let head = args[0].clone();
            {
                let mut eagain = self.eagain.lock().unwrap();
                if let Some(left) = eagain.get_mut(&head) {
                    if *left > 0 {
                        *left -= 1;
                        // Not recorded: a spawn refused for want of a process
                        // slot never started tmux, so it ran no commands.
                        // Recording it would credit the retry with delivering
                        // the text twice.
                        return Err(PaneError::eagain("spawn tmux EAGAIN"));
                    }
                }
            }
            self.calls.lock().unwrap().push(Call {
                args: args.to_vec(),
                stdin: stdin.map(str::to_string),
            });
            let delay = self.delay.lock().unwrap().get(&head).copied();
            if let Some(ms) = delay {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            let fail = self.fail.lock().unwrap().clone();
            if fail.iter().any(|token| args.contains(token)) {
                return Err(PaneError::msg("no such pane"));
            }
            Ok(self.reply.lock().unwrap().clone().unwrap_or_else(|| "80|24|0|0|0|0\n".into()))
        }
    }

    fn rig() -> (Arc<FakeControl>, Arc<FakeOnce>, Panes) {
        let control = Arc::new(FakeControl::default());
        let once = Arc::new(FakeOnce::default());
        let panes = Panes::with(Arc::new(control.clone()), Arc::new(once.clone()));
        (control, once, panes)
    }

    /* ------------------------------------------- one round trip per write */

    /// The reason the batching exists: `display-message -p ok` measured p50
    /// 72.8ms against a bare fork+exec at 3.0ms, so what a write costs is how
    /// many times it reaches tmux, not what it asks for.
    #[tokio::test]
    async fn loads_and_pastes_a_buffer_in_a_single_invocation() {
        let (_c, once, panes) = rig();
        panes.paste("%76", "hello", false).await.unwrap();
        assert_eq!(once.calls().len(), 1);
        assert_eq!(
            FakeOnce::commands_in(&once.calls()[0].args)
                .iter()
                .map(|c| c[0].clone())
                .collect::<Vec<_>>(),
            vec!["load-buffer", "paste-buffer"]
        );
    }

    #[tokio::test]
    async fn submits_in_that_same_invocation_rather_than_a_second_one() {
        let (_c, once, panes) = rig();
        panes.paste("%76", "hello", true).await.unwrap();
        assert_eq!(once.calls().len(), 1);
        assert_eq!(
            FakeOnce::commands_in(&once.calls()[0].args)
                .iter()
                .map(|c| c[0].clone())
                .collect::<Vec<_>>(),
            vec!["load-buffer", "paste-buffer", "send-keys"]
        );
    }

    #[tokio::test]
    async fn never_delivers_one_agent_the_text_meant_for_another() {
        let (_c, once, panes) = rig();
        // Latency on the load, so the two sequences genuinely overlap — exactly
        // the window in which a single shared buffer name was overwritten
        // before its paste.
        once.delay.lock().unwrap().insert("load-buffer".into(), 20);
        let panes = Arc::new(panes);
        let a = tokio::spawn({
            let panes = panes.clone();
            async move { panes.paste("%76", "deploy to staging", true).await }
        });
        let b = tokio::spawn({
            let panes = panes.clone();
            async move { panes.paste("%77", "rm -rf the wrong thing", true).await }
        });
        a.await.unwrap().unwrap();
        b.await.unwrap().unwrap();
        assert_eq!(once.delivered_to("%76"), vec!["deploy to staging"]);
        assert_eq!(once.delivered_to("%77"), vec!["rm -rf the wrong thing"]);
        let names: Vec<String> = once
            .all_commands()
            .into_iter()
            .filter(|c| c[0] == "load-buffer")
            .map(|c| c[2].clone())
            .collect();
        assert_eq!(names.iter().collect::<std::collections::HashSet<_>>().len(), 2);
    }

    #[tokio::test]
    async fn deletes_a_buffer_whose_paste_failed_rather_than_leaking_it() {
        // Per-call buffer names are not overwritten by the next paste the way
        // one shared name was, so a load whose paste never happened would sit
        // in the tmux server for as long as it runs.
        let (_c, once, panes) = rig();
        once.fail.lock().unwrap().push("paste-buffer".into());
        let err = panes.paste("%76", "text", false).await.unwrap_err();
        assert!(err.message.contains("no such pane"), "{err}");
        let loaded = once.all_commands().into_iter().find(|c| c[0] == "load-buffer").unwrap()[2].clone();
        let deleted = once.all_commands().into_iter().find(|c| c[0] == "delete-buffer").unwrap()[2].clone();
        assert_eq!(deleted, loaded);
    }

    /// `sendText` then `sendKey('Enter')` are two messages, and an Enter that
    /// overtakes its text submits an empty prompt and then leaves the text
    /// sitting unsent in the composer.
    #[tokio::test]
    async fn does_not_let_enter_overtake_the_text_it_submits() {
        let (_c, once, panes) = rig();
        once.delay.lock().unwrap().insert("load-buffer".into(), 20);
        // `join!` polls in argument order, which is the order the two writes
        // take their place in the pane's queue.
        let (a, b) = tokio::join!(panes.paste("%76", "the instruction", false), panes.key("%76", "Enter"));
        a.unwrap();
        b.unwrap();
        let order: Vec<String> = once
            .all_commands()
            .into_iter()
            .filter(|c| c.contains(&"%76".to_string()))
            .map(|c| c[0].clone())
            .collect();
        assert_eq!(order, vec!["paste-buffer", "send-keys"]);
    }

    #[tokio::test]
    async fn lets_the_next_write_run_after_one_fails() {
        // A rejected write must not poison the pane's queue for everything
        // behind it.
        let (_c, once, panes) = rig();
        once.fail.lock().unwrap().push("send-keys".into());
        let (failed, after) = tokio::join!(panes.key("%78", "Enter"), panes.paste("%78", "still works", false));
        assert!(failed.is_err());
        assert!(after.is_ok());
        assert_eq!(once.delivered_to("%78"), vec!["still works"]);
    }

    /* ------------------------------------- a machine out of process slots */

    /// Not hypothetical: measured on a machine sitting at 2840 processes
    /// against a `kern.maxprocperuid` of 2666 — 109 tmux panes and 33 Claude
    /// sessions will do it — spawning tmux returned EAGAIN twice during one
    /// benchmark run. Before the retry, that dropped the character the user had
    /// just typed and reported it as a toast, which is the one thing INV-2
    /// cares about.
    #[tokio::test]
    async fn retries_a_spawn_refused_for_want_of_a_process_slot() {
        let (_c, once, panes) = rig();
        once.eagain.lock().unwrap().insert("load-buffer".into(), 1);
        panes.paste("%76", "not lost", false).await.unwrap();
        assert_eq!(once.delivered_to("%76"), vec!["not lost"]);
    }

    #[tokio::test]
    async fn gives_up_rather_than_retrying_for_ever() {
        let (_c, once, panes) = rig();
        once.eagain.lock().unwrap().insert("load-buffer".into(), 99);
        let err = panes.paste("%76", "doomed", false).await.unwrap_err();
        assert!(err.eagain, "{err}");
        assert!(once.delivered_to("%76").is_empty());
    }

    #[tokio::test]
    async fn does_not_retry_a_refusal_that_is_not_about_process_slots() {
        let (_c, once, panes) = rig();
        once.fail.lock().unwrap().push("load-buffer".into());
        assert!(panes.paste("%76", "text", false).await.is_err());
        // One attempt, plus the delete-buffer cleanup. A pane that does not
        // exist will not start existing because it was asked again.
        assert_eq!(once.all_commands().into_iter().filter(|c| c[0] == "load-buffer").count(), 1);
    }

    /* --------------------------------------- which of the two paths runs */

    #[tokio::test]
    async fn a_write_that_fails_after_reaching_tmux_is_not_retried_down_the_other_path() {
        let (control, once, panes) = rig();
        control.up.store(true, Ordering::Relaxed);
        *control.fail.lock().unwrap() = Some("can't find pane: %76".into());
        let err = panes.paste("%76", "deploy to production", true).await.unwrap_err();
        assert!(err.message.contains("can't find pane"), "{err}");
        // The one thing that must not appear here is a second delivery of the
        // same text. A `paste-buffer` reached tmux; whether it landed is
        // unknowable from here, and guessing wrong types into a live agent
        // twice.
        assert!(once.calls().is_empty(), "{:?}", once.calls());
        // It still tidies up the buffer it may have left behind: deleting a
        // buffer cannot deliver anything to an agent.
        assert!(control.flat().iter().any(|c| c.starts_with("delete-buffer")));
    }

    #[tokio::test]
    async fn does_not_retry_a_key_either() {
        let (control, once, panes) = rig();
        control.up.store(true, Ordering::Relaxed);
        *control.fail.lock().unwrap() = Some("gone".into());
        assert!(panes.key("%76", "Enter").await.is_err());
        assert!(once.calls().is_empty());
    }

    #[tokio::test]
    async fn a_write_with_no_client_up_goes_down_the_spawn_path() {
        let (control, once, panes) = rig();
        panes.paste("%76", "hello", true).await.unwrap();
        assert!(control.calls().is_empty());
        assert!(once.all_commands().iter().any(|c| c[0] == "load-buffer"));
    }

    #[tokio::test]
    async fn a_read_that_fails_is_retried_down_the_other_path() {
        // The user is waiting on this frame. Reading the pane again costs a
        // round trip and nothing else, so the fallback is free here in a way it
        // is not for a write.
        let (control, once, panes) = rig();
        control.up.store(true, Ordering::Relaxed);
        *control.fail.lock().unwrap() = Some("control client exited".into());
        let sample = panes.read_sample("%76").await.unwrap();
        assert_eq!(sample.meta.cols, 80);
        assert!(!once.calls().is_empty());
    }

    #[tokio::test]
    async fn reports_a_failure_when_neither_path_works() {
        let (control, once, panes) = rig();
        control.up.store(true, Ordering::Relaxed);
        *control.fail.lock().unwrap() = Some("control client exited".into());
        once.fail.lock().unwrap().push("display-message".into());
        assert!(panes.read_sample("%76").await.is_err());
    }

    #[tokio::test]
    async fn never_spells_the_users_text_on_a_tmux_command_line() {
        let (control, _once, panes) = rig();
        control.up.store(true, Ordering::Relaxed);
        *control.reply.lock().unwrap() = Some(String::new());
        panes.paste("%76", "rm -rf ' ; kill-server ; #{q:x}", true).await.unwrap();
        let line = control.flat().join(" ");
        // The text travels through a 0600 file precisely so tmux's own argument
        // lexer never sees it — there is no quoting rule left to get wrong.
        assert!(!line.contains("kill-server"), "{line}");
        assert!(!line.contains("rm -rf"), "{line}");
        assert!(
            line.contains(&format!("load-buffer -b {BUFFER_PREFIX}-{}-", process::id())),
            "{line}"
        );
        assert!(line.contains(" '/"), "the staged path is single-quoted: {line}");
    }

    #[tokio::test]
    async fn sends_the_load_the_paste_and_the_submit_as_one_sequence() {
        let (control, _once, panes) = rig();
        control.up.store(true, Ordering::Relaxed);
        *control.reply.lock().unwrap() = Some(String::new());
        panes.paste("%76", "go", true).await.unwrap();
        assert_eq!(control.calls().len(), 1);
        assert_eq!(
            control.calls()[0]
                .iter()
                .map(|c| c.split(' ').next().unwrap().to_string())
                .collect::<Vec<_>>(),
            vec!["load-buffer", "paste-buffer", "send-keys"]
        );
    }

    #[tokio::test]
    async fn a_sample_pads_its_capture_from_the_geometry_it_asked_for() {
        let (control, _once, panes) = rig();
        control.up.store(true, Ordering::Relaxed);
        *control.reply.lock().unwrap() = Some("80|4|1|2|0|0\nrow one\nrow two".into());
        let sample = panes.read_sample("%1").await.unwrap();
        assert_eq!(sample.meta.rows, 4);
        assert_eq!(sample.meta.cursor_x, 1);
        assert_eq!(sample.lines, vec!["row one", "row two", "", ""]);
    }

    /* ----------------------------------------------------- staging on disk */

    #[test]
    fn a_staging_directory_is_unguessable_and_private() {
        // The temp root is world-writable and buffer names are predictable, so
        // another local user could pre-create a symlink where the prompt text
        // is about to be written. A 0700 directory with a random name closes
        // that; the pid is only so a later run can tell its own leftovers from
        // a live instance's.
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("ac-stage-test-{}", process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let a = create_stage_dir(&root).unwrap();
        let b = create_stage_dir(&root).unwrap();
        assert_ne!(a, b);
        let name = a.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with(&format!("{STAGE_PREFIX}{}-", process::id())), "{name}");
        let mode = std::fs::metadata(&a).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{mode:o}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn sweeps_directories_from_runs_that_are_gone_and_spares_live_ones() {
        let root = std::env::temp_dir().join(format!("ac-sweep-test-{}", process::id()));
        let _ = tokio::fs::remove_dir_all(&root).await;
        tokio::fs::create_dir_all(&root).await.unwrap();
        let dead = root.join(format!("{STAGE_PREFIX}999999-aaaaaa"));
        let mine = root.join(format!("{STAGE_PREFIX}{}-bbbbbb", process::id()));
        let alien = root.join("something-else-entirely");
        for dir in [&dead, &mine, &alien] {
            tokio::fs::create_dir(dir).await.unwrap();
        }
        // A run killed mid-paste leaves the user's text behind; that is exactly
        // what should not survive.
        tokio::fs::write(dead.join("buf"), "a prompt nobody should find later").await.unwrap();

        assert_eq!(sweep_stale_staging(&root).await, 1);
        let mut left: Vec<String> = Vec::new();
        let mut entries = tokio::fs::read_dir(&root).await.unwrap();
        while let Some(e) = entries.next_entry().await.unwrap() {
            left.push(e.file_name().to_string_lossy().to_string());
        }
        left.sort();
        assert_eq!(
            left,
            vec![
                format!("{STAGE_PREFIX}{}-bbbbbb", process::id()),
                "something-else-entirely".to_string()
            ]
        );
        tokio::fs::remove_dir_all(&root).await.unwrap();
    }

    #[tokio::test]
    async fn says_nothing_and_does_nothing_when_the_temp_root_cannot_be_read() {
        assert_eq!(sweep_stale_staging(Path::new("/definitely/not/a/directory")).await, 0);
    }

    #[test]
    fn a_live_pid_is_recognised_as_live() {
        assert!(pid_alive(process::id() as i32));
        assert!(!pid_alive(999_999));
    }
}
