//! Reading an agent's delegation tree off disk (INV-13).
//!
//! Port of `src/server/subagents.ts`.
//!
//! **The structure is not derived — Claude Code writes it down.** Beside every
//! subagent transcript sits a sidecar naming the delegate's type, the brief it
//! was given, and its parent:
//!
//! ```text
//! ~/.claude/projects/<slug>/<sessionId>/subagents/
//!   agent-<agentId>.jsonl        the delegate's own transcript
//!   agent-<agentId>.meta.json    {agentType, description, toolUseId,
//!                                 parentAgentId, spawnDepth}
//! ```
//!
//! Checked against 350 of them: every transcript has a sidecar and every
//! sidecar a transcript, `spawnDepth: 1` never carries `parentAgentId` and
//! depth 2 and 3 always do. So a whole tree costs one `readdir` plus a few
//! hundred bytes each, with no transcript parsing at all — which is what makes
//! this affordable to poll under INV-4.
//!
//! The directory is flat: a grandchild sits beside its parent. The tree is
//! rebuilt from `parentAgentId`, never from the path.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::agent_kinds::has_transcripts;
use crate::transcript::{find_transcript, projects_dir};
use crate::types::{Agent, AgentStatus, AgentTree, SubagentNode, SubagentState};

/// A delegate that has written this recently is treated as still running.
///
/// Only ever a *guess*, and it is marked as one. It is paired with the parent
/// being busy because on its own a recent write says nothing about whether the
/// work is continuing — a delegate that finished half a second ago also wrote
/// half a second ago.
const ACTIVE_WINDOW_MS: i64 = 90_000;

/// The shape of a sidecar, as far as anything here is willing to rely on it.
///
/// Every field is optional because nothing validates these files, and a node
/// with no label is still a node.
#[derive(Debug, Clone, Default)]
struct Sidecar {
    agent_type: Option<String>,
    description: Option<String>,
    /// A forked skill carries this instead of a subagent type.
    name: Option<String>,
    parent_agent_id: Option<String>,
    spawn_depth: Option<u32>,
    /// Evidence of an ending, and the only evidence a sidecar ever carries.
    stopped_by_user: bool,
    is_fork: bool,
}

impl Sidecar {
    /// Read the fields this module relies on out of a parsed sidecar.
    ///
    /// Walked as a `Value` rather than through `#[derive(Deserialize)]` for the
    /// same reason `transcript.rs` walks records that way: one unexpected field
    /// shape must cost that field, not the whole node (INV-5).
    fn from_value(raw: &Value) -> Option<Sidecar> {
        // A half-written sidecar parses to something that is not an object, and
        // one delegate's malformed file must not cost the whole tree (INV-5).
        let map = raw.as_object()?;
        let text = |key: &str| map.get(key).and_then(Value::as_str).map(str::to_string);
        let flag = |key: &str| map.get(key).and_then(Value::as_bool) == Some(true);
        Some(Sidecar {
            agent_type: text("agentType"),
            description: text("description"),
            name: text("name"),
            parent_agent_id: text("parentAgentId"),
            spawn_depth: map
                .get("spawnDepth")
                .and_then(Value::as_i64)
                .and_then(|n| u32::try_from(n).ok()),
            stopped_by_user: flag("stoppedByUser"),
            is_fork: flag("isFork"),
        })
    }
}

/// Sidecars, cached by path forever.
///
/// They are written once when the delegate is spawned and never touched again —
/// a type, a brief and a parent do not change — so re-reading one on every poll
/// would be pure cost. Only the transcript is re-`stat`ed.
fn sidecar_cache() -> &'static Mutex<HashMap<PathBuf, Sidecar>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Sidecar>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Testing seam: forget what was cached.
pub fn forget_sidecars() {
    if let Ok(mut cache) = sidecar_cache().lock() {
        cache.clear();
    }
}

/// One sidecar, from the cache or from disk. A failure is never cached: the
/// file may simply not have been finished being written yet.
async fn read_sidecar(path: &Path) -> Option<Sidecar> {
    if let Ok(cache) = sidecar_cache().lock() {
        if let Some(hit) = cache.get(path) {
            return Some(hit.clone());
        }
    }
    let text = tokio::fs::read_to_string(path).await.ok()?;
    let parsed = serde_json::from_str::<Value>(&text).ok()?;
    let sidecar = Sidecar::from_value(&parsed)?;
    if let Ok(mut cache) = sidecar_cache().lock() {
        cache.insert(path.to_path_buf(), sidecar.clone());
    }
    Some(sidecar)
}

