//! One long-lived tmux control-mode client, shared by every pane read and write.
//!
//! Why this exists: every `tmux <command>` starts a *new* tmux client process,
//! and that handshake — not the fork, and not the amount of data moved — is
//! what the Attach view spends its time on. Measured against a tmux server
//! running 109 panes:
//!
//! ```text
//! /bin/echo (bare fork+exec)          p50   3.0 ms
//! tmux display-message -p ok          p50  72.8 ms   <- no work at all
//! tmux capture-pane (274 B result)    p50  36.9 ms
//! ```
//!
//! The work is not the cost; the client is. A control-mode client is spawned
//! once and then answers commands over a pipe, which brings the same commands
//! to p50 7-24 ms and — just as importantly — stops forking altogether. That
//! second part is not a nicety: at 2840 processes against a `kern.maxprocperuid`
//! of 2666, spawning tmux returns `EAGAIN`, and a single transient `EAGAIN` used
//! to stop the terminal for good (see the frame-failure counting in `routes`).
//!
//! INV-1: this *is* a tmux client, which INV-1 flatly forbade before. What
//! makes it safe is **control mode**, not any flag. Measured on a fresh server
//! with `window-size latest`, a regular client attaching at 80x24 to a 200x50
//! window shrinks it to 80x21 — with `-f ignore-size`, with `-r`, with
//! `-f read-only,ignore-size`, and with no flags at all, identically. The flag
//! describes how a client affects *other* clients; it does not stop the window
//! following the client that is attached.
//!
//! A control-mode client has no size to impose: tmux reports its
//! `client_height` as empty, and it acquires one only by asking, with
//! `refresh-client -C`. **This file never sends that**, and neither does
//! `pane`, which is the guarantee — by construction, not by configuration.
//! `ignore-size` is kept below as defence in depth and is not load-bearing.
//! SPEC.md INV-1 records the amendment; `verify-inv1` proves it against a live
//! server rather than by assertion.
//!
//! Nothing here is required. Every caller falls back to spawning a one-shot
//! tmux client when [`TmuxControl::ready`] is false, so a tmux too old for
//! control mode, a machine with no session to attach to, or a client that dies
//! mid-run costs latency and nothing else.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

/// The flags that make attaching safe, and one that makes it durable.
///
/// `ignore-size` is defence in depth (see the module note: control mode is the
/// actual INV-1 guarantee). `no-output` declines the pane-output firehose we
/// would otherwise be sent for every pane on the server — this client asks
/// questions, it does not want a stream. `no-detach-on-destroy` keeps it alive
/// when the session it happened to attach to is killed, which for this app is
/// routine: sessions here *are* agents, and closing one is a button in the UI.
const ATTACH_FLAGS: &str = "ignore-size,no-output,no-detach-on-destroy";

/// How long a single command may take before it is treated as lost.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// How commands are joined into one line. tmux reads this as a sequence.
const SEPARATOR: &str = " ; ";

/// How long the handshake probe may take before control mode is written off.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

const RESTART_BASE_MS: u64 = 1_000;
const RESTART_MAX_MS: u64 = 30_000;

/// How long `list-sessions` may take before the server is written off.
///
/// It is asked once per client start and answers in single-digit milliseconds
/// on a healthy server; a wait this long means something is wrong with tmux
/// itself, and there is nothing to attach to until it recovers.
const LIST_SESSIONS_TIMEOUT: Duration = Duration::from_secs(5);

/// How long to ignore tmux's own startup chatter before probing.
const DEFAULT_SETTLE_MS: u64 = 150;

/// Read size for the client's stdout.
///
/// A whole 47-row capture arrives in one or two reads at this size, and the
/// chunker below stitches whatever the pipe does split.
const STDOUT_CHUNK_BYTES: usize = 16 * 1024;

/// Read size for the stderr sink. Nothing is kept, so this only has to be big
/// enough that draining a pipe is not a syscall per byte.
const STDERR_SINK_BYTES: usize = 4096;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct TmuxControlError(pub String);

impl TmuxControlError {
    fn new(msg: impl Into<String>) -> Self {
        TmuxControlError(msg.into())
    }
}

/* ------------------------------------------------------------------ framing */

/// One complete reply block, as tmux framed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    Output(String),
    Error(String),
}

/// The line framing of tmux control mode, on its own so it can be tested.
///
/// Every reply is bracketed by `%begin <ts> <num>` and `%end <ts> <num>`, and
/// tmux does *not* escape the command output in between. A captured pane can
/// therefore contain a line that looks exactly like a terminator —
/// `capture-pane` on a terminal showing this very protocol is the obvious way
/// to produce one — so the closing line is matched against the exact id the
/// block was opened with rather than against `%end` alone. This is what
/// iTerm2's tmux integration does, and it is why the id is carried at all.
///
/// Shape note: the TS version takes an `onBlock` callback. Here `push` returns
/// the blocks it completed. Rust would need the callback to be a boxed `FnMut`
/// owned by the parser, which then cannot be called while the parser is
/// borrowed — returning them keeps the parser a plain value and keeps the
/// tests free of channels.
#[derive(Debug, Default)]
pub struct ControlStream {
    buf: String,
    block: Option<(String, Vec<String>)>,
}

