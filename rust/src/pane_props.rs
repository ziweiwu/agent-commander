//! INV-2 on the way out, as a property rather than as a list of examples.
//!
//! `pane::tests` covers the write path by example: one overlap, one failure
//! after tmux was reached, one refused spawn. Those are the interleavings that
//! have already gone wrong once. This module generates the interleavings that
//! have not — sequences of pastes and keys, two at a time, down either path,
//! with tmux refusing or failing at the moments it can — and holds every one of
//! them to INV-2's four clauses: what reaches a pane is what was typed for it,
//! exactly once, to that pane, in the order it was typed.
//!
//! The reference model is the simplest thing that can be right: a map from
//! pane id to the items that pane should have received. tmux is a fake in
//! miniature, with one buffer table reachable down both paths, because the
//! historical bug this generalises — a shared buffer name letting two
//! overlapping pastes run `load(A) → load(B) → paste(into A)` — lives in the
//! buffer table, and a fake without one could not have shown it.
//!
//! When a case fails, proptest shrinks it to a minimal sequence and writes it
//! to `proptest-regressions/pane_props.txt`, which is the regression test.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use proptest::prelude::*;
use proptest_state_machine::{prop_state_machine, ReferenceStateMachine, StateMachineTest};

use crate::pane::{Control, OneShot, PaneError, Panes, SPAWN_RETRIES};
use crate::sources::Submit;

/// Ids no other test uses: the write queues are keyed by pane id and shared
/// across the whole test process.
const PANES: [&str; 3] = ["%9101", "%9102", "%9103"];
/// Keys the model sends, each on `ALLOWED_KEYS`.
const KEYS: [&str; 3] = ["Enter", "Escape", "Up"];
/// Enough steps for two overlaps and a failure to land in one sequence.
const MAX_STEPS: usize = 10;
/// Cases per run. Each builds its own runtime and fake; the whole test has to
/// stay well inside the Stop hook's budget.
const CASES: u32 = 96;
/// How often a step is a plain write, against one of everything else. Plain
/// writes are the background the interesting steps interleave with.
const PLAIN_WRITE_WEIGHT: u32 = 4;
/// Overlaps are the step the historical bug lived in, so they are common.
const OVERLAP_WEIGHT: u32 = 3;

/// Pasted text carries `~` at both ends, which nothing tmux is ever asked
/// contains — so "the text never appears on a command line" is a substring
/// check with no false positives.
const TEXT: &str = "~[a-z]{1,8}~";

/* ------------------------------------------------------------- the model */

/// One write the user asked for.
#[derive(Clone, Debug)]
enum Write {
    Paste { pane: usize, text: String, submit: bool },
    Key { pane: usize, key: usize },
}

impl Write {
    fn pane(&self) -> &'static str {
        match self {
            Write::Paste { pane, .. } | Write::Key { pane, .. } => PANES[*pane],
        }
    }

    /// What the pane should receive, in order. Empty text with no submit is
    /// the one write that sends nothing at all.
    fn items(&self) -> Vec<String> {
        match self {
            Write::Paste { text, submit, .. } => {
                let mut items = Vec::new();
                if !text.is_empty() {
                    items.push(text.clone());
                }
                if *submit {
                    items.push(key_item("Enter"));
                }
                items
            }
            Write::Key { key, .. } => vec![key_item(KEYS[*key])],
        }
    }
}

fn key_item(key: &str) -> String {
    format!("<{key}>")
}

/// One step of the sequence: what the client does, and what tmux does to it.
#[derive(Clone, Debug)]
enum Step {
    /// A write, driven to completion.
    One(Write),
    /// Two writes started together. The first is polled first, so on a shared
    /// pane it is also queued first.
    Overlapping(Write, Write),
    /// A write tmux reports as failed *after* running it — an error at the last
    /// step of a sequence that already delivered. The text must land once and
    /// must not be retried down the other path.
    FailingAfterReach(Write),
    /// A write whose spawn is refused for want of a process slot `n` times
    /// before running. A refusal ran nothing, so retrying it is safe, and the
    /// text must still land exactly once.
    Refused(usize, Write),
    ControlUp,
    ControlDown,
}

/// The reference: what every pane should have received so far.
#[derive(Clone, Debug, Default)]
struct Expected {
    delivered: BTreeMap<String, Vec<String>>,
    control_up: bool,
}

impl Expected {
    fn receive(&mut self, write: &Write) {
        let items = write.items();
        if items.is_empty() {
            return;
        }
        self.delivered.entry(write.pane().to_string()).or_default().extend(items);
    }
}

fn write() -> impl Strategy<Value = Write> {
    let text = prop_oneof![Just(String::new()), TEXT.prop_map(String::from)];
    prop_oneof![
        (0..PANES.len(), text, any::<bool>())
            .prop_map(|(pane, text, submit)| Write::Paste { pane, text, submit }),
        (0..PANES.len(), 0..KEYS.len()).prop_map(|(pane, key)| Write::Key { pane, key }),
    ]
}