/// One delegate as read off disk, still unlinked from any parent.
#[derive(Debug, Clone)]
struct Entry {
    agent_id: String,
    meta: Sidecar,
    last_write_at: i64,
    bytes: u64,
}

/// `agent-<id>.jsonl` -> `<id>`, and nothing else.
///
/// The sidecar beside it is `agent-<id>.meta.json`, which does not end in
/// `.jsonl` and so is never mistaken for a transcript.
fn agent_id_of(name: &str) -> Option<&str> {
    let id = name.strip_prefix("agent-")?.strip_suffix(".jsonl")?;
    (!id.is_empty()).then_some(id)
}

/// Every delegate of one session, unordered and unlinked.
async fn read_entries(dir: &Path) -> Vec<Entry> {
    /*
     * `stat` before `readdir`, exactly as `subagent_activity_at` does: most
     * agents never delegate, and the common case should cost one syscall
     * (INV-4).
     */
    if tokio::fs::metadata(dir).await.is_err() {
        return Vec::new();
    }
    let Ok(mut listing) = tokio::fs::read_dir(dir).await else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    while let Ok(Some(item)) = listing.next_entry().await {
        let name = item.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(agent_id) = agent_id_of(name).map(str::to_string) else { continue };
        let Some(meta) = read_sidecar(&dir.join(format!("agent-{agent_id}.meta.json"))).await
        else {
            continue;
        };
        // Vanished between readdir and stat; nothing to learn from it.
        let Ok(stat) = item.metadata().await else { continue };
        let last_write_at = stat
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        entries.push(Entry { agent_id, meta, last_write_at, bytes: stat.len() });
    }
    entries
}

/// What this app is willing to say a delegate is doing.
///
/// INV-13, and the ordering matters: evidence first, then a marked guess, then
/// an admission. `Done` is only ever claimed on something recorded — the user
/// stopped it — because an agent that finished and an agent that died look
/// identical from a transcript that stopped growing.
fn state_of(
    entry: &Entry,
    parent_status: AgentStatus,
    now: i64,
) -> (SubagentState, Option<bool>) {
    if entry.meta.stopped_by_user {
        return (SubagentState::Done, None);
    }
    if parent_status == AgentStatus::Busy && now - entry.last_write_at < ACTIVE_WINDOW_MS {
        return (SubagentState::Active, Some(true));
    }
    (SubagentState::Quiet, None)
}

/// One sidecar as a node of its own, still unattached to any parent.
fn to_node(entry: &Entry, parent_status: AgentStatus, now: i64) -> SubagentNode {
    let meta = &entry.meta;
    let (state, state_inferred) = state_of(entry, parent_status, now);
    SubagentNode {
        agent_id: entry.agent_id.clone(),
        // A forked skill carries `name` instead of a subagent type. Neither is
        // guaranteed, and a node with no label is still a node.
        agent_type: meta
            .agent_type
            .clone()
            .or_else(|| meta.name.clone())
            .unwrap_or_else(|| "agent".to_string()),
        description: meta.description.clone().unwrap_or_default(),
        depth: meta.spawn_depth.unwrap_or(1),
        parent_agent_id: meta.parent_agent_id.clone(),
        last_write_at: entry.last_write_at,
        bytes: entry.bytes,
        state,
        state_inferred,
        stopped_by_user: meta.stopped_by_user.then_some(true),
        reparented: None,
        children: Vec::new(),
    }
}

/// Whether attaching `node` to `parent` would close a loop.
///
/// Real data cannot produce one — `spawnDepth` only ever increases — but this
/// reads files nothing validates, and a loop is the one malformed shape that
/// loses data *silently*: two nodes naming each other end up in each other's
/// children, neither is a root, and the whole branch disappears from the view
/// with no error anywhere. That is precisely the failure the re-parenting rule
/// exists to prevent, so it has to hold for a loop as well as for an absent
/// parent.
fn would_loop(
    node: usize,
    parent: usize,
    nodes: &[SubagentNode],
    by_id: &HashMap<String, usize>,
) -> bool {
    let mut at = Some(parent);
    let mut steps = 0usize;
    while let Some(index) = at {
        if steps > nodes.len() {
            break;
        }
        if index == node {
            return true;
        }
        at = nodes[index]
            .parent_agent_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .and_then(|id| by_id.get(id).copied());
        steps += 1;
    }
    false
}