impl ControlStream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.buf.clear();
        self.block = None;
    }

    pub fn push(&mut self, chunk: &str) -> Vec<Block> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.find('\n') {
            let mut line: String = self.buf[..nl].to_string();
            if line.ends_with('\r') {
                line.pop();
            }
            self.buf.drain(..=nl);
            self.line(&line, &mut out);
        }
        out
    }

    fn line(&mut self, line: &str, out: &mut Vec<Block>) {
        if let Some((id, lines)) = self.block.as_mut() {
            if closes(line, "%end", id) {
                let (_, lines) = self.block.take().expect("block present");
                out.push(Block::Output(lines.join("\n")));
                return;
            }
            if closes(line, "%error", id) {
                let (_, lines) = self.block.take().expect("block present");
                let msg = lines.join("\n").trim().to_string();
                out.push(Block::Error(if msg.is_empty() {
                    "tmux error".to_string()
                } else {
                    msg
                }));
                return;
            }
            lines.push(line.to_string());
            return;
        }
        if let Some(rest) = line.strip_prefix("%begin ") {
            let mut parts = rest.split(' ');
            let ts = parts.next().unwrap_or("");
            let num = parts.next().unwrap_or("");
            self.block = Some((format!("{ts} {num}"), Vec::new()));
        }
        // Every other `%notification` — %session-changed, %window-add, %exit —
        // is state this client does not model. It asks questions and reads
        // answers.
    }
}

fn closes(line: &str, marker: &str, id: &str) -> bool {
    let head = format!("{marker} {id}");
    line == head || line.starts_with(&format!("{head} "))
}

/* ------------------------------------------------------------- utf-8 chunks */

/// Decode pipe chunks to text without splitting a character in half.
///
/// Node's `setEncoding('utf8')` does this for free; Rust hands back raw bytes,
/// and a pipe splits wherever it likes. `capture-pane` output is full of
/// box-drawing and CJK, so a 3-byte character straddling a read boundary is
/// routine — decoding each chunk on its own would turn it into U+FFFD and the
/// pane would render corruption that is not on the user's screen.
#[derive(Debug, Default)]
struct Utf8Chunker {
    /// At most three bytes: the incomplete tail of the last read.
    tail: Vec<u8>,
}

/// What one decoding step left behind.
enum Decoded {
    /// That many bytes are decoded, and what follows is worth another look.
    More(usize),
    /// That many bytes are decoded and the rest — a truncated character, or
    /// nothing at all — belongs to the next chunk.
    Done(usize),
}

impl Utf8Chunker {
    fn push(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.tail);
        buf.extend_from_slice(bytes);
        let mut out = String::new();
        let mut start = 0usize;
        loop {
            match Utf8Chunker::decode(&buf[start..], &mut out) {
                Decoded::More(consumed) => start += consumed,
                Decoded::Done(consumed) => {
                    start += consumed;
                    break;
                }
            }
        }
        self.tail = buf[start..].to_vec();
        out
    }

    /// Take everything decodable off the front of `bytes` and say how far that
    /// got. The two ways to stop are opposite ones: a clean decode has taken
    /// the lot, while a truncated character has to be held back, which is the
    /// whole reason this type exists.
    fn decode(bytes: &[u8], out: &mut String) -> Decoded {
        let broken = match std::str::from_utf8(bytes) {
            Ok(text) => {
                out.push_str(text);
                return Decoded::Done(bytes.len());
            }
            Err(broken) => broken,
        };
        let valid = broken.valid_up_to();
        out.push_str(std::str::from_utf8(&bytes[..valid]).unwrap_or(""));
        match broken.error_len() {
            // Genuinely invalid: consume it and mark it, the way a lossy decode
            // would.
            Some(len) => {
                out.push('\u{FFFD}');
                Decoded::More(valid + len)
            }
            // Truncated: hold it back for the next chunk.
            None => Decoded::Done(valid),
        }
    }
}

/* ----------------------------------------------------------------- transport */

/// How the client reaches tmux.
///
/// Injected so the framing and the restart behaviour can be tested against a
/// fake tmux rather than only against a real one — the reply accounting is the
/// part of this file that fails silently, so it is the part that most needs a
/// test that can force the awkward cases.
#[async_trait]
pub trait TmuxTransport: Send + Sync + 'static {
    /// Any session name on the server, or `None` if it has none.
    async fn first_session(&self) -> Option<String>;
    fn spawn(&self, args: &[&str]) -> std::io::Result<ControlChannel>;
}

/// A spawned control client, reduced to the three things this file needs.
pub struct ControlChannel {
    /// Command lines to write to the client's stdin.
    pub input: mpsc::UnboundedSender<String>,
    /// Decoded stdout. Closing it is how the client reports that it exited.
    pub output: mpsc::UnboundedReceiver<String>,
    pub kill: Arc<dyn Fn() + Send + Sync>,
}

pub struct LiveTransport;

/// Forward every chunk tmux writes, decoded and never split mid-character.
///
/// Dropping the sender when the pipe closes is how the client reports that it
/// exited, so this task ending is itself a signal.
fn forward_output(
    mut stdout: tokio::process::ChildStdout,
    chunks: mpsc::UnboundedSender<String>,
) {
    tokio::spawn(async move {
        let mut chunker = Utf8Chunker::default();
        let mut buf = [0u8; STDOUT_CHUNK_BYTES];
        while let Ok(read) = stdout.read(&mut buf).await {
            if read == 0 {
                break;
            }
            let text = chunker.push(&buf[..read]);
            if !text.is_empty() && chunks.send(text).is_err() {
                break;
            }
        }
    });
}

/// Drain stderr rather than read it: an unread pipe fills and blocks the
/// child, and control mode reports its errors in-band as `%error`.
fn drain_stderr(mut stderr: tokio::process::ChildStderr) {
    tokio::spawn(async move {
        let mut sink = [0u8; STDERR_SINK_BYTES];
        while let Ok(read) = stderr.read(&mut sink).await {
            if read == 0 {
                break;
            }
        }
    });
}

/// Write each queued command line to the client's stdin, in order.
fn forward_input(
    mut stdin: tokio::process::ChildStdin,
    mut lines: mpsc::UnboundedReceiver<String>,
) {
    tokio::spawn(async move {
        while let Some(line) = lines.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });
}

/// Reap the child when it ends on its own, or kill it first if asked to.
fn reap(mut child: tokio::process::Child, mut kills: mpsc::UnboundedReceiver<()>) {
    tokio::spawn(async move {
        tokio::select! {
            _ = kills.recv() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
            _ = child.wait() => {}
        }
    });
}