struct Model;

impl ReferenceStateMachine for Model {
    type State = Expected;
    type Transition = Step;

    fn init_state() -> BoxedStrategy<Expected> {
        any::<bool>()
            .prop_map(|control_up| Expected { delivered: BTreeMap::new(), control_up })
            .boxed()
    }

    fn transitions(_: &Expected) -> BoxedStrategy<Step> {
        prop_oneof![
            PLAIN_WRITE_WEIGHT => write().prop_map(Step::One),
            OVERLAP_WEIGHT => (write(), write())
                .prop_map(|(first, second)| Step::Overlapping(first, second)),
            1 => write().prop_map(Step::FailingAfterReach),
            1 => (1..=SPAWN_RETRIES, write()).prop_map(|(n, w)| Step::Refused(n, w)),
            1 => Just(Step::ControlUp),
            1 => Just(Step::ControlDown),
        ]
        .boxed()
    }

    fn apply(mut state: Expected, step: &Step) -> Expected {
        match step {
            Step::One(w) | Step::FailingAfterReach(w) | Step::Refused(_, w) => state.receive(w),
            Step::Overlapping(first, second) => {
                state.receive(first);
                state.receive(second);
            }
            Step::ControlUp => state.control_up = true,
            Step::ControlDown => state.control_up = false,
        }
        state
    }
}

/* -------------------------------------------------------- tmux, in miniature */

/// One tmux server, reachable as a control client and by spawning: the same
/// buffer table either way, because that is what makes a shared buffer name
/// dangerous in the first place.
#[derive(Default)]
struct MiniTmux {
    buffers: Mutex<HashMap<String, String>>,
    delivered: Mutex<BTreeMap<String, Vec<String>>>,
    /// Every command line that reached "tmux", for the never-on-argv check.
    command_lines: Mutex<Vec<String>>,
    control_up: AtomicBool,
    /// Report the next write as failed after having run it.
    fail_after_next: AtomicBool,
    /// Spawns to refuse, for want of a process slot, before letting one run.
    refusals: AtomicUsize,
}

impl MiniTmux {
    /// Run one tmux command. The yield first is the point: it is where a
    /// second sequence gets to interleave, as it would down a real socket.
    async fn execute(&self, command: &[String], stdin: Option<&str>) {
        tokio::task::yield_now().await;
        match command.first().map(String::as_str) {
            Some("load-buffer") => {
                // `load-buffer -b <name> <source>`: stdin as `-`, or a quoted path.
                let source = command.last().map(String::as_str).unwrap_or_default();
                let text = match source {
                    "-" => stdin.unwrap_or_default().to_string(),
                    quoted => std::fs::read_to_string(quoted.trim_matches('\'')).unwrap_or_default(),
                };
                self.buffers.lock().unwrap().insert(arg_after(command, "-b"), text);
            }
            Some("paste-buffer") => {
                let buffer = arg_after(command, "-b");
                let text = self
                    .buffers
                    .lock()
                    .unwrap()
                    .remove(&buffer)
                    .unwrap_or_else(|| "<no such buffer>".to_string());
                self.deliver(&arg_after(command, "-t"), text);
            }
            Some("send-keys") => {
                let key = command.last().cloned().unwrap_or_default();
                self.deliver(&arg_after(command, "-t"), key_item(&key));
            }
            Some("delete-buffer") => {
                self.buffers.lock().unwrap().remove(&arg_after(command, "-b"));
            }
            _ => {}
        }
    }

    fn deliver(&self, pane: &str, item: String) {
        self.delivered.lock().unwrap().entry(pane.to_string()).or_default().push(item);
    }

    /// The reply, or the failure that was armed for after this write.
    fn outcome(&self) -> Result<String, PaneError> {
        if self.fail_after_next.swap(false, Ordering::Relaxed) {
            return Err(PaneError::msg("tmux: error at the last step, text already in"));
        }
        Ok(String::new())
    }
}

fn arg_after(command: &[String], flag: &str) -> String {
    command
        .iter()
        .position(|arg| arg == flag)
        .and_then(|at| command.get(at + 1))
        .cloned()
        .unwrap_or_default()
}

/// A control-mode command line, tokenised. The only quoted argument the write
/// path produces is the staged file's path on `load-buffer`, kept whole.
fn control_tokens(line: &str) -> Vec<String> {
    match (line.find('\''), line.rfind('\'')) {
        (Some(open), Some(close)) if open < close => {
            let mut tokens: Vec<String> = line[..open].split_whitespace().map(String::from).collect();
            tokens.push(line[open..=close].to_string());
            tokens
        }
        _ => line.split_whitespace().map(String::from).collect(),
    }
}