/// Assemble the flat list into a tree.
///
/// **An unresolvable parent is raised to the top, never dropped.** A sidecar
/// that is missing or half-written takes its whole subtree with it if children
/// are only ever attached to a parent that exists, and silently losing a branch
/// is a worse failure than showing one at the wrong depth (INV-5). `reparented`
/// marks it so the interface can say what happened rather than quietly lying
/// about the shape of the work.
fn assemble(entries: &[Entry], parent_status: AgentStatus, now: i64) -> Vec<SubagentNode> {
    let mut nodes: Vec<SubagentNode> =
        entries.iter().map(|e| to_node(e, parent_status, now)).collect();
    let mut by_id: HashMap<String, usize> = HashMap::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        by_id.insert(node.agent_id.clone(), index);
    }

    let mut children_of: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    let mut roots: Vec<usize> = Vec::new();
    for index in 0..nodes.len() {
        let named = nodes[index].parent_agent_id.clone();
        let parent = named
            .as_deref()
            .filter(|id| !id.is_empty())
            .and_then(|id| by_id.get(id).copied());
        if let Some(parent) = parent {
            if !would_loop(index, parent, &nodes, &by_id) {
                children_of[parent].push(index);
                continue;
            }
        }
        if named.is_some() {
            nodes[index].reparented = Some(true);
        }
        roots.push(index);
    }

    // Oldest first, so a tree reads in the order the work was handed out. The
    // sort is stable, so delegates written in the same millisecond keep the
    // order the directory listing gave them.
    for kids in &mut children_of {
        kids.sort_by_key(|&i| nodes[i].last_write_at);
    }
    roots.sort_by_key(|&i| nodes[i].last_write_at);

    let mut taken: Vec<Option<SubagentNode>> = nodes.into_iter().map(Some).collect();
    roots.into_iter().map(|i| build(i, &mut taken, &children_of)).collect()
}

/// Move one node and everything under it out of the flat arena.
///
/// `assemble` has already refused every edge that would close a loop, so the
/// child graph is a forest and this terminates.
fn build(
    index: usize,
    taken: &mut Vec<Option<SubagentNode>>,
    children_of: &[Vec<usize>],
) -> SubagentNode {
    let mut node = taken[index].take().expect("each node is built exactly once");
    node.children = children_of[index]
        .iter()
        .map(|&child| build(child, taken, children_of))
        .collect();
    node
}

/// One agent's delegates, given the agent's own transcript path.
///
/// That path is what names the directory the delegates live in. Without one
/// there is nothing to read, and for a CLI that keeps no transcript at all that
/// is *absence of evidence*: the tree comes back `unknown` rather than empty,
/// because "has not delegated" is a claim this app would have no way to make
/// (INV-11).
pub async fn read_tree_at(
    agent: &Agent,
    transcript_path: Option<&Path>,
    now: i64,
) -> AgentTree {
    if !has_transcripts(&agent.agent_kind) {
        return AgentTree {
            session_id: agent.session_id.clone(),
            children: Vec::new(),
            unknown: Some(true),
        };
    }
    let Some(path) = transcript_path else {
        return AgentTree {
            session_id: agent.session_id.clone(),
            children: Vec::new(),
            unknown: None,
        };
    };
    let dir = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(&agent.session_id)
        .join("subagents");
    let entries = read_entries(&dir).await;
    AgentTree {
        session_id: agent.session_id.clone(),
        children: assemble(&entries, agent.status, now),
        unknown: None,
    }
}

/// One agent's delegates, locating its transcript under `root` first.
///
/// The kind check comes before the directory scan on purpose: `find_transcript`
/// stats every project directory looking for a file a CLI that keeps no
/// transcript will never have, and doing that every poll for every such agent
/// is the loop INV-4 names outright.
pub async fn read_tree_in(agent: &Agent, root: &Path, now: i64) -> AgentTree {
    if !has_transcripts(&agent.agent_kind) {
        return AgentTree {
            session_id: agent.session_id.clone(),
            children: Vec::new(),
            unknown: Some(true),
        };
    }
    let path = find_transcript(&agent.session_id, root).await;
    read_tree_at(agent, path.as_deref(), now).await
}

/// One agent's delegates, read from the sidecars beside its transcript.
///
/// The transcript is located per call rather than cached, because
/// `find_transcript` caches nothing anyway and the graph is polled only while
/// somebody has the view open (INV-4). The sidecars themselves are cached
/// above, which is where the repeated cost would otherwise be.
pub async fn read_tree(agent: &Agent, now: i64) -> AgentTree {
    read_tree_in(agent, &projects_dir(), now).await
}