#[async_trait]
impl TmuxTransport for LiveTransport {
    async fn first_session(&self) -> Option<String> {
        let fut = Command::new("tmux")
            .args(["list-sessions", "-F", "#{session_name}"])
            .output();
        let out = tokio::time::timeout(LIST_SESSIONS_TIMEOUT, fut).await.ok()?.ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find(|l| !l.trim().is_empty())
            .map(|l| l.trim().to_string())
    }

    fn spawn(&self, args: &[&str]) -> std::io::Result<ControlChannel> {
        use std::process::Stdio;
        let mut child = Command::new("tmux")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
        let (in_tx, in_rx) = mpsc::unbounded_channel::<String>();
        let (kill_tx, kill_rx) = mpsc::unbounded_channel::<()>();

        forward_output(stdout, out_tx);
        drain_stderr(stderr);
        forward_input(stdin, in_rx);
        reap(child, kill_rx);

        Ok(ControlChannel {
            input: in_tx,
            output: out_rx,
            kill: Arc::new(move || {
                let _ = kill_tx.send(());
            }),
        })
    }
}

/* -------------------------------------------------------------- the client */

/// The reply half of one queued command line.
type PendingReply = oneshot::Receiver<Result<String, TmuxControlError>>;

struct Waiter {
    tx: oneshot::Sender<Result<String, TmuxControlError>>,
    /// How many reply blocks this command line will produce; see `run`.
    expected: usize,
    parts: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Stats {
    pub commands: AtomicU64,
    pub restarts: AtomicU64,
    pub failures: AtomicU64,
}

/// A snapshot of [`Stats`], for the benchmark script and the tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatsSnapshot {
    pub commands: u64,
    pub restarts: u64,
    pub failures: u64,
}

struct State {
    stopped: bool,
    ready: bool,
    starting: bool,
    restart_scheduled: bool,
    /// Bumped for every spawned client, so a late callback from a dead one
    /// cannot tear down its replacement.
    generation: u64,
    input: Option<mpsc::UnboundedSender<String>>,
    kill: Option<Arc<dyn Fn() + Send + Sync>>,
    waiters: VecDeque<Waiter>,
    stream: ControlStream,
    restart_delay_ms: u64,
}

struct Inner {
    transport: Arc<dyn TmuxTransport>,
    state: Mutex<State>,
    stats: Stats,
    settle_ms: AtomicU64,
}

pub struct TmuxControl {
    inner: Arc<Inner>,
}

impl TmuxControl {
    pub fn new(transport: Arc<dyn TmuxTransport>) -> Self {
        TmuxControl {
            inner: Arc::new(Inner {
                transport,
                state: Mutex::new(State {
                    stopped: false,
                    ready: false,
                    starting: false,
                    restart_scheduled: false,
                    generation: 0,
                    input: None,
                    kill: None,
                    waiters: VecDeque::new(),
                    stream: ControlStream::new(),
                    restart_delay_ms: RESTART_BASE_MS,
                }),
                stats: Stats::default(),
                settle_ms: AtomicU64::new(DEFAULT_SETTLE_MS),
            }),
        }
    }

    pub fn live() -> Self {
        TmuxControl::new(Arc::new(LiveTransport))
    }

    /// How long to ignore tmux's own startup chatter before probing.
    pub fn set_settle_ms(&self, millis: u64) {
        self.inner.settle_ms.store(millis, Ordering::Relaxed);
    }

    pub fn stats(&self) -> StatsSnapshot {
        StatsSnapshot {
            commands: self.inner.stats.commands.load(Ordering::Relaxed),
            restarts: self.inner.stats.restarts.load(Ordering::Relaxed),
            failures: self.inner.stats.failures.load(Ordering::Relaxed),
        }
    }

    /// True when a command can be sent right now. Callers spawn instead if not.
    pub fn ready(&self) -> bool {
        let st = self.inner.state.lock().unwrap();
        st.ready && st.input.is_some()
    }

    /// Bring the client up in the background.
    ///
    /// Deliberately not awaited by callers. Starting costs a `list-sessions`
    /// and a handshake, and making the first pane read wait for that would put
    /// the slowest tmux call of the whole session directly in front of the
    /// user. The first few reads spawn as before and the client takes over
    /// once it answers.
    pub fn start(&self) {
        {
            let mut st = self.inner.state.lock().unwrap();
            if st.stopped || st.input.is_some() || st.starting {
                return;
            }
            st.starting = true;
        }
        let inner = self.inner.clone();
        tokio::spawn(async move { Inner::spawn_client(inner).await });
    }

    pub fn stop(&self) {
        let (kill, waiters) = {
            let mut st = self.inner.state.lock().unwrap();
            st.stopped = true;
            st.ready = false;
            let waiters: Vec<Waiter> = st.waiters.drain(..).collect();
            st.input = None;
            (st.kill.take(), waiters)
        };
        for w in waiters {
            let _ = w.tx.send(Err(TmuxControlError::new("stopped")));
        }
        if let Some(kill) = kill {
            kill();
        }
    }

    /// Run a sequence of tmux commands as one line, and return their output.
    ///
    /// Taken as a slice rather than a joined string on purpose: the number of
    /// commands is what says how many reply blocks to expect, and recovering
    /// that by splitting a string on `;` would be one stray semicolon away from
    /// silently desynchronising every later reply.
    ///
    /// Callers must only ever build these from validated pane ids, generated
    /// buffer names and constant format strings. No text a user typed is ever
    /// spelled out here — it travels through a file, so tmux's own argument
    /// lexer never sees it. See `pane`.
    pub async fn run(&self, commands: &[String]) -> Result<String, TmuxControlError> {
        if !self.ready() {
            return Err(TmuxControlError::new("control client not ready"));
        }
        Inner::send(&self.inner, commands, COMMAND_TIMEOUT).await
    }
}