/// The commands in one spawned invocation: a `;`-joined sequence.
fn spawn_commands(args: &[String]) -> Vec<Vec<String>> {
    args.split(|arg| arg == ";").filter(|c| !c.is_empty()).map(<[String]>::to_vec).collect()
}

#[async_trait]
impl Control for Arc<MiniTmux> {
    fn ready(&self) -> bool {
        self.control_up.load(Ordering::Relaxed)
    }
    async fn run(&self, commands: &[String]) -> Result<String, PaneError> {
        for line in commands {
            self.command_lines.lock().unwrap().push(line.clone());
            self.execute(&control_tokens(line), None).await;
        }
        self.outcome()
    }
}

#[async_trait]
impl OneShot for Arc<MiniTmux> {
    async fn run_once(&self, args: &[String], stdin: Option<&str>) -> Result<String, PaneError> {
        if self.refusals.load(Ordering::Relaxed) > 0 {
            // Refused before it started: nothing ran, nothing is recorded.
            self.refusals.fetch_sub(1, Ordering::Relaxed);
            return Err(PaneError::eagain("spawn tmux EAGAIN"));
        }
        self.command_lines.lock().unwrap().push(args.join(" "));
        for command in spawn_commands(args) {
            self.execute(&command, stdin).await;
        }
        self.outcome()
    }
}

/* -------------------------------------------------------- the system under test */

struct Sut {
    runtime: tokio::runtime::Runtime,
    tmux: Arc<MiniTmux>,
    panes: Panes,
}

async fn drive(panes: &Panes, write: &Write) -> Result<(), PaneError> {
    match write {
        Write::Paste { text, submit, .. } => {
            let submit = if *submit { Submit::Yes } else { Submit::No };
            panes.paste(write.pane(), text, submit).await
        }
        Write::Key { key, .. } => panes.key(write.pane(), KEYS[*key]).await,
    }
}

struct Harness;

impl StateMachineTest for Harness {
    type SystemUnderTest = Sut;
    type Reference = Model;

    fn init_test(expected: &Expected) -> Sut {
        let tmux = Arc::new(MiniTmux::default());
        tmux.control_up.store(expected.control_up, Ordering::Relaxed);
        let panes = Panes::with(Arc::new(tmux.clone()), Arc::new(tmux.clone()));
        // Paused time: the spawn path sleeps between refusals, and the test
        // has no reason to.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .start_paused(true)
            .build()
            .expect("a runtime");
        Sut { runtime, tmux, panes }
    }

    fn apply(sut: Sut, _: &Expected, step: Step) -> Sut {
        let Sut { runtime, tmux, panes } = &sut;
        match &step {
            Step::One(w) => {
                runtime.block_on(drive(panes, w)).expect("a plain write succeeds");
            }
            Step::Overlapping(first, second) => {
                let (a, b) = runtime.block_on(async { tokio::join!(drive(panes, first), drive(panes, second)) });
                a.expect("the first of two overlapping writes succeeds");
                b.expect("the second of two overlapping writes succeeds");
            }
            Step::FailingAfterReach(w) => {
                tmux.fail_after_next.store(true, Ordering::Relaxed);
                let result = runtime.block_on(drive(panes, w));
                tmux.fail_after_next.store(false, Ordering::Relaxed);
                if !w.items().is_empty() {
                    assert!(result.is_err(), "a failure tmux reported was swallowed: {step:?}");
                }
            }
            Step::Refused(n, w) => {
                tmux.refusals.store(*n, Ordering::Relaxed);
                runtime.block_on(drive(panes, w)).expect("a refused spawn is retried and lands");
                tmux.refusals.store(0, Ordering::Relaxed);
            }
            Step::ControlUp => tmux.control_up.store(true, Ordering::Relaxed),
            Step::ControlDown => tmux.control_up.store(false, Ordering::Relaxed),
        }
        sut
    }

    /// INV-2's four clauses, after every step: that text, exactly once, to
    /// that agent, in the order typed — and never on a command line.
    fn check_invariants(sut: &Sut, expected: &Expected) {
        let delivered = sut.tmux.delivered.lock().unwrap().clone();
        assert_eq!(delivered, expected.delivered, "what the panes received");

        let lines = sut.tmux.command_lines.lock().unwrap().clone();
        for text in expected.delivered.values().flatten().filter(|item| item.starts_with('~')) {
            assert!(
                !lines.iter().any(|line| line.contains(text.as_str())),
                "{text} was spelled on a tmux command line: {lines:?}"
            );
        }
    }
}

prop_state_machine! {
    #![proptest_config(ProptestConfig { cases: CASES, ..ProptestConfig::default() })]
    #[test]
    fn inv2_every_interleaving_delivers_each_text_once_to_its_pane_in_order(
        sequential 1..MAX_STEPS => Harness
    );
}