#[cfg(test)]
mod tests {
    //! Mirrors `test/subagents.test.ts`.
    //!
    //! INV-13: a subagent tree claims only what the sidecars say. The structure
    //! is not derived here — Claude Code writes it down — so what these pin is
    //! the two places judgement still enters: how a tree is rebuilt when a
    //! sidecar is missing or malformed, and how much a node's state is allowed
    //! to claim.
    use super::*;
    use crate::agent_kinds::CLAUDE_KIND;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    const NOW: i64 = 1_786_600_000_000;

    /// The sidecar cache is process-wide and keyed by path, and two temp
    /// directories can be handed the same path by the OS after a cleanup. The
    /// TS suite clears it in a `beforeEach`; Rust runs tests in threads, so the
    /// clear has to be paired with a lock or one test wipes another's cache
    /// mid-read.
    fn isolated() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
        let guard = LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        forget_sidecars();
        guard
    }

    fn agent() -> Agent {
        Agent {
            session_id: "sess-1".into(),
            pid: 1,
            name: "agent".into(),
            cwd: "/x".into(),
            folder: "x".into(),
            status: AgentStatus::Idle,
            agent_kind: CLAUDE_KIND.into(),
            kind: "interactive".into(),
            started_at: 0,
            pane_id: Some("%1".into()),
            ..Agent::default()
        }
    }

    fn busy() -> Agent {
        Agent { status: AgentStatus::Busy, ..agent() }
    }

    struct Fixture {
        id: &'static str,
        /// `None` writes no sidecar at all; a string is written verbatim so a
        /// half-written file can be fixtured.
        meta: Option<String>,
        wrote_ago: Option<i64>,
        bytes: usize,
    }

    fn fixture(id: &'static str, meta: Value) -> Fixture {
        Fixture { id, meta: Some(meta.to_string()), wrote_ago: None, bytes: 10 }
    }

    /// A project directory holding one session's transcript and its delegates.
    fn project(fixtures: &[Fixture]) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().expect("temp dir");
        let transcript = root.path().join("sess-1.jsonl");
        std::fs::write(&transcript, b"").expect("transcript");
        let dir = root.path().join("sess-1").join("subagents");
        std::fs::create_dir_all(&dir).expect("subagents dir");
        for f in fixtures {
            let jsonl = dir.join(format!("agent-{}.jsonl", f.id));
            std::fs::write(&jsonl, "x".repeat(f.bytes)).expect("delegate transcript");
            if let Some(meta) = &f.meta {
                std::fs::write(dir.join(format!("agent-{}.meta.json", f.id)), meta)
                    .expect("sidecar");
            }
            // Age is what separates `active` from `quiet`, so it has to be
            // settable.
            if let Some(ago) = f.wrote_ago {
                set_mtime(&jsonl, NOW - ago);
            }
        }
        (root, transcript)
    }

    fn set_mtime(path: &Path, at_ms: i64) {
        let when = UNIX_EPOCH + std::time::Duration::from_millis(at_ms as u64);
        let file = std::fs::File::options().write(true).open(path).expect("open for utimes");
        file.set_modified(when).expect("set mtime");
    }

    fn ids(nodes: &[SubagentNode]) -> Vec<String> {
        nodes.iter().map(|n| n.agent_id.clone()).collect()
    }

    fn find<'a>(nodes: &'a [SubagentNode], id: &str) -> Option<&'a SubagentNode> {
        for node in nodes {
            if node.agent_id == id {
                return Some(node);
            }
            if let Some(hit) = find(&node.children, id) {
                return Some(hit);
            }
        }
        None
    }

    /* ---- INV-13: structure comes from the sidecars ---- */

    #[tokio::test]
    async fn inv13_builds_a_three_deep_tree_from_parent_agent_id() {
        // Claude Code numbers `spawnDepth` from 1 at the first delegate, so a
        // delegate's delegate's delegate reports three.
        const GRANDCHILD_DEPTH: u32 = 3;

        let _guard = isolated();
        let sweep = json!({ "agentType": "qa-bar-raiser", "description": "sweep", "spawnDepth": 1 });
        let dig = json!({
            "agentType": "general-purpose",
            "description": "dig",
            "spawnDepth": 2,
            "parentAgentId": "a1",
        });
        let read = json!({
            "agentType": "Explore",
            "description": "read",
            "spawnDepth": GRANDCHILD_DEPTH,
            "parentAgentId": "a2",
        });
        let (_root, transcript) =
            project(&[fixture("a1", sweep), fixture("a2", dig), fixture("a3", read)]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].agent_id, "a1");
        assert_eq!(tree.children[0].agent_type, "qa-bar-raiser");
        let child = &tree.children[0].children[0];
        assert_eq!((child.agent_id.as_str(), child.depth), ("a2", 2));
        let grandchild = &child.children[0];
        assert_eq!(
            (grandchild.agent_id.as_str(), grandchild.depth),
            ("a3", GRANDCHILD_DEPTH)
        );
    }

    /*
     * The one structural judgement call, and it goes the safe way. A sidecar
     * that is missing or half-written takes its whole subtree with it if
     * children are only ever attached to a parent that exists — and silently
     * losing a branch of somebody's work is a worse failure than showing it at
     * the wrong depth (INV-5). It is marked so the view can say what happened.
     */
    #[tokio::test]
    async fn inv13_orphan_is_reparented_not_dropped() {
        let _guard = isolated();
        let (_root, transcript) = project(&[fixture(
            "a9",
            json!({ "agentType": "Explore", "description": "sweep", "spawnDepth": 2, "parentAgentId": "gone" }),
        )]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(ids(&tree.children), vec!["a9"]);
        assert_eq!(tree.children[0].reparented, Some(true));
        // Raised, not rewritten: the tree still says what the sidecar said.
        assert_eq!(tree.children[0].parent_agent_id.as_deref(), Some("gone"));
        assert_eq!(tree.children[0].depth, 2);
    }

    /*
     * Real sidecars cannot describe a loop — `spawnDepth` only ever increases —
     * but nothing validates these files, and a loop is the one malformed shape
     * that loses data *silently*: two nodes naming each other land in each
     * other's `children`, neither is a root, and the whole branch vanishes from
     * the view with no error anywhere.
     */
    #[tokio::test]
    async fn inv13_a_parent_loop_is_raised_rather_than_losing_both_nodes() {
        let _guard = isolated();
        let (_root, transcript) = project(&[
            fixture("x", json!({ "agentType": "a", "description": "x", "spawnDepth": 2, "parentAgentId": "y" })),
            fixture("y", json!({ "agentType": "b", "description": "y", "spawnDepth": 2, "parentAgentId": "x" })),
        ]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        // Both still reachable, and one of them broke the loop by being raised.
        let mut seen = Vec::new();
        fn walk(nodes: &[SubagentNode], seen: &mut Vec<String>) {
            for node in nodes {
                seen.push(node.agent_id.clone());
                walk(&node.children, seen);
            }
        }
        walk(&tree.children, &mut seen);
        seen.sort();
        assert_eq!(seen, vec!["x", "y"]);
        assert!(tree.children.iter().any(|c| c.reparented == Some(true)));
    }

    #[tokio::test]
    async fn inv13_does_not_attach_a_delegate_to_itself() {
        let _guard = isolated();
        let (_root, transcript) = project(&[fixture(
            "self",
            json!({ "agentType": "a", "description": "x", "spawnDepth": 2, "parentAgentId": "self" }),
        )]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(ids(&tree.children), vec!["self"]);
        assert_eq!(tree.children[0].reparented, Some(true));
        assert!(tree.children[0].children.is_empty());
    }

    #[tokio::test]
    async fn inv5_keeps_the_rest_of_a_tree_when_one_sidecar_is_malformed() {
        let _guard = isolated();
        let (_root, transcript) = project(&[
            fixture("good", json!({ "agentType": "qa-triage", "description": "check", "spawnDepth": 1 })),
            Fixture {
                id: "torn",
                meta: Some("{\"agentType\":\"gener".into()),
                wrote_ago: None,
                bytes: 10,
            },
        ]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(ids(&tree.children), vec!["good"]);
    }

    /// A sidecar that parses to something that is not an object is the same
    /// failure wearing a different shape, and costs the same one node.
    #[tokio::test]
    async fn inv5_ignores_a_sidecar_that_is_not_an_object() {
        let _guard = isolated();
        let (_root, transcript) = project(&[
            fixture("good", json!({ "agentType": "qa-triage", "description": "check", "spawnDepth": 1 })),
            Fixture { id: "odd", meta: Some("\"a string\"".into()), wrote_ago: None, bytes: 10 },
        ]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(ids(&tree.children), vec!["good"]);
    }

    /// A transcript with no sidecar beside it is not a delegate this app can
    /// describe, so it is not one this app claims.
    #[tokio::test]
    async fn inv13_skips_a_transcript_with_no_sidecar() {
        let _guard = isolated();
        let (_root, transcript) = project(&[
            fixture("good", json!({ "agentType": "qa-triage", "description": "check", "spawnDepth": 1 })),
            Fixture { id: "bare", meta: None, wrote_ago: None, bytes: 10 },
        ]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(ids(&tree.children), vec!["good"]);
    }

    // Observed variants: a forked skill carries `name` and no `agentType`, and a
    // killed delegate carries `stoppedByUser`.
    #[tokio::test]
    async fn inv13_reads_a_forked_skill_and_a_stopped_delegate() {
        let _guard = isolated();
        let (_root, transcript) = project(&[
            fixture(
                "fork",
                json!({
                    "name": "code-review",
                    "description": "review",
                    "spawnDepth": 1,
                    "isFork": true,
                }),
            ),
            fixture(
                "kill",
                json!({
                    "agentType": "Explore",
                    "description": "x",
                    "spawnDepth": 1,
                    "stoppedByUser": true,
                }),
            ),
        ]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(find(&tree.children, "fork").unwrap().agent_type, "code-review");
        let killed = find(&tree.children, "kill").unwrap();
        assert_eq!(killed.stopped_by_user, Some(true));
        // Evidence of an ending, so this one is allowed to say `done`.
        assert_eq!(killed.state, SubagentState::Done);
        // …and `done` is never a guess (INV-13).
        assert_eq!(killed.state_inferred, None);
    }

    /// A node with neither `agentType` nor `name` is still a node.
    #[tokio::test]
    async fn inv13_an_unlabelled_delegate_is_still_a_node() {
        let _guard = isolated();
        let (_root, transcript) = project(&[fixture("bare", json!({ "toolUseId": "t1" }))]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].agent_type, "agent");
        assert_eq!(tree.children[0].description, "");
        // `spawnDepth: 1` is what a delegate of the session itself carries, and
        // is the only depth that can be assumed when none is recorded.
        assert_eq!(tree.children[0].depth, 1);
        assert_eq!(tree.children[0].parent_agent_id, None);
    }

    #[tokio::test]
    async fn inv13_returns_an_empty_tree_when_nothing_was_delegated() {
        let _guard = isolated();
        let root = tempfile::tempdir().expect("temp dir");
        let transcript = root.path().join("sess-1.jsonl");
        std::fs::write(&transcript, b"").expect("transcript");

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(tree.session_id, "sess-1");
        assert!(tree.children.is_empty());
        // Empty is a claim; this app is entitled to make it here.
        assert_eq!(tree.unknown, None);
    }

    /*
     * INV-11's rule, which is why this is not the same answer as the one above.
     * The files this reads are written by Claude Code, so for a CLI that keeps
     * no transcript there is nothing to read — and "has not delegated" would be
     * a claim nobody checked.
     */
    #[tokio::test]
    async fn inv13_reports_unknown_not_empty_for_a_cli_with_no_transcript() {
        let _guard = isolated();
        let kiro = Agent { agent_kind: "kiro".into(), ..agent() };

        let tree = read_tree_at(&kiro, None, NOW).await;

        assert!(tree.children.is_empty());
        assert_eq!(tree.unknown, Some(true));
    }

    /// INV-4: no transcript tail — and so no project-directory scan — for a CLI
    /// that keeps none. The answer is `unknown` before any path is resolved.
    #[tokio::test]
    async fn inv4_no_transcript_lookup_for_a_cli_with_no_transcripts() {
        let _guard = isolated();
        let kiro = Agent { agent_kind: "kiro".into(), ..agent() };

        // A root that does not exist: reaching the filesystem at all would be
        // the scan this refuses to do, and the answer is the same either way.
        let tree = read_tree_in(&kiro, Path::new("/nonexistent-projects-root"), NOW).await;

        assert_eq!(tree.unknown, Some(true));
        assert!(tree.children.is_empty());
    }

    /// A kind this app has never heard of is denied by default, the same way
    /// every other capability lookup denies it.
    #[tokio::test]
    async fn inv13_an_unknown_cli_is_unknown_not_empty() {
        let _guard = isolated();
        let odd = Agent { agent_kind: "gemini".into(), ..agent() };

        let tree = read_tree_at(&odd, None, NOW).await;

        assert_eq!(tree.unknown, Some(true));
    }

    /// A session that has delegated nothing has no `subagents/` directory at
    /// all, which is an empty tree rather than an error (INV-5).
    #[tokio::test]
    async fn inv5_a_missing_subagents_directory_is_an_empty_tree() {
        let _guard = isolated();
        let root = tempfile::tempdir().expect("temp dir");
        let transcript = root.path().join("sess-1.jsonl");
        std::fs::write(&transcript, b"").expect("transcript");

        let tree = read_tree_in(&agent(), root.path(), NOW).await;

        assert!(tree.children.is_empty());
        assert_eq!(tree.unknown, None);
    }

    /* ---- INV-13: a state claims only what is known ---- */

    /*
     * `active` is a guess: a recent write plus a busy parent. It is marked as
     * one so the view can never draw it beside an evidenced `done` as an equal
     * — the same device the fleet card uses for `statusInferred`.
     */
    #[tokio::test]
    async fn inv13_marks_a_recently_written_delegate_of_a_busy_agent_as_inferred() {
        let _guard = isolated();
        let (_root, transcript) = project(&[Fixture {
            id: "a1",
            meta: Some(json!({ "agentType": "x", "description": "y", "spawnDepth": 1 }).to_string()),
            wrote_ago: Some(3_000),
            bytes: 10,
        }]);

        let tree = read_tree_at(&busy(), Some(&transcript), NOW).await;

        assert_eq!(tree.children[0].state, SubagentState::Active);
        assert_eq!(tree.children[0].state_inferred, Some(true));
    }

    /*
     * The rule that removed a feature elsewhere in this app, applied here. An
     * agent that finished and an agent that died both stop writing, and no
     * timestamp separates them — so silence is `quiet`, never `done`.
     */
    #[tokio::test]
    async fn inv13_quiet_is_never_reported_as_done() {
        // Far past any window that could still call a delegate active, so what
        // is left to judge is the silence itself.
        const SILENT_FOR_MS: i64 = 30 * 60_000;

        let _guard = isolated();
        let (_root, transcript) = project(&[Fixture {
            id: "a1",
            meta: Some(json!({ "agentType": "x", "description": "y", "spawnDepth": 1 }).to_string()),
            wrote_ago: Some(SILENT_FOR_MS),
            bytes: 10,
        }]);

        let tree = read_tree_at(&busy(), Some(&transcript), NOW).await;

        assert_eq!(tree.children[0].state, SubagentState::Quiet);
        assert_ne!(tree.children[0].state, SubagentState::Done);
        // `quiet` is the honest answer, not a guess: marking it would imply a
        // better one exists.
        assert_eq!(tree.children[0].state_inferred, None);
    }

    // A parent that is not working cannot have a delegate that is, however
    // recently that delegate's file was touched.
    #[tokio::test]
    async fn inv13_does_not_call_a_delegate_active_while_its_parent_is_idle() {
        let _guard = isolated();
        let (_root, transcript) = project(&[Fixture {
            id: "a1",
            meta: Some(json!({ "agentType": "x", "description": "y", "spawnDepth": 1 }).to_string()),
            wrote_ago: Some(1_000),
            bytes: 10,
        }]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(tree.children[0].state, SubagentState::Quiet);
        assert_eq!(tree.children[0].state_inferred, None);
    }

    /// The boundary itself: 90s is the window, and a write at exactly that age
    /// is outside it.
    #[tokio::test]
    async fn inv13_the_active_window_is_ninety_seconds() {
        let _guard = isolated();
        let meta = json!({ "agentType": "x", "description": "y", "spawnDepth": 1 }).to_string();
        let (_root, transcript) = project(&[
            Fixture { id: "inside", meta: Some(meta.clone()), wrote_ago: Some(89_999), bytes: 10 },
            Fixture { id: "outside", meta: Some(meta), wrote_ago: Some(90_000), bytes: 10 },
        ]);

        let tree = read_tree_at(&busy(), Some(&transcript), NOW).await;

        assert_eq!(find(&tree.children, "inside").unwrap().state, SubagentState::Active);
        assert_eq!(find(&tree.children, "outside").unwrap().state, SubagentState::Quiet);
    }

    /// Evidence beats recency in both directions: a stopped delegate that wrote
    /// a second ago under a busy parent is `done`, not `active`.
    #[tokio::test]
    async fn inv13_stopped_by_user_wins_over_a_recent_write() {
        let _guard = isolated();
        let (_root, transcript) = project(&[Fixture {
            id: "a1",
            meta: Some(
                json!({ "agentType": "x", "description": "y", "spawnDepth": 1, "stoppedByUser": true })
                    .to_string(),
            ),
            wrote_ago: Some(1_000),
            bytes: 10,
        }]);

        let tree = read_tree_at(&busy(), Some(&transcript), NOW).await;

        assert_eq!(tree.children[0].state, SubagentState::Done);
        assert_eq!(tree.children[0].state_inferred, None);
    }

    #[tokio::test]
    async fn inv13_reports_transcript_size_as_a_size() {
        // A transcript with real content in it, so the size that comes back is
        // the file's own rather than a default nobody set.
        const WROTE_BYTES: usize = 4096;

        let _guard = isolated();
        let (_root, transcript) = project(&[Fixture {
            id: "a1",
            meta: Some(json!({ "agentType": "x", "description": "y", "spawnDepth": 1 }).to_string()),
            wrote_ago: None,
            bytes: WROTE_BYTES,
        }]);

        let tree = read_tree_at(&busy(), Some(&transcript), NOW).await;

        assert_eq!(tree.children[0].bytes, WROTE_BYTES as u64);
    }

    /// Oldest first, so a tree reads in the order the work was handed out.
    #[tokio::test]
    async fn inv13_orders_a_tree_oldest_first() {
        let _guard = isolated();
        let meta = |parent: Option<&str>| match parent {
            Some(p) => json!({ "agentType": "x", "spawnDepth": 2, "parentAgentId": p }).to_string(),
            None => json!({ "agentType": "x", "spawnDepth": 1 }).to_string(),
        };
        let (_root, transcript) = project(&[
            Fixture { id: "late", meta: Some(meta(None)), wrote_ago: Some(1_000), bytes: 10 },
            Fixture { id: "early", meta: Some(meta(None)), wrote_ago: Some(600_000), bytes: 10 },
            Fixture { id: "kid-b", meta: Some(meta(Some("late"))), wrote_ago: Some(2_000), bytes: 10 },
            Fixture { id: "kid-a", meta: Some(meta(Some("late"))), wrote_ago: Some(9_000), bytes: 10 },
        ]);

        let tree = read_tree_at(&agent(), Some(&transcript), NOW).await;

        assert_eq!(ids(&tree.children), vec!["early", "late"]);
        assert_eq!(ids(&find(&tree.children, "late").unwrap().children), vec!["kid-a", "kid-b"]);
    }

    /// The wire shape, which is the actual contract: absent is absent, never
    /// `null` (see `tests/golden/tree.json`).
    #[test]
    fn the_wire_omits_every_absent_field() {
        let quiet = SubagentNode {
            agent_id: "af0e1cdf1ec262236".into(),
            agent_type: "code-reviewer".into(),
            description: "Review the diff for correctness".into(),
            depth: 1,
            parent_agent_id: None,
            last_write_at: 1_788_061_902_713,
            bytes: 118_000,
            state: SubagentState::Quiet,
            state_inferred: None,
            stopped_by_user: None,
            reparented: None,
            children: Vec::new(),
        };
        let tree = AgentTree {
            session_id: "mock-long-name".into(),
            children: vec![quiet],
            unknown: None,
        };
        let wire = serde_json::to_value(&tree).expect("serialises");
        assert_eq!(
            wire,
            json!({
                "sessionId": "mock-long-name",
                "children": [{
                    "agentId": "af0e1cdf1ec262236",
                    "agentType": "code-reviewer",
                    "description": "Review the diff for correctness",
                    "depth": 1,
                    "lastWriteAt": 1_788_061_902_713_i64,
                    "bytes": 118_000,
                    "state": "quiet",
                    "children": [],
                }],
            })
        );
    }

    /// Sidecars are cached by path for the life of the process, because they
    /// are written once and never touched again. Only the transcript is
    /// re-`stat`ed, which is what keeps this cheap enough to poll (INV-4).
    #[tokio::test]
    async fn inv4_a_sidecar_is_read_once_and_cached_by_path() {
        let _guard = isolated();
        let (root, transcript) = project(&[fixture(
            "a1",
            json!({ "agentType": "first", "description": "y", "spawnDepth": 1 }),
        )]);

        let before = read_tree_at(&agent(), Some(&transcript), NOW).await;
        assert_eq!(before.children[0].agent_type, "first");

        // Rewritten on disk, and deliberately not re-read.
        let sidecar = root.path().join("sess-1/subagents/agent-a1.meta.json");
        std::fs::write(&sidecar, json!({ "agentType": "second" }).to_string()).expect("rewrite");
        let cached = read_tree_at(&agent(), Some(&transcript), NOW).await;
        assert_eq!(cached.children[0].agent_type, "first");

        // …until the seam the tests use says to forget it.
        forget_sidecars();
        let fresh = read_tree_at(&agent(), Some(&transcript), NOW).await;
        assert_eq!(fresh.children[0].agent_type, "second");
    }
}