impl Inner {
    async fn spawn_client(inner: Arc<Inner>) {
        let result = Inner::spawn_client_inner(&inner).await;
        {
            let mut st = inner.state.lock().unwrap();
            st.starting = false;
        }
        if result.is_err() {
            Inner::schedule_restart(&inner);
        }
    }

    async fn spawn_client_inner(inner: &Arc<Inner>) -> Result<(), ()> {
        let session = inner.transport.first_session().await;
        if inner.state.lock().unwrap().stopped {
            return Ok(());
        }
        // No session means nothing to attach to *and* nothing to read, so there
        // is no work being missed. A later restart picks one up when it appears.
        let session = session.ok_or(())?;

        let channel = inner
            .transport
            .spawn(&["-C", "attach", "-t", &session, "-f", ATTACH_FLAGS])
            .map_err(|_| ())?;

        let ControlChannel { input, output, kill } = channel;
        let Some(generation) = Inner::adopt(inner, input, kill.clone()) else {
            kill();
            return Ok(());
        };
        Inner::read_from(inner, output, generation);
        if !Inner::settle(inner, generation).await {
            return Ok(());
        }
        Inner::probe(inner, generation, kill).await;
        Ok(())
    }

    /// Take a freshly spawned client as the current one, and say which
    /// generation it is — or `None` if this client was stopped meanwhile, in
    /// which case the caller kills what it just started.
    fn adopt(
        inner: &Arc<Inner>,
        input: mpsc::UnboundedSender<String>,
        kill: Arc<dyn Fn() + Send + Sync>,
    ) -> Option<u64> {
        let mut st = inner.state.lock().unwrap();
        if st.stopped {
            return None;
        }
        st.generation += 1;
        st.input = Some(input);
        st.kill = Some(kill);
        st.stream.reset();
        Some(st.generation)
    }

    /// The reader: every chunk tmux writes, framed and attributed.
    fn read_from(
        inner: &Arc<Inner>,
        mut output: mpsc::UnboundedReceiver<String>,
        generation: u64,
    ) {
        let inner = inner.clone();
        tokio::spawn(async move {
            while let Some(chunk) = output.recv().await {
                Inner::on_chunk(&inner, generation, &chunk);
            }
            Inner::on_exit(&inner, generation);
        });
    }

    /// Let the attach finish talking, then throw away what it said.
    ///
    /// Anything tmux says before the probe belongs to the attach, not to us.
    /// Waiting a beat and then clearing is what keeps a startup notification
    /// from being handed to the first real command as its reply.
    ///
    /// False when this client has been stopped or already replaced, in which
    /// case there is nothing left worth probing.
    async fn settle(inner: &Arc<Inner>, generation: u64) -> bool {
        let settle = inner.settle_ms.load(Ordering::Relaxed);
        if settle > 0 {
            tokio::time::sleep(Duration::from_millis(settle)).await;
        } else {
            tokio::task::yield_now().await;
        }
        let mut st = inner.state.lock().unwrap();
        if st.stopped || st.generation != generation {
            return false;
        }
        st.stream.reset();
        true
    }

    /// Ask one question, and believe in the client only if it answers.
    ///
    /// A tmux that cannot answer in control mode fails here rather than
    /// silently attaching a client that could resize the user's panes. Falling
    /// back is the correct outcome, not a degraded one.
    async fn probe(inner: &Arc<Inner>, generation: u64, kill: Arc<dyn Fn() + Send + Sync>) {
        let probe = Inner::send(inner, &["display-message -p ok".to_string()], PROBE_TIMEOUT).await;
        if !matches!(&probe, Ok(out) if out.trim() == "ok") {
            kill();
            Inner::on_exit(inner, generation);
            return;
        }
        let mut st = inner.state.lock().unwrap();
        if st.generation == generation {
            st.ready = true;
            st.restart_delay_ms = RESTART_BASE_MS;
        }
    }

    fn on_chunk(inner: &Arc<Inner>, generation: u64, chunk: &str) {
        let mut sends: Vec<(oneshot::Sender<Result<String, TmuxControlError>>, Result<String, TmuxControlError>)> =
            Vec::new();
        {
            let mut st = inner.state.lock().unwrap();
            if st.stopped || st.generation != generation {
                return;
            }
            let blocks = st.stream.push(chunk);
            for block in blocks {
                Inner::finish(&mut st, block, &mut sends);
            }
        }
        for (tx, msg) in sends {
            let _ = tx.send(msg);
        }
    }

    /// Attribute one reply block to the command line waiting for it.
    ///
    /// A command *line* is not one block. tmux replies once per command in the
    /// sequence, so `a ; b ; c` comes back as three `%begin`/`%end` pairs —
    /// which is the whole reason this counts rather than popping a waiter per
    /// block. Getting that wrong does not fail loudly: the first block resolves
    /// the call, the other two are then handed to whatever is asked next, and
    /// every reply from there on is shifted by one. In practice that means the
    /// Attach view drawing a pane's contents into another pane's geometry.
    ///
    /// An error ends the line. Measured against tmux 3.6a: a sequence that
    /// fails to resolve a target (`paste-buffer` of a buffer that is gone,
    /// `send-keys` to a pane that has exited) and a sequence that fails to
    /// parse both produce exactly one `%error` block and run nothing further,
    /// so there is never a remainder left to skip.
    fn finish(
        state: &mut State,
        block: Block,
        sends: &mut Vec<(oneshot::Sender<Result<String, TmuxControlError>>, Result<String, TmuxControlError>)>,
    ) {
        // No waiter means tmux volunteered a block nobody asked for. Dropping it
        // is right: handing it to the next command would answer that command
        // with someone else's output.
        if state.waiters.is_empty() {
            return;
        }
        match block {
            Block::Error(msg) => {
                let waiter = state.waiters.pop_front().expect("checked non-empty");
                sends.push((waiter.tx, Err(TmuxControlError::new(msg))));
            }
            Block::Output(out) => {
                let done = {
                    let waiter = state.waiters.front_mut().expect("checked non-empty");
                    waiter.parts.push(out);
                    waiter.parts.len() >= waiter.expected
                };
                if !done {
                    return;
                }
                let waiter = state.waiters.pop_front().expect("checked non-empty");
                // Commands that say nothing — `load-buffer`, `send-keys` —
                // contribute no lines, so their empty replies are not joined in
                // as blank ones. A read that is genuinely empty is padded by
                // the caller from the geometry it asked for in the same breath.
                let joined = waiter
                    .parts
                    .into_iter()
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                sends.push((waiter.tx, Ok(joined)));
            }
        }
    }

    fn on_exit(inner: &Arc<Inner>, generation: u64) {
        let waiters = {
            let mut st = inner.state.lock().unwrap();
            if st.generation != generation {
                return;
            }
            st.input = None;
            st.kill = None;
            st.ready = false;
            st.stream.reset();
            st.waiters.drain(..).collect::<Vec<_>>()
        };
        for w in waiters {
            let _ = w.tx.send(Err(TmuxControlError::new("tmux control client exited")));
        }
        Inner::schedule_restart(inner);
    }

    fn schedule_restart(inner: &Arc<Inner>) {
        let delay = {
            let mut st = inner.state.lock().unwrap();
            if st.stopped || st.restart_scheduled {
                return;
            }
            st.restart_scheduled = true;
            let delay = st.restart_delay_ms;
            st.restart_delay_ms = (st.restart_delay_ms * 2).min(RESTART_MAX_MS);
            delay
        };
        inner.stats.restarts.fetch_add(1, Ordering::Relaxed);
        let inner = inner.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            {
                let mut st = inner.state.lock().unwrap();
                st.restart_scheduled = false;
                if st.stopped || st.starting || st.input.is_some() {
                    return;
                }
                st.starting = true;
            }
            Inner::spawn_client(inner).await;
        });
    }

    async fn send(
        inner: &Arc<Inner>,
        commands: &[String],
        timeout: Duration,
    ) -> Result<String, TmuxControlError> {
        let line = commands.join(SEPARATOR);
        let reply = Inner::queue(inner, commands, &line)?;
        match tokio::time::timeout(timeout, reply).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(TmuxControlError::new("tmux control client exited")),
            Err(_) => Err(Inner::lost(inner, &line)),
        }
    }

    /// Put one command line on the wire and take a place in the reply queue.
    ///
    /// The two happen under one lock on purpose: the queue records the order
    /// replies will arrive in, so a line written outside the lock could be
    /// answered before the waiter that expects it is in place.
    fn queue(
        inner: &Arc<Inner>,
        commands: &[String],
        line: &str,
    ) -> Result<PendingReply, TmuxControlError> {
        let mut st = inner.state.lock().unwrap();
        let Some(input) = st.input.clone() else {
            return Err(TmuxControlError::new("no tmux control client"));
        };
        if st.stopped {
            return Err(TmuxControlError::new("stopped"));
        }
        let (tx, rx) = oneshot::channel();
        st.waiters.push_back(Waiter {
            tx,
            expected: commands.len(),
            parts: Vec::new(),
        });
        inner
            .stats
            .commands
            .fetch_add(commands.len() as u64, Ordering::Relaxed);
        if input.send(format!("{line}\n")).is_err() {
            // The writer is gone; the waiter is cleared by `on_exit`.
            return Err(TmuxControlError::new("no tmux control client"));
        }
        Ok(rx)
    }

    /// Give up on a command line, and on the client with it.
    ///
    /// A reply that never came means the queue no longer lines up with the
    /// server's replies, and every later command would be answered by the one
    /// before it. Restarting is the only way back to a known position. The
    /// waiter itself is left in place and cleared, with all the others, by
    /// `on_exit`.
    fn lost(inner: &Arc<Inner>, line: &str) -> TmuxControlError {
        inner.stats.failures.fetch_add(1, Ordering::Relaxed);
        let kill = inner.state.lock().unwrap().kill.clone();
        if let Some(kill) = kill {
            kill();
        }
        TmuxControlError::new(format!("tmux control command timed out: {line}"))
    }
}

/// The one client, borrowed for as long as the process lives.
///
/// Named rather than spelled out at the return position because the borrow is
/// the point: there is a single client, and every caller shares it.
type ProcessWideControl = &'static TmuxControl;

/// The process-wide client. Mock mode never starts it.
pub fn tmux_control() -> ProcessWideControl {
    static CONTROL: OnceLock<TmuxControl> = OnceLock::new();
    CONTROL.get_or_init(TmuxControl::live)
}

/* --------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    //! The control-mode framing, and the reply accounting behind it.
    //!
    //! This is the parser that decides which command a given lump of tmux
    //! output is the answer to. Getting it wrong is not a cosmetic failure:
    //! hand a block to the wrong waiter and every reply after it is shifted by
    //! one, so the Attach view draws another agent's pane and the geometry it
    //! is sized from belongs to a third. None of it needs a tmux server.

    use super::*;

    fn collect(stream: &mut ControlStream, chunk: &str) -> Vec<Block> {
        stream.push(chunk)
    }

    fn out(block: &Block) -> &str {
        match block {
            Block::Output(s) => s,
            Block::Error(s) => s,
        }
    }

    /// Chunk sizes a pipe might plausibly hand a reply over in, from one byte
    /// at a time to a size that lands mid-terminator.
    const REPLY_CHUNK_SIZES: [usize; 4] = [1, 3, 7, 13];
    /// Chunk sizes that split a 3-byte character every possible way.
    const CHARACTER_CHUNK_SIZES: [usize; 5] = [1, 2, 3, 5, 8];
    /// Long enough for a reply that is going to arrive to have arrived.
    const LONGER_THAN_A_REPLY_MS: u64 = 20;
    /// Long enough for a restart to have been scheduled and counted.
    const ENOUGH_FOR_A_RESTART_MS: u64 = 30;

    #[test]
    fn reads_one_command_reply() {
        let mut s = ControlStream::new();
        let blocks = collect(&mut s, "%begin 1712 3 1\n150|47|2|21|0|0\n%end 1712 3 1\n");
        assert_eq!(blocks, vec![Block::Output("150|47|2|21|0|0".into())]);
    }

    #[test]
    fn keeps_every_line_blank_ones_included() {
        let mut s = ControlStream::new();
        let blocks = collect(&mut s, "%begin 1 1 1\nrow one\n\nrow three\n%end 1 1 1\n");
        assert_eq!(out(&blocks[0]), "row one\n\nrow three");
    }

    #[test]
    fn reports_error_as_a_failure_rather_than_output() {
        let mut s = ControlStream::new();
        let blocks = collect(&mut s, "%begin 1 4 1\ncan't find pane %999\n%error 1 4 1\n");
        assert_eq!(blocks, vec![Block::Error("can't find pane %999".into())]);
    }

    /// The reason the block id is carried around. tmux does not escape command
    /// output, and `capture-pane` on a pane that happens to be showing this
    /// protocol — a developer with the control stream on screen, this project's
    /// own benchmark output — contains lines that look exactly like
    /// terminators. Ending the block there would return a truncated pane and
    /// leave the real terminator to be read as the *next* command's reply.
    #[test]
    fn is_not_ended_early_by_captured_output_that_looks_like_a_terminator() {
        let mut s = ControlStream::new();
        let mut blocks = Vec::new();
        blocks.extend(s.push("%begin 900 7 1\n"));
        blocks.extend(s.push("%end 900 6 1\n")); // a different command's id, captured as text
        blocks.extend(s.push("%end\n")); // and a bare one
        blocks.extend(s.push("still mine\n"));
        blocks.extend(s.push("%end 900 7 1\n"));
        assert_eq!(
            blocks,
            vec![Block::Output("%end 900 6 1\n%end\nstill mine".into())]
        );
    }

    #[test]
    fn ignores_notifications_between_replies() {
        let mut s = ControlStream::new();
        let mut blocks = Vec::new();
        blocks.extend(s.push("%session-changed $2 work\n"));
        blocks.extend(s.push("%begin 5 1 1\nok\n%end 5 1 1\n"));
        blocks.extend(s.push("%window-add @9\n"));
        blocks.extend(s.push("%begin 5 2 1\nfine\n%end 5 2 1\n"));
        assert_eq!(
            blocks.iter().map(out).collect::<Vec<_>>(),
            vec!["ok", "fine"]
        );
    }

    /// A pipe splits wherever it likes. A 47-row capture arrives in several
    /// chunks, and a chunk can end mid-line — including in the middle of the
    /// terminator itself.
    #[test]
    fn reassembles_a_reply_split_across_arbitrary_chunks() {
        let whole = "%begin 3 9 1\nalpha\nbeta\ngamma\n%end 3 9 1\n";
        for size in REPLY_CHUNK_SIZES {
            let mut s = ControlStream::new();
            let mut blocks = Vec::new();
            let bytes: Vec<char> = whole.chars().collect();
            for chunk in bytes.chunks(size) {
                blocks.extend(s.push(&chunk.iter().collect::<String>()));
            }
            assert_eq!(
                blocks,
                vec![Block::Output("alpha\nbeta\ngamma".into())],
                "chunk size {size}"
            );
        }
    }

    #[test]
    fn holds_an_incomplete_reply_back() {
        let mut s = ControlStream::new();
        assert!(s.push("%begin 3 9 1\nalpha\n").is_empty());
        assert_eq!(s.push("%end 3 9 1\n").len(), 1);
    }

    #[test]
    fn drops_a_half_read_block_on_reset() {
        let mut s = ControlStream::new();
        s.push("%begin 3 9 1\nalpha\n");
        s.reset();
        assert!(s.push("%end 3 9 1\n").is_empty());
    }

    /// Node's `setEncoding('utf8')` holds partial characters back for free.
    /// Rust reads bytes, so this is the piece that has to do it by hand — and a
    /// pane full of box-drawing characters splits across a pipe read routinely.
    #[test]
    fn never_splits_a_character_across_chunks() {
        let text = "┌─┐ 日本語 ✓";
        let bytes = text.as_bytes();
        for size in CHARACTER_CHUNK_SIZES {
            let mut chunker = Utf8Chunker::default();
            let mut seen = String::new();
            for chunk in bytes.chunks(size) {
                seen.push_str(&chunker.push(chunk));
            }
            assert_eq!(seen, text, "chunk size {size}");
        }
    }

    #[test]
    fn marks_genuinely_invalid_bytes_rather_than_stalling() {
        let mut chunker = Utf8Chunker::default();
        assert_eq!(chunker.push(&[b'a', 0xff, b'b']), "a\u{FFFD}b");
    }

    /* ---------------------------------------------------- the fake tmux */

    /// A tmux that says exactly what the test tells it to.
    struct FakeTmux {
        written: Mutex<Vec<String>>,
        out: Mutex<Option<mpsc::UnboundedSender<String>>>,
        seq: AtomicU64,
    }

    impl FakeTmux {
        /// Emit one complete reply block.
        fn reply(&self, output: &str) {
            self.emit(output, "end");
        }

        /// Emit one complete `%error` block, which ends the command line it
        /// belongs to however many commands were left in it.
        fn reply_error(&self, message: &str) {
            self.emit(message, "error");
        }

        fn emit(&self, output: &str, terminator: &str) {
            let n = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
            let id = format!("100 {n}");
            let body = if output.is_empty() {
                String::new()
            } else {
                format!("{output}\n")
            };
            let msg = format!("%begin {id} 1\n{body}%{terminator} {id} 1\n");
            if let Some(tx) = self.out.lock().unwrap().as_ref() {
                let _ = tx.send(msg);
            }
        }

        fn kill(&self) {
            self.out.lock().unwrap().take();
        }

        fn written(&self) -> Vec<String> {
            self.written.lock().unwrap().clone()
        }
    }

    struct FakeTransport {
        session: Option<String>,
        last: Arc<Mutex<Option<Arc<FakeTmux>>>>,
    }

    #[async_trait]
    impl TmuxTransport for FakeTransport {
        async fn first_session(&self) -> Option<String> {
            self.session.clone()
        }

        fn spawn(&self, _args: &[&str]) -> std::io::Result<ControlChannel> {
            let (in_tx, mut in_rx) = mpsc::unbounded_channel::<String>();
            let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
            let fake = Arc::new(FakeTmux {
                written: Mutex::new(Vec::new()),
                out: Mutex::new(Some(out_tx)),
                seq: AtomicU64::new(0),
            });
            *self.last.lock().unwrap() = Some(fake.clone());
            {
                let fake = fake.clone();
                tokio::spawn(async move {
                    while let Some(line) = in_rx.recv().await {
                        fake.written.lock().unwrap().push(line.trim_end().to_string());
                    }
                });
            }
            let killable = fake.clone();
            Ok(ControlChannel {
                input: in_tx,
                output: out_rx,
                kill: Arc::new(move || killable.kill()),
            })
        }
    }

    async fn pause(millis: u64) {
        tokio::time::sleep(Duration::from_millis(millis)).await;
    }

    async fn connected() -> (Arc<FakeTmux>, TmuxControl) {
        let last: Arc<Mutex<Option<Arc<FakeTmux>>>> = Arc::new(Mutex::new(None));
        let client = TmuxControl::new(Arc::new(FakeTransport {
            session: Some("work".to_string()),
            last: last.clone(),
        }));
        client.set_settle_ms(0);
        client.start();
        // The probe is answered once it has actually been asked for.
        for _ in 0..400 {
            let fake = last.lock().unwrap().clone();
            if let Some(fake) = fake {
                if !fake.written().is_empty() {
                    fake.reply("ok");
                    break;
                }
            }
            pause(2).await;
        }
        for _ in 0..400 {
            if client.ready() {
                break;
            }
            pause(2).await;
        }
        assert!(client.ready(), "control client never became ready");
        let fake = last.lock().unwrap().clone().unwrap();
        fake.written.lock().unwrap().clear();
        (fake, client)
    }

    /// Send one command line on its own task, so the test can play tmux while
    /// it is still in flight — which is the only way to control what the
    /// replies are and what order they arrive in.
    fn sending(
        client: &TmuxControl,
        commands: &[&str],
    ) -> tokio::task::JoinHandle<Result<String, TmuxControlError>> {
        let inner = client.inner.clone();
        let commands: Vec<String> = commands.iter().map(|c| c.to_string()).collect();
        tokio::spawn(async move { Inner::send(&inner, &commands, COMMAND_TIMEOUT).await })
    }

    /// This file's own shipping code: comments dropped so prose about attaching
    /// is not evidence, and the test module cut off so the needles below cannot
    /// match themselves.
    fn shipping_code() -> String {
        let whole = include_str!("tmux_client.rs");
        whole
            .split("#[cfg(test)]")
            .next()
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// INV-1, as a source guarantee rather than a runtime one — the same three
    /// greps `test/safety.test.ts` runs over `tmux-client.ts`.
    ///
    /// A control-mode client has no size to impose, and acquires one only by
    /// asking for it. That request is the single way this app could reflow a
    /// working agent's pane, so its absence is asserted rather than assumed.
    #[test]
    fn inv1_never_passes_a_size_to_tmux() {
        let code = shipping_code();
        // Spelled in halves so that each assertion is not its own
        // counter-example the moment it is written.
        let ask_for_a_size = concat!("refresh-", "client");
        assert!(
            !code.contains(ask_for_a_size),
            "the control client asks tmux to give it a size"
        );
        let make_a_window = concat!("new-", "session");
        assert!(
            !code.contains(make_a_window),
            "the control client creates a window of its own size"
        );
    }

    #[test]
    fn inv1_only_ever_attaches_in_control_mode() {
        let code = shipping_code();
        let attaches: Vec<&str> = code
            .lines()
            .filter(|line| line.contains("spawn(") && line.contains("\"attach\""))
            .collect();
        assert_eq!(attaches.len(), 1, "expected exactly one attach: {attaches:?}");
        assert!(attaches[0].contains("\"-C\""), "attached outside control mode: {}", attaches[0]);
    }

    #[tokio::test]
    async fn inv1_the_attach_carries_nothing_but_control_mode_and_a_target() {
        struct Recorder(Mutex<Vec<Vec<String>>>);
        #[async_trait]
        impl TmuxTransport for Arc<Recorder> {
            async fn first_session(&self) -> Option<String> {
                Some("work".into())
            }
            fn spawn(&self, args: &[&str]) -> std::io::Result<ControlChannel> {
                self.0
                    .lock()
                    .unwrap()
                    .push(args.iter().map(|s| s.to_string()).collect());
                Err(std::io::Error::other("not today"))
            }
        }
        let rec = Arc::new(Recorder(Mutex::new(Vec::new())));
        let client = TmuxControl::new(Arc::new(rec.clone()));
        client.set_settle_ms(0);
        client.start();
        for _ in 0..200 {
            if !rec.0.lock().unwrap().is_empty() {
                break;
            }
            pause(2).await;
        }
        client.stop();
        let args = rec.0.lock().unwrap()[0].clone();
        // The greps above say what is absent; this says what is present, since
        // an argument list assembled at runtime is not what a grep reads. The
        // whole list is asserted rather than picked over: anything extra is as
        // much of a failure as something missing.
        assert_eq!(args, ["-C", "attach", "-t", "work", "-f", ATTACH_FLAGS]);
    }

    #[tokio::test]
    async fn joins_the_replies_of_a_two_command_line() {
        let (tmux, client) = connected().await;
        let handle = sending(
            &client,
            &["display-message -p X", "capture-pane -e -p -t %1"],
        );
        for _ in 0..100 {
            if !tmux.written().is_empty() {
                break;
            }
            pause(2).await;
        }
        assert_eq!(
            tmux.written(),
            vec!["display-message -p X ; capture-pane -e -p -t %1"]
        );
        tmux.reply("80|24|0|0|0|0");
        tmux.reply("row one\nrow two");
        assert_eq!(handle.await.unwrap().unwrap(), "80|24|0|0|0|0\nrow one\nrow two");
        client.stop();
    }

    #[tokio::test]
    async fn does_not_resolve_a_two_command_line_on_the_first_block() {
        let (tmux, client) = connected().await;
        let handle = sending(&client, &["a", "b"]);
        pause(10).await;
        tmux.reply("first");
        pause(LONGER_THAN_A_REPLY_MS).await;
        assert!(!handle.is_finished(), "resolved on one block of two");
        tmux.reply("second");
        assert!(handle.await.unwrap().is_ok());
        client.stop();
    }

    /// The failure this whole design exists to prevent. If a three-command line
    /// consumed one block, the two left over would answer the next two calls —
    /// so a paste would be followed by a read that returned a paste's empty
    /// reply as if it were a pane.
    #[tokio::test]
    async fn keeps_later_commands_aligned_after_a_multi_command_line() {
        let (tmux, client) = connected().await;
        let paste = sending(
            &client,
            &[
                "load-buffer -b b1 /tmp/x",
                "paste-buffer -b b1 -t %1 -p -d",
                "send-keys -t %1 Enter",
            ],
        );
        pause(10).await;
        tmux.reply("");
        tmux.reply("");
        tmux.reply("");
        assert_eq!(paste.await.unwrap().unwrap(), "");

        let read = sending(&client, &["display-message -p 80|24|0|0|0|0"]);
        pause(10).await;
        tmux.reply("80|24|0|0|0|0");
        // The read gets the read's answer, not a leftover from the paste.
        assert_eq!(read.await.unwrap().unwrap(), "80|24|0|0|0|0");
        client.stop();
    }

    #[tokio::test]
    async fn drops_the_empty_replies_of_commands_that_say_nothing() {
        let (tmux, client) = connected().await;
        let handle = sending(
            &client,
            &["load-buffer -b b1 /tmp/x", "capture-pane -p -t %1"],
        );
        pause(10).await;
        tmux.reply("");
        tmux.reply("only this");
        // A blank line joined in from `load-buffer` would become a phantom
        // first row of the pane.
        assert_eq!(handle.await.unwrap().unwrap(), "only this");
        client.stop();
    }

    /// Measured against tmux 3.6a: a sequence that cannot resolve a target and
    /// one that cannot be parsed both produce exactly one `%error` block and
    /// run nothing further. So an error ends the line, and there is no
    /// remainder to skip.
    #[tokio::test]
    async fn rejects_on_an_error_block_and_stays_aligned() {
        let (tmux, client) = connected().await;
        let failing = sending(
            &client,
            &["paste-buffer -b gone -t %1 -p -d", "send-keys -t %1 Enter"],
        );
        pause(10).await;
        tmux.reply_error("no buffer gone");
        let err = failing.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("no buffer gone"), "{err}");

        let next = sending(&client, &["display-message -p fine"]);
        pause(10).await;
        tmux.reply("fine");
        assert_eq!(next.await.unwrap().unwrap(), "fine");
        client.stop();
    }

    #[tokio::test]
    async fn rejects_a_mid_sequence_error_without_consuming_a_later_reply() {
        let (tmux, client) = connected().await;
        let failing = sending(
            &client,
            &["load-buffer -b b1 /tmp/x", "paste-buffer -b b1 -t %1 -p -d"],
        );
        pause(10).await;
        tmux.reply(""); // the load succeeded
        tmux.reply_error("can't find pane: %1"); // the paste did not
        let err = failing.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("can't find pane"), "{err}");

        let next = sending(&client, &["display-message -p still-here"]);
        pause(10).await;
        tmux.reply("still-here");
        assert_eq!(next.await.unwrap().unwrap(), "still-here");
        client.stop();
    }

    #[tokio::test]
    async fn rejects_what_was_in_flight_when_the_client_dies() {
        let (tmux, client) = connected().await;
        let pending = sending(&client, &["display-message -p X"]);
        pause(10).await;
        tmux.kill();
        let err = pending.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("exited"), "{err}");
        assert!(!client.ready());
        client.stop();
    }

    #[tokio::test]
    async fn refuses_new_commands_rather_than_queueing_them_against_nothing() {
        let (tmux, client) = connected().await;
        tmux.kill();
        pause(LONGER_THAN_A_REPLY_MS).await;
        let err = client.run(&["display-message -p X".to_string()]).await.unwrap_err();
        assert!(err.to_string().contains("not ready"), "{err}");
        client.stop();
    }

    #[tokio::test]
    async fn a_server_with_no_session_is_not_an_error() {
        // Nothing to attach to also means nothing to read, so no work is being
        // missed; a later restart picks a session up when one appears.
        let last = Arc::new(Mutex::new(None));
        let client = TmuxControl::new(Arc::new(FakeTransport { session: None, last }));
        client.set_settle_ms(0);
        client.start();
        pause(ENOUGH_FOR_A_RESTART_MS).await;
        assert!(!client.ready());
        assert!(client.stats().restarts >= 1);
        client.stop();
    }
}
