//! HTTP + WebSocket surface. Port of `src/server/routes.ts`.
//!
//! One WebSocket per browser tab. The tab declares which agent it is looking
//! at (`focus`) and whether the terminal view is open (`attach`); the server
//! only polls what is actually being watched (INV-4).
//!
//! Two things differ structurally from the Node original and are worth knowing
//! before reading:
//!
//!   * Node dispatches by hand inside one request listener, so this uses a
//!     single axum fallback handler rather than a route table. Matching the
//!     wire byte for byte matters more than idiomatic routing: the TS answers
//!     `GET /api/agents` for every method that is not POST, falls back to
//!     `index.html` for extensionless paths, and 404s everything else. A
//!     `Router` with per-method routes would answer 405 where the TS answers
//!     200, and the React client is the consumer.
//!   * A JS callback can send on a socket from anywhere; a Rust one cannot
//!     await. Every viewer therefore owns an unbounded channel and a writer
//!     task, so the pane-hub listener and the transcript pump both stay
//!     synchronous at the point they produce a message.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::JoinHandle;

use crate::frames::{build_frame, is_noop};
use crate::options::Options;
use crate::pane_hub::HubEvent;
use crate::sources::{Deps, PaneApi, TailApi, Unsubscribe};
use crate::types::{
    Agent, ClientMessage, ControlResponse, DirListing, Geom,
    GoalState, NewAgentRequest, NewAgentResponse, ServerEnv, ServerMessage,
};

/// How often a focused tab's transcript is re-read.
const TIMELINE_MS: u64 = 1000;

/// How many reads in a row may fail before the terminal gives up.
///
/// It used to be one. A pane read fails for two very different reasons — the
/// pane is gone, or this machine could not spare a process to ask about it —
/// and treating them the same meant a transient `spawn tmux EAGAIN`, which is
/// ordinary on a machine at its process cap, stopped the user's terminal until
/// they thought to close and re-open it. A dead pane is still reported at
/// once, because that is answered from the pane's own `dead` flag rather than
/// from a failure.
const FRAME_FAIL_LIMIT: u32 = 5;

/// What the user is told when the process behind the pane has exited.
///
/// Answered from `PaneMeta::dead` — the pane's own flag — rather than from a
/// failed read, which is why it is immediate while a failure has to happen
/// `FRAME_FAIL_LIMIT` times first. The two are not the same event and must not
/// be reported as though they were.
pub const DEAD_PANE: &str = "pane has exited";

/// The guards INV-2, INV-6 and INV-12 are made of.
///
/// They live in `control.rs` rather than here, unlike the TypeScript where
/// `routes.ts` holds them, so that the rule and its tests sit next to the
/// other rules about reaching a live agent. This file is where they are
/// *applied*: a guard that is never called is worse than no guard, because the
/// tests still pass. Every inbound `key` goes through `check_key`, every
/// `paste` through `MAX_PASTE` and the budget, and both through `afford`.
use crate::control::{check_key, MAX_FRAME_BYTES, MAX_PASTE, TOO_MUCH_INPUT};

/// The most a JSON request body may be.
const MAX_BODY: usize = 8 * 1024;

const MIME_JSON: &str = "application/json; charset=utf-8";

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => MIME_JSON,
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/* -------------------------------------------------------------------------
 * Seams the sibling modules plug into.
 *
 * `sources.rs` covers the fleet, the panes, the quota and the transcripts.
 * The three surfaces below — starting an agent, listing directories, driving
 * a live session — have no trait there, and the TS injected them as optional
 * callbacks on `ServeOptions` for exactly the reasons they are traits here:
 * mock mode substitutes them wholesale, and the tests need a server that
 * touches nothing real.
 * ---------------------------------------------------------------------- */

/// A failure with a caller/server distinction, which is what picks 400 vs 500.
#[derive(Debug, Clone)]
pub struct Failure {
    pub message: String,
    /// True when the caller got it wrong: `SpawnError`, `SpawnOptionError`,
    /// `ControlError` and `BrowseError` in the TS.
    pub known: bool,
}

impl Failure {
    pub fn caller(message: impl Into<String>) -> Self {
        Self { message: message.into(), known: true }
    }
    pub fn server(message: impl Into<String>) -> Self {
        Self { message: message.into(), known: false }
    }
}

#[derive(Debug, Clone)]
pub struct SpawnResult {
    pub tmux_session: String,
    pub cwd: String,
}

#[async_trait]
pub trait SpawnApi: Send + Sync + 'static {
    async fn start(&self, req: NewAgentRequest) -> Result<SpawnResult, Failure>;
}

#[async_trait]
pub trait BrowseApi: Send + Sync + 'static {
    async fn list_dirs(
        &self,
        path: Option<String>,
        root: Option<String>,
        include_hidden: bool,
    ) -> Result<DirListing, Failure>;
}

/// Outcome of `setMode`: `ok` false means the session never got there.
#[derive(Debug, Clone, Default)]
pub struct ModeOutcome {
    pub ok: bool,
    pub mode: Option<String>,
}

/// Outcome of `setGoal`: `ok` false means nothing recorded it.
#[derive(Debug, Clone, Default)]
pub struct GoalOutcome {
    pub ok: bool,
    pub goal: Option<GoalState>,
}

/// Close, mode, model and goal. Each refuses a busy agent inside `control` (INV-8).
///
/// Every method takes the agent as an `Option`, because the TS passes whatever
/// `source.get` returned — including `undefined` — and lets `control.ts` be the
/// one place that decides an unknown session is an error. The session id comes
/// separately for the same reason it does in the TS: the mode and goal readers
/// are built from the id in the URL, which is known even when the fleet has no
/// agent under it.
#[async_trait]
pub trait ControlApi: Send + Sync + 'static {
    /// Returns true when the session had to be forced.
    async fn close(&self, session_id: &str, agent: Option<Agent>) -> Result<bool, Failure>;
    async fn set_mode(
        &self,
        session_id: &str,
        agent: Option<Agent>,
        value: String,
    ) -> Result<ModeOutcome, Failure>;
    async fn set_model(
        &self,
        session_id: &str,
        agent: Option<Agent>,
        value: String,
    ) -> Result<(), Failure>;
    async fn set_goal(
        &self,
        session_id: &str,
        agent: Option<Agent>,
        value: String,
    ) -> Result<GoalOutcome, Failure>;
    async fn clear_goal(&self, session_id: &str, agent: Option<Agent>) -> Result<(), Failure>;
}

/// Shows a just-started session until it registers itself.
pub trait PendingApi: Send + Sync + 'static {
    fn add(&self, tmux_session: &str, cwd: &str, name: Option<&str>);
}

impl PendingApi for crate::pending::PendingStore {
    fn add(&self, tmux_session: &str, cwd: &str, name: Option<&str>) {
        crate::pending::PendingStore::add(self, tmux_session, cwd, name)
    }
}

/// One poll per pane, however many browser tabs are watching it (INV-4).
///
/// `pane_hub.rs` owns the loop, the backoff and the wake-on-write behaviour.
/// This is only the shape `routes` needs from it, so a test can stand in a hub
/// that produces exactly the samples and failures it wants to prove something
/// about. The event is passed by reference and the sample behind an `Arc`,
/// because one read is delivered to every tab watching that pane and a 47-row
/// capture handed to three of them should be three pointers.
pub trait HubApi: Send + Sync + 'static {
    /// Watch a pane. Call the returned handle to stop; dropping it is not enough.
    fn subscribe(
        &self,
        pane_id: &str,
        listener: Box<dyn Fn(&HubEvent) + Send + Sync>,
    ) -> Unsubscribe;
    /// Poll this pane at full speed again, because something just changed it.
    fn wake(&self, pane_id: &str);
}

impl HubApi for crate::pane_hub::PaneHub {
    fn subscribe(
        &self,
        pane_id: &str,
        listener: Box<dyn Fn(&HubEvent) + Send + Sync>,
    ) -> Unsubscribe {
        crate::pane_hub::PaneHub::subscribe(self, pane_id, listener)
    }
    fn wake(&self, pane_id: &str) {
        crate::pane_hub::PaneHub::wake(self, pane_id)
    }
}

/* ------------------------------------------------------------------------- */

/// Everything the HTTP and WebSocket surface is built out of.
pub struct App {
    pub deps: Deps,
    pub hub: Arc<dyn HubApi>,
    pub mock: bool,
    pub web_root: PathBuf,
    pub token: Option<String>,
    pub env: ServerEnv,
    /// Root the folder browser is confined to; `None` means the home directory.
    pub browse_root: Option<String>,
    pub spawn: Arc<dyn SpawnApi>,
    pub browse: Arc<dyn BrowseApi>,
    pub control: Arc<dyn ControlApi>,
    pub pending: Option<Arc<dyn PendingApi>>,
}

/* -------------------------------------------------------------------------
 * INV-3.
 * ---------------------------------------------------------------------- */

/// Constant-time compare, so a token cannot be recovered a byte at a time.
fn safe_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        // Length is not secret — the TS short-circuits on it too, and
        // `ct_eq` needs equal-length slices.
        return false;
    }
    a.ct_eq(b).into()
}

/// Percent-decoding for one query component, `+` included, as `URLSearchParams` does.
fn decode_component(raw: &str) -> String {
    let plus = raw.replace('+', " ");
    percent_encoding::percent_decode_str(&plus).decode_utf8_lossy().into_owned()
}

/// First value for `key` in a raw query string.
fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if decode_component(k) == key {
            return Some(decode_component(v));
        }
    }
    None
}

/// Pull the hostname out of an Origin or a Host header, brackets stripped.
///
/// Node hands this to `new URL()`, which refuses anything malformed; this
/// returns `None` in the same places, because "unparseable" and "not a
/// loopback name" must reach the same conclusion.
fn hostname_of(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    let rest = match value.find("://") {
        Some(i) => &value[i + 3..],
        None => value,
    };
    // The authority ends at the first path, query or fragment delimiter.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Userinfo, if any, is everything before the last '@'.
    let authority = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    if authority.is_empty() {
        return None;
    }
    if let Some(inner) = authority.strip_prefix('[') {
        // `[::1]:4317` — the brackets are what make a bare IPv6 literal legal
        // in a URL, and `new URL().hostname` keeps them, so the TS strips them
        // with a regex. Same result, one step earlier.
        let end = inner.find(']')?;
        let host = &inner[..end];
        if host.is_empty() {
            return None;
        }
        return Some(host.to_ascii_lowercase());
    }
    let mut parts = authority.split(':');
    let host = parts.next().unwrap_or("");
    match parts.next() {
        // A second colon without brackets is not a URL Node would parse, and a
        // non-numeric port is not one either. Both are `null` there.
        Some(port) => {
            if parts.next().is_some() || !port.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
        }
        None => {}
    }
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// The only names a tokenless server can legitimately be reached at (INV-3).
fn is_loopback_name(hostname: &str) -> bool {
    if hostname == "localhost" || hostname == "::1" {
        return true;
    }
    // ^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$
    let mut parts = hostname.split('.');
    if parts.next() != Some("127") {
        return false;
    }
    let rest: Vec<&str> = parts.collect();
    rest.len() == 3
        && rest.iter().all(|p| {
            !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit())
        })
}

/// INV-3's other half: a browser is not a stranger on the network.
///
/// Binding 127.0.0.1 keeps the network out, but it does nothing about the one
/// program guaranteed to be running on this machine. WebSockets are exempt
/// from CORS entirely, and a POST with a `text/plain` content type is a CORS
/// "simple request" that is sent without a preflight — so before this check,
/// any page on any origin could open `ws://127.0.0.1:4317/ws`, read the whole
/// fleet, and paste a command plus Enter into a live agent. That is arbitrary
/// code execution by way of a visited web page.
///
/// Two headers, because they answer different questions:
///
///   * `Origin` names the page making the request. Browsers always send it on
///     a WebSocket handshake and on any cross-origin request, and never let a
///     page forge it. Absent means a non-browser client (curl, a test, a
///     native app), which is not the threat this guards.
///   * `Host` names what the client asked for. Checking it too is what stops
///     DNS rebinding, where `evil.example` is re-pointed at 127.0.0.1 and the
///     origin then matches the host perfectly — both say `evil.example`, and
///     only the fact that it is not a loopback name gives it away.
///
/// Only tokenless servers are gated. A configured token is already proof of
/// intent that neither a cross-origin page nor a rebound name can produce: it
/// lives in the URL of the real origin, and an attacker who cannot read that
/// origin cannot supply it. That is also what keeps the Tailscale flow
/// working, where the app is legitimately reached at a name that is not
/// loopback and INV-3 already requires `--token`.
fn same_origin_request(headers: &HeaderMap) -> bool {
    if let Some(origin) = headers.get(header::ORIGIN) {
        // A sandboxed iframe or a file:// page sends the literal "null". It
        // parses as a hostname of that name, which is not a loopback one, so
        // it is refused by the same line as anything else foreign.
        match hostname_of(origin.to_str().ok()) {
            Some(from) if is_loopback_name(&from) => {}
            _ => return false,
        }
    }
    match hostname_of(headers.get(header::HOST).and_then(|v| v.to_str().ok())) {
        Some(asked) => is_loopback_name(&asked),
        None => false,
    }
}

impl App {
    fn authorized(&self, query: &str, headers: &HeaderMap) -> bool {
        let Some(token) = self.token.as_deref() else {
            return true;
        };
        let from_query = query_param(query, "token");
        let from_header = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_string);
        match from_query.or(from_header) {
            Some(supplied) => safe_equal(&supplied, token),
            None => false,
        }
    }

    /// True when this request may act at all: the token, or same-origin loopback.
    fn permitted(&self, headers: &HeaderMap) -> bool {
        self.token.is_some() || same_origin_request(headers)
    }
}

/* -------------------------------------------------------------------------
 * Dispatch.
 * ---------------------------------------------------------------------- */

pub fn router(app: Arc<App>) -> Router {
    Router::new().fallback(dispatch).with_state(app)
}

fn text(status: StatusCode, body: &'static str) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain")], body).into_response()
}

fn json(status: StatusCode, body: serde_json::Value) -> Response {
    (status, [(header::CONTENT_TYPE, MIME_JSON)], serde_json::to_string(&body).unwrap_or_default())
        .into_response()
}

fn json_of<T: serde::Serialize>(status: StatusCode, body: &T) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, MIME_JSON)],
        serde_json::to_string(body).unwrap_or_else(|_| "null".into()),
    )
        .into_response()
}

/// Whether this request is asking to become a WebSocket.
///
/// Node routes these to the `upgrade` event rather than the request handler,
/// which is why the TS gate lives in two places; axum sees one request, so
/// this is what tells the two apart.
fn is_upgrade(headers: &HeaderMap) -> bool {
    headers.get(header::UPGRADE).is_some()
}

async fn dispatch(State(app): State<Arc<App>>, req: Request<Body>) -> Response {
    let (mut parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    let query = parts.uri.query().unwrap_or("").to_string();
    let method = parts.method.clone();
    let upgrading = is_upgrade(&parts.headers);

    // The upgrade path gets the same gate as HTTP, in the same order the TS
    // applies it: an upgrade aimed anywhere but `/ws` is answered 401 there
    // before the origin is ever considered, so it is answered 401 here too.
    if !app.authorized(&query, &parts.headers) || (upgrading && path != "/ws") {
        return text(StatusCode::UNAUTHORIZED, "unauthorized: append ?token=... to the URL");
    }
    // The socket is the whole control surface — fleet contents out, pastes and
    // keys in — and CORS does not apply to it, so it gets the same gate.
    if !app.permitted(&parts.headers) {
        return text(
            StatusCode::FORBIDDEN,
            "forbidden: this server answers only same-origin requests from localhost.\n\
             Reach it at http://127.0.0.1, or start it with --token to use another name.",
        );
    }

    if path == "/ws" && upgrading {
        let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(u) => u,
            Err(rejection) => return rejection.into_response(),
        };
        let app = app.clone();
        return upgrade
            // Both bounds, because a message can be split across frames: the
            // frame cap bounds one read, the message cap bounds what they add
            // up to. Either one alone leaves the other unbounded.
            .max_frame_size(MAX_FRAME_BYTES)
            .max_message_size(MAX_FRAME_BYTES)
            .on_upgrade(move |socket| handle_socket(socket, app));
    }

    if path == "/api/agents" && method != Method::POST {
        return json(
            StatusCode::OK,
            serde_json::json!({ "agents": app.deps.source.list(), "mock": app.mock }),
        );
    }
    if path == "/api/env" {
        return json_of(StatusCode::OK, &app.env);
    }
    if path == "/api/agents" && method == Method::POST {
        return handle_new_agent(&app, body).await;
    }
    if path == "/api/dirs" {
        return handle_browse(&app, &query).await;
    }
    if let Some((session_id, action)) = control_route(&path) {
        if method == Method::POST {
            return handle_control(&app, body, &session_id, &action).await;
        }
    }
    serve_static(&app, &path).await
}

/// `^/api/agents/([^/]+)/(close|mode|model|goal)$`, with the id decoded.
fn control_route(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/api/agents/")?;
    let (id, action) = rest.rsplit_once('/')?;
    if id.is_empty() || id.contains('/') {
        return None;
    }
    if !matches!(action, "close" | "mode" | "model" | "goal") {
        return None;
    }
    Some((decode_component(id), action.to_string()))
}

/* -------------------------------------------------------------------------
 * Static files.
 * ---------------------------------------------------------------------- */

/// Node's `path.normalize`, lexically: `.` dropped, `..` popped, no filesystem.
fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => match out.last() {
                // At the root `..` has nowhere to go and is dropped, which is
                // what makes `/../../etc/passwd` resolve to `/etc/passwd`.
                Some(&"..") => out.push(".."),
                Some(_) => {
                    out.pop();
                }
                None => {
                    if !absolute {
                        out.push("..");
                    }
                }
            },
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// True when `candidate` is the root itself or sits underneath it.
///
/// A path-segment check, not a string prefix — the same standard INV-9 holds
/// the folder browser to. `starts_with` on strings says `/app/dist/web-backup`
/// is inside `/app/dist/web`, and a web root with a sibling that shares its
/// name as a prefix is not an exotic arrangement. `Path::starts_with` compares
/// whole components, which is exactly the property wanted.
fn is_inside(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

async fn serve_static(app: &App, pathname: &str) -> Response {
    let rel = normalize(if pathname == "/" { "/index.html" } else { pathname });
    // Leading `../` that survived normalisation can only come from a relative
    // path; strip it rather than letting `join` act on it.
    let mut trimmed = rel.as_str();
    while let Some(next) = trimmed.strip_prefix("../") {
        trimmed = next;
    }
    // Unlike Node's `path.join`, `PathBuf::join` on an absolute component
    // *replaces* the root instead of appending to it. Dropping the leading
    // slash first is what keeps `/etc/passwd` meaning `<root>/etc/passwd`.
    let file = app.web_root.join(trimmed.trim_start_matches('/'));

    if !is_inside(&app.web_root, &file) {
        return text(StatusCode::FORBIDDEN, "forbidden");
    }

    // `normalize("/index.html")` keeps its leading slash, so match both forms.
    let is_document = trimmed == "index.html" || trimmed == "/index.html";
    if let Some(res) = send_file(&file, is_document && app.mock).await {
        return res;
    }

    // Single-page app fallback: /agent/<id> is a client route, not a file.
    // Only extensionless paths fall through, so a genuinely missing asset
    // still 404s.
    if Path::new(trimmed).extension().is_none() {
        if let Some(res) = send_file(&app.web_root.join("index.html"), app.mock).await {
            return res;
        }
    }

    text(StatusCode::NOT_FOUND, "not found — run `npm run build:web` first")
}

async fn send_file(file: &Path, stamp_mock: bool) -> Option<Response> {
    let meta = tokio::fs::metadata(file).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = tokio::fs::read(file).await.ok()?;

    // The mock banner used to arrive with the first WebSocket frame, after the
    // page had already painted, and inserting it pushed the entire layout down
    // 28px — a measured CLS of 0.121, all of it from that one shift. Stamping
    // the mode into the document means React's first render already has the
    // banner, so nothing moves. The document is ~3KB, so rewriting one
    // attribute costs nothing next to serving it.
    if stamp_mock {
        let html = String::from_utf8_lossy(&bytes).replacen("<html ", "<html data-mock=\"true\" ", 1);
        return Some(
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, HeaderValue::from_static("text/html"))],
                html,
            )
                .into_response(),
        );
    }

    Some(
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, HeaderValue::from_static(mime_for(file)))],
            bytes,
        )
            .into_response(),
    )
}

/* -------------------------------------------------------------------------
 * JSON endpoints.
 * ---------------------------------------------------------------------- */

/// Read a small JSON body, refusing anything oversized.
async fn read_json(body: Body) -> Result<serde_json::Value, Failure> {
    let bytes: Bytes = axum::body::to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| Failure::server("request body too large"))?;
    serde_json::from_slice(&bytes).map_err(|e| Failure::server(e.to_string()))
}

async fn handle_new_agent(app: &App, body: Body) -> Response {
    if !app.env.tmux {
        return json_of(
            StatusCode::CONFLICT,
            &NewAgentResponse::err("tmux is not available on this machine"),
        );
    }
    let parsed = match read_json(body).await {
        Ok(v) => v,
        Err(f) => {
            return json_of(
                if f.known { StatusCode::BAD_REQUEST } else { StatusCode::INTERNAL_SERVER_ERROR },
                &NewAgentResponse::err(f.message),
            )
        }
    };
    if !parsed.get("cwd").map(|v| v.is_string()).unwrap_or(false) {
        return json_of(StatusCode::BAD_REQUEST, &NewAgentResponse::err("cwd is required"));
    }
    let req: NewAgentRequest = match serde_json::from_value(parsed) {
        Ok(r) => r,
        Err(e) => return json_of(StatusCode::BAD_REQUEST, &NewAgentResponse::err(e.to_string())),
    };
    let name = req.name.clone();

    // Model and mode travel with the request. Dropping them here meant a user
    // who chose "plan" and "opus" got a default agent with no error at all —
    // and silently starting a session in a *different* permission mode than
    // the one asked for is the wrong way round to be wrong.
    match app.spawn.start(req).await {
        Ok(result) => {
            if let Some(pending) = &app.pending {
                pending.add(&result.tmux_session, &result.cwd, name.as_deref());
            }
            json_of(StatusCode::OK, &NewAgentResponse::ok(result.tmux_session, result.cwd))
        }
        // A rejected model or mode is the caller's mistake, not the server's,
        // and the dialog renders a 400 as a reason it can show next to the field.
        Err(f) => json_of(
            if f.known { StatusCode::BAD_REQUEST } else { StatusCode::INTERNAL_SERVER_ERROR },
            &NewAgentResponse::err(f.message),
        ),
    }
}

async fn handle_browse(app: &App, query: &str) -> Response {
    let path = query_param(query, "path");
    let hidden = query_param(query, "hidden").as_deref() == Some("1");
    match app.browse.list_dirs(path, app.browse_root.clone(), hidden).await {
        Ok(listing) => json_of(StatusCode::OK, &listing),
        Err(f) => json(
            if f.known { StatusCode::BAD_REQUEST } else { StatusCode::INTERNAL_SERVER_ERROR },
            serde_json::json!({ "error": f.message }),
        ),
    }
}

/// `String(body?.value ?? '')` — the TS coerces, so a number is not an error.
fn value_of(body: &serde_json::Value) -> String {
    match body.get("value") {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Close, mode, model and goal. Each refuses a busy agent inside `control` (INV-8).
async fn handle_control(app: &App, body: Body, session_id: &str, action: &str) -> Response {
    let agent = app.deps.source.get(session_id);

    let result: Result<ControlResponse, (StatusCode, Failure)> = async {
        if action == "close" {
            let forced = app.control.close(session_id, agent).await.map_err(fail)?;
            return Ok(ControlResponse::ok(Some(
                if forced { "forced" } else { "exited" }.to_string(),
            )));
        }

        let parsed = read_json(body).await.map_err(fail)?;
        let value = value_of(&parsed);

        if action == "goal" {
            // An empty value is the toggle being turned off, not a malformed set.
            if value.trim().is_empty() {
                app.control.clear_goal(session_id, agent).await.map_err(fail)?;
                // Nothing records a cleared goal, so this is the only place
                // that knows it happened — see `clear_goal`.
                let mut patch = crate::sources::AgentPatch::default();
                patch.goal = Some(None);
                app.deps.source.enrich(session_id, patch);
                app.deps.source.notify();
                return Ok(ControlResponse::ok(Some("cleared".to_string())));
            }
            let outcome = app.control.set_goal(session_id, agent, value.clone()).await.map_err(fail)?;
            if !outcome.ok {
                return Err((
                    StatusCode::CONFLICT,
                    Failure::caller(
                        "the session did not record the goal — it may not have been at its prompt",
                    ),
                ));
            }
            if let Some(goal) = &outcome.goal {
                // Publish it now rather than leaving the card a tick behind
                // the toggle that just set it.
                let mut patch = crate::sources::AgentPatch::default();
                patch.goal = Some(Some(goal.clone()));
                app.deps.source.enrich(session_id, patch);
                app.deps.source.notify();
            }
            let detail = outcome.goal.map(|g| g.condition).unwrap_or(value);
            return Ok(ControlResponse::ok(Some(detail)));
        }

        if action == "model" {
            app.control.set_model(session_id, agent, value.clone()).await.map_err(fail)?;
            return Ok(ControlResponse::ok(Some(value)));
        }

        let outcome = app.control.set_mode(session_id, agent, value.clone()).await.map_err(fail)?;
        if !outcome.ok {
            let where_it_is = outcome.mode.unwrap_or_else(|| "an unknown mode".to_string());
            return Err((
                StatusCode::CONFLICT,
                Failure::caller(format!("could not reach {value}; the session is in {where_it_is}")),
            ));
        }
        Ok(ControlResponse::ok(Some(outcome.mode.unwrap_or(value))))
    }
    .await;

    match result {
        Ok(body) => json_of(StatusCode::OK, &body),
        Err((status, f)) => json_of(status, &ControlResponse::err(f.message)),
    }
}

fn fail(f: Failure) -> (StatusCode, Failure) {
    let status =
        if f.known { StatusCode::BAD_REQUEST } else { StatusCode::INTERNAL_SERVER_ERROR };
    (status, f)
}

/* -------------------------------------------------------------------------
 * One browser tab.
 * ---------------------------------------------------------------------- */

/// The half of a viewer that changes, behind one lock.
///
/// A `std::sync::Mutex` and not tokio's: it is taken by the pane-hub listener,
/// which is a plain `Fn` and cannot await, and it is never held across an
/// await anywhere else. Making it async would push the problem into the
/// listener rather than solving it.
struct ViewerState {
    focused: Option<String>,
    attached: bool,
    prev_lines: Option<Vec<String>>,
    prev_cursor: Option<(usize, usize)>,
    /// Consecutive failed reads, reset by any successful one.
    frame_fails: u32,
    /// Releases this tab's share of the pane poller; see `HubApi`.
    unwatch: Option<Unsubscribe>,
    tail_task: Option<JoinHandle<()>>,
}

struct Viewer {
    tx: UnboundedSender<ServerMessage>,
    state: Mutex<ViewerState>,
    /// INV-12: how much this tab may still ask of a live agent. Outside the
    /// state lock because it has its own, and because a refusal must not have
    /// to wait on a pane read holding that one.
    budget: crate::control::WriteBudget,
}

impl Viewer {
    fn new(tx: UnboundedSender<ServerMessage>) -> Self {
        Self {
            tx,
            state: Mutex::new(ViewerState {
                focused: None,
                attached: false,
                prev_lines: None,
                prev_cursor: None,
                frame_fails: 0,
                unwatch: None,
                tail_task: None,
            }),
            budget: crate::control::WriteBudget::default(),
        }
    }

    fn send(&self, msg: ServerMessage) {
        // A closed channel means the writer task is gone, which means the
        // socket is gone. Nothing to report and nobody to report it to.
        let _ = self.tx.send(msg);
    }

    fn error(&self, session_id: &str, message: impl Into<String>) {
        self.send(ServerMessage::Error {
            session_id: Some(session_id.to_string()),
            message: message.into(),
        });
    }

    fn clear_timers(&self) {
        self.clear_frame_timer();
        let task = self.state.lock().unwrap().tail_task.take();
        if let Some(task) = task {
            task.abort();
        }
    }

    /// Stop polling the pane, and only the pane.
    ///
    /// The terminal and the conversation are independent: one reads tmux, the
    /// other reads a file on disk. A dead pane used to take the transcript
    /// timer down with it, so answering "pane has exited" left the chat frozen
    /// for that tab until the agent was re-opened — and nothing said why.
    fn clear_frame_timer(&self) {
        let unwatch = self.state.lock().unwrap().unwatch.take();
        if let Some(unwatch) = unwatch {
            unwatch();
        }
    }
}

impl ViewerState {
    fn reset_pane(&mut self) {
        self.prev_lines = None;
        self.prev_cursor = None;
        self.frame_fails = 0;
    }
}

async fn handle_socket(socket: WebSocket, app: Arc<App>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();

    // Serialising here rather than at each call site keeps every producer —
    // the hub listener, the transcript pump, this loop — synchronous.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let Ok(text) = serde_json::to_string(&msg) else { continue };
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    let viewer = Arc::new(Viewer::new(tx));
    viewer.send(ServerMessage::Fleet { agents: app.deps.source.list(), mock: app.mock });

    let off = {
        let viewer = viewer.clone();
        let mock = app.mock;
        app.deps.source.on_change(Box::new(move |agents| {
            viewer.send(ServerMessage::Fleet { agents, mock });
        }))
    };

    // Quota is account-level, so every tab gets the same reading and a fresh
    // tab needs the current one immediately — waiting for the next statusline
    // render would leave the meters blank for however long the fleet is idle.
    viewer.send(ServerMessage::Limits { limits: app.deps.limits.current() });
    let off_limits = {
        let viewer = viewer.clone();
        app.deps.limits.on_change(Box::new(move |limits| {
            viewer.send(ServerMessage::Limits { limits });
        }))
    };

    while let Some(Ok(frame)) = stream.next().await {
        let raw = match frame {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
            Message::Close(_) => break,
            // Ping/Pong are answered by the transport.
            _ => continue,
        };
        // Anything that is not a message this server knows is dropped in
        // silence, exactly as `JSON.parse` failing does in the TS. Answering
        // would give an unauthenticated peer a parser to probe.
        let Ok(msg) = serde_json::from_str::<ClientMessage>(&raw) else { continue };
        handle(msg, &viewer, &app).await;
    }

    off();
    off_limits();
    viewer.clear_timers();
    writer.abort();
}

async fn handle(msg: ClientMessage, viewer: &Arc<Viewer>, app: &Arc<App>) {
    match msg {
        ClientMessage::Focus { session_id } => {
            viewer.clear_timers();
            {
                let mut st = viewer.state.lock().unwrap();
                st.attached = false;
                st.reset_pane();
                st.focused = session_id.clone();
            }
            let Some(session_id) = session_id else { return };
            let Some(agent) = app.deps.source.get(&session_id) else { return };
            let Some(tail) = (app.deps.tail_for)(&agent) else { return };

            // The TS arms a `setInterval` and guards it with a `tailBusy`
            // flag, because a read can outlast the interval. A task that
            // sleeps *after* each read cannot overlap with itself at all, so
            // the flag has nothing left to guard; the cost is that the period
            // is measured from the end of a read rather than its start.
            let task = {
                let viewer = viewer.clone();
                let app = app.clone();
                tokio::spawn(async move {
                    let mut tail = tail;
                    loop {
                        pump_timeline(&mut tail, &viewer, &app, &session_id).await;
                        tokio::time::sleep(Duration::from_millis(TIMELINE_MS)).await;
                    }
                })
            };
            let old = viewer.state.lock().unwrap().tail_task.replace(task);
            if let Some(old) = old {
                old.abort();
            }
        }

        ClientMessage::Attach { session_id, on } => {
            {
                let st = viewer.state.lock().unwrap();
                if st.focused.as_deref() != Some(session_id.as_str()) {
                    return;
                }
            }
            {
                let mut st = viewer.state.lock().unwrap();
                st.attached = on;
                st.reset_pane();
            }
            viewer.clear_frame_timer();
            if !on {
                return;
            }
            let Some(agent) = app.deps.source.get(&session_id) else { return };
            let Some(pane_id) = agent.pane_id else { return };
            watch_pane(viewer, app, &pane_id, &session_id);
        }

        ClientMessage::Paste { session_id, text, submit, seq } => {
            if !afford(viewer, &session_id) {
                return;
            }
            let agent = app.deps.source.get(&session_id);
            let pane_id = agent.as_ref().and_then(|a| a.pane_id.clone());
            let Some(pane_id) = pane_id else {
                viewer.error(
                    &session_id,
                    agent
                        .and_then(|a| a.attach_blocked_reason)
                        .unwrap_or_else(|| "agent is no longer available".to_string()),
                );
                return;
            };
            if text.len() > MAX_PASTE {
                viewer.error(&session_id, "input too large");
                return;
            }
            if let Err(err) = app.deps.panes.paste(&pane_id, &text, submit).await {
                viewer.error(&session_id, reason(&err));
            }
            // Woken *after* the write, not before. tmux has the text now, so
            // the read this starts is the one that can actually catch the echo
            // — starting it beforehand only bought a read of the pane as it
            // was, and an unchanged read is exactly what makes the loop decide
            // to slow down.
            app.hub.wake(&pane_id);
            // Acknowledged either way. The ack means "the write is over, send
            // the next chunk", not "the write worked" — a failed paste that
            // never acked would wedge the Attach view's typing for good.
            if let Some(seq) = seq {
                viewer.send(ServerMessage::PasteAck { session_id, seq });
            }
        }

        ClientMessage::Key { session_id, key, confirmed } => {
            if !afford(viewer, &session_id) {
                return;
            }
            let Some(agent) = app.deps.source.get(&session_id) else { return };
            let Some(pane_id) = agent.pane_id else { return };
            // INV-2 and INV-6 in one call, on the server side of the wire.
            /*
             * The allow-list is INV-2: a key name becomes an argv entry to
             * `send-keys`, so only names on the list ever reach a live agent.
             *
             * The confirmation flag is INV-6, and it is enforced here rather
             * than only in the browser. `C-c`, `C-d` and `Escape` are on the
             * allow-list because they are keys a user legitimately sends —
             * interrupting an agent is half the point of the Attach view. What
             * made them different was a confirmation dialog in `Terminal.tsx`
             * and nothing else: the server forwarded them to a live agent for
             * anyone who could open a WebSocket, discarding whatever that
             * agent had in flight. That is the exact inversion of INV-2's
             * posture, which says the client's allow-list is a convenience and
             * not the boundary.
             */
            if let Err(refusal) = check_key(&key, confirmed) {
                viewer.error(&session_id, refusal.to_string());
                return;
            }
            if let Err(err) = app.deps.panes.key(&pane_id, &key).await {
                viewer.error(&session_id, reason(&err));
            }
            app.hub.wake(&pane_id);
        }
    }
}

/// INV-12: spend one unit of this tab's budget, or refuse.
///
/// `focus` and `attach` are deliberately not charged. They cost this server
/// work, but they do not reach the agent, and a tab switching views quickly is
/// not the thing being guarded against.
fn afford(viewer: &Viewer, session_id: &str) -> bool {
    if viewer.budget.take() {
        return true;
    }
    // Reported once per burst. An error per refused message would turn a flood
    // into a flood in both directions.
    if viewer.budget.should_warn() {
        viewer.error(session_id, TOO_MUCH_INPUT);
    }
    false
}

async fn pump_timeline(
    tail: &mut Box<dyn TailApi>,
    viewer: &Arc<Viewer>,
    app: &Arc<App>,
    session_id: &str,
) {
    {
        let st = viewer.state.lock().unwrap();
        if st.focused.as_deref() != Some(session_id) {
            return;
        }
    }
    // INV-5: a transcript that cannot be read must not kill the session view.
    let Ok(read) = tail.read().await else { return };
    if !read.patch.is_empty() {
        app.deps.source.enrich(session_id, read.patch);
    }
    if !read.events.is_empty() || read.first {
        viewer.send(ServerMessage::Timeline {
            session_id: session_id.to_string(),
            events: read.events,
            reset: read.first,
        });
    }
}

/// Point this tab at a pane and turn shared reads into frames only it can use.
///
/// The read is shared; the diff is not. `prev_lines` is per-viewer because two
/// tabs that attached at different moments have drawn different things, and a
/// delta against rows this tab never drew is a delta against nothing.
fn watch_pane(viewer: &Arc<Viewer>, app: &Arc<App>, pane_id: &str, session_id: &str) {
    let listener = {
        let viewer = viewer.clone();
        let session_id = session_id.to_string();
        Box::new(move |event: &HubEvent| {
            let mut st = viewer.state.lock().unwrap();
            if !st.attached || st.focused.as_deref() != Some(session_id.as_str()) {
                return;
            }

            match event {
                HubEvent::Error(err) => {
                    st.frame_fails += 1;
                    if st.frame_fails < FRAME_FAIL_LIMIT {
                        return;
                    }
                    viewer.error(&session_id, reason(err));
                    // Same as a dead pane: the frames stop, the conversation
                    // does not. The transcript is on disk and is still the
                    // record of what this agent did.
                    st.attached = false;
                    let unwatch = st.unwatch.take();
                    drop(st);
                    release(unwatch);
                }
                HubEvent::Sample(sample) => {
                    st.frame_fails = 0;
                    let meta = sample.meta;
                    let lines = &sample.lines;
                    if meta.dead {
                        viewer.error(&session_id, DEAD_PANE);
                        st.attached = false;
                        let unwatch = st.unwatch.take();
                        drop(st);
                        release(unwatch);
                        return;
                    }
                    let prev = match &st.prev_lines {
                        Some(p) if p.len() == lines.len() => Some(p.clone()),
                        _ => None,
                    };
                    let frame = build_frame(&session_id, prev.as_deref(), lines, geom_of(&meta));
                    if !is_noop(&frame, st.prev_cursor) {
                        viewer.send(ServerMessage::Frame { frame });
                    }
                    st.prev_lines = Some(lines.clone());
                    st.prev_cursor = Some((meta.cursor_x, meta.cursor_y));
                }
            }
        })
    };

    // Subscribed without the lock held: the hub may deliver its cached sample
    // during this call, and that listener takes the same lock.
    let unwatch = app.hub.subscribe(pane_id, listener);

    let mut st = viewer.state.lock().unwrap();
    if !st.attached {
        // The listener already fired and gave up — a dead pane answered from
        // the hub's cache. Storing the handle now would leak the subscription
        // it had no way to take.
        drop(st);
        release(Some(unwatch));
        return;
    }
    let previous = st.unwatch.replace(unwatch);
    drop(st);
    release(previous);
}

/// Release a hub subscription off the caller's stack.
///
/// A listener that unsubscribes itself is doing so from inside the hub's own
/// dispatch. Deferring means the hub is never re-entered while it is
/// delivering, which is the one thing a Rust port of the TS `Set` iteration
/// cannot do safely.
fn release(unwatch: Option<Unsubscribe>) {
    let Some(unwatch) = unwatch else { return };
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(async move { unwatch() });
        }
        Err(_) => unwatch(),
    }
}

fn geom_of(meta: &crate::sources::PaneMeta) -> Geom {
    Geom {
        cols: meta.cols,
        rows: meta.rows,
        cursor_x: meta.cursor_x,
        cursor_y: meta.cursor_y,
    }
}

fn reason(err: &anyhow::Error) -> String {
    // `{:#}` includes the causes, which is where the tmux message actually is
    // once an adapter has added context to it.
    format!("{err:#}")
}

/* -------------------------------------------------------------------------
 * Assembly.
 *
 * `cli.ts` does this part in the Node tree; there is no `cli.rs`, so the
 * wiring lands here next to the server it configures.
 * ---------------------------------------------------------------------- */

/// The live adapters: the three surfaces `sources.rs` has no trait for.
///
/// Each is a thin call into the module that owns the behaviour. Nothing here
/// decides anything — the 400-vs-500 split is read off the sibling module's
/// own error type, which is the same distinction `err instanceof ControlError`
/// makes in the TypeScript.
mod live {
    use super::*;
    use crate::control::{ControlDeps, ControlFailure, LiveDeps};

    pub struct Spawn;

    #[async_trait]
    impl SpawnApi for Spawn {
        async fn start(&self, req: NewAgentRequest) -> Result<SpawnResult, Failure> {
            match crate::spawn::start_agent(&req, crate::types::now_ms(), None).await {
                Ok(r) => Ok(SpawnResult { tmux_session: r.tmux_session, cwd: r.cwd }),
                // Both `SpawnError` and `SpawnOptionError` are the caller's
                // mistake, and the dialog renders a 400 next to the field.
                Err(e) => Err(Failure { message: e.message(), known: e.is_client_error() }),
            }
        }
    }

    pub struct Browse;

    #[async_trait]
    impl BrowseApi for Browse {
        async fn list_dirs(
            &self,
            path: Option<String>,
            root: Option<String>,
            include_hidden: bool,
        ) -> Result<DirListing, Failure> {
            let root = root.map(std::path::PathBuf::from);
            crate::browse::list_dirs(path.as_deref(), root.as_deref(), include_hidden)
                .await
                // Every `BrowseError` is a refusal the caller can act on; a
                // 500 here would only ever come from a panic.
                .map_err(|e| Failure::caller(e.to_string()))
        }
    }

    /// Builds the deps one action runs against, from the session id in the URL.
    pub type DepsFactory = Arc<dyn Fn(&str) -> Arc<dyn ControlDeps> + Send + Sync>;

    /// Every control action, over whatever deps it was handed.
    ///
    /// This is deliberately the *only* implementation of `ControlApi`: mock
    /// mode swaps the deps, never the actions. INV-7 promises that the failure
    /// a user hits in `--mock` is the one they would hit for real, and that
    /// only holds if the validation, the mode cycling and the goal
    /// verification are the same code both ways. An earlier version of this
    /// file gave mock mode its own shortcut `set_mode`, and the differential
    /// harness caught it immediately: the real server answered 400 to an
    /// unknown mode and the mock one answered 200.
    ///
    /// The deps are rebuilt per request because two of the four members are
    /// closures over the session id — the mode and goal readers come from that
    /// session's transcript, which `control.rs` deliberately knows nothing
    /// about. That is the same shape as the TS `liveDeps(() => readMode(id),
    /// () => readGoal(id))`, and it is why the id travels alongside the agent:
    /// it is known from the URL even when the fleet has nothing under it.
    pub struct Control {
        pub make: DepsFactory,
    }

    impl Control {
        /// The production wiring: writes go through the pane API, reads
        /// through the transcript, and a session that ignores `/exit` is
        /// killed through tmux.
        pub fn live(panes: Arc<dyn PaneApi>) -> Self {
            Control {
                make: Arc::new(move |session_id: &str| {
                    let for_mode = session_id.to_string();
                    let for_goal = session_id.to_string();
                    Arc::new(LiveDeps {
                        panes: panes.clone(),
                        read_mode: Arc::new(move || {
                            let id = for_mode.clone();
                            Box::pin(async move {
                                crate::transcript::read_permission_mode(&id).await
                            })
                        }),
                        read_goal: Arc::new(move || {
                            let id = for_goal.clone();
                            Box::pin(async move { crate::transcript::read_goal(&id).await })
                        }),
                        kill: Arc::new(|session: String| {
                            Box::pin(async move {
                                crate::pane::kill_session(&session)
                                    .await
                                    .map_err(anyhow::Error::from)
                            })
                        }),
                    }) as Arc<dyn ControlDeps>
                }),
            }
        }
    }

    fn failed(e: ControlFailure) -> Failure {
        Failure { message: e.to_string(), known: e.is_client_error() }
    }

    #[async_trait]
    impl ControlApi for Control {
        async fn close(&self, session_id: &str, agent: Option<Agent>) -> Result<bool, Failure> {
            let deps = (self.make)(session_id);
            crate::control::close_agent(agent.as_ref(), &*deps)
                .await
                .map(|r| r.forced)
                .map_err(failed)
        }

        async fn set_mode(
            &self,
            session_id: &str,
            agent: Option<Agent>,
            value: String,
        ) -> Result<ModeOutcome, Failure> {
            let deps = (self.make)(session_id);
            crate::control::set_mode_default(agent.as_ref(), &value, &*deps)
                .await
                .map(|r| ModeOutcome { ok: r.ok, mode: r.mode })
                .map_err(failed)
        }

        async fn set_model(
            &self,
            session_id: &str,
            agent: Option<Agent>,
            value: String,
        ) -> Result<(), Failure> {
            let deps = (self.make)(session_id);
            crate::control::set_model(agent.as_ref(), &value, &*deps).await.map_err(failed)
        }

        async fn set_goal(
            &self,
            session_id: &str,
            agent: Option<Agent>,
            value: String,
        ) -> Result<GoalOutcome, Failure> {
            let deps = (self.make)(session_id);
            crate::control::set_goal_default(agent.as_ref(), &value, &*deps)
                .await
                .map(|r| GoalOutcome { ok: r.ok, goal: r.goal })
                .map_err(failed)
        }

        async fn clear_goal(&self, session_id: &str, agent: Option<Agent>) -> Result<(), Failure> {
            let deps = (self.make)(session_id);
            crate::control::clear_goal(agent.as_ref(), &*deps).await.map_err(failed)
        }
    }
}

/// Mock mode advertises the whole flow while touching nothing real.
///
/// Ported from the injections `cli.ts` makes when `--mock` is set. What is
/// substituted is the *deps*, never the actions: the same guards run, the same
/// mode cycle is walked, and the same goal verification decides whether the
/// answer is 200 or 409 — nothing is typed anywhere.
mod mock_control {
    use super::*;
    use crate::control::ControlDeps;
    use crate::options::MODE_CYCLE;
    use crate::types::now_ms;

    pub struct Spawn;

    #[async_trait]
    impl SpawnApi for Spawn {
        async fn start(&self, req: NewAgentRequest) -> Result<SpawnResult, Failure> {
            // The same checks the real path runs — directory, model and mode —
            // so an unknown alias fails here exactly as it would for real.
            // INV-7: the failure a user sees in `--mock` is the failure they
            // would get without it, and that only holds if it is the same code.
            let cwd = crate::spawn::check_spawn_request(&req)
                .await
                .map_err(|e| Failure { message: e.message(), known: e.is_client_error() })?;
            Ok(SpawnResult {
                tmux_session: "mock-session".into(),
                cwd: cwd.to_string_lossy().into_owned(),
            })
        }
    }

    /// A fake session that answers the way a real one would.
    ///
    /// Shared across every request, because the state it holds — the mode it
    /// has been cycled to, the goal it has been told — is what makes the UI
    /// round-trip: set a goal in mock mode and the card must read it back, or
    /// the flow being demonstrated is the failure path rather than the happy
    /// one.
    #[derive(Default)]
    pub struct MockSession {
        /// Whatever mode was last cycled to, so the UI round-trips.
        mode: Mutex<Option<String>>,
        goal: Mutex<Option<GoalState>>,
    }

    #[async_trait]
    impl ControlDeps for MockSession {
        async fn paste(&self, _pane_id: &str, text: &str, _submit: bool) -> anyhow::Result<()> {
            // The goal toggle is the one control whose state the fake session
            // has to hold: without it the UI would set a goal and read back
            // nothing, which `set_goal` correctly reports as a failure.
            if text == "/goal clear" {
                *self.goal.lock().unwrap() = None;
            } else if let Some(condition) = text.strip_prefix("/goal ") {
                *self.goal.lock().unwrap() = Some(GoalState {
                    condition: condition.to_string(),
                    met: false,
                    at: now_ms(),
                    reason: None,
                    fresh: Some(true),
                });
            }
            Ok(())
        }

        async fn key(&self, _pane_id: &str, _key: &str) -> anyhow::Result<()> {
            // Shift+Tab, which is the only key `control` sends: advance the
            // cycle so `set_mode` can verify it landed exactly as it does for
            // a real session.
            let mut mode = self.mode.lock().unwrap();
            let current = mode.clone().unwrap_or_else(|| "auto".to_string());
            let i = MODE_CYCLE.iter().position(|m| *m == current).unwrap_or(0);
            *mode = Some(MODE_CYCLE[(i + 1) % MODE_CYCLE.len()].to_string());
            Ok(())
        }

        async fn read_mode(&self) -> Option<String> {
            Some(self.mode.lock().unwrap().clone().unwrap_or_else(|| "auto".to_string()))
        }

        async fn read_goal(&self) -> Option<GoalState> {
            self.goal.lock().unwrap().clone()
        }

        /// Nothing is alive, so `/exit` always looks like it worked and no
        /// session is ever killed.
        async fn pane_alive(&self, _pane_id: &str) -> bool {
            false
        }

        async fn kill_session(&self, _tmux_session: &str) -> anyhow::Result<()> {
            Ok(())
        }

        /// Instant. The verification loops are real; the waiting is not, and a
        /// mock server that took six seconds to answer `close` would be a
        /// worse demonstration than one that answers at once.
        async fn wait(&self, _ms: u64) {}
    }

    /// The same `ControlApi` the real server uses, over the fake session.
    pub fn control() -> super::live::Control {
        let session: Arc<MockSession> = Arc::new(MockSession::default());
        super::live::Control {
            make: Arc::new(move |_session_id: &str| session.clone() as Arc<dyn ControlDeps>),
        }
    }
}

/// Start the server described by `opts` and run until the process is asked to stop.
pub async fn serve(opts: Options) -> anyhow::Result<()> {
    let pending = Arc::new(crate::pending::PendingStore::new());

    let deps = if opts.mock {
        crate::mock::mock_deps(opts.mock_transitions)
    } else {
        Deps {
            // Not `LiveSource::new()`: the pending store is what shows a
            // just-spawned session until it registers itself in
            // ~/.claude/sessions, and without it "New agent" appears to do
            // nothing for several seconds.
            source: crate::registry::LiveSource::new_with_pending(pending.clone()),
            panes: crate::pane::TmuxPanes::new(),
            limits: crate::limits::FileLimits::new(),
            tail_for: Arc::new(crate::transcript::tail_for),
        }
    };

    if !opts.mock {
        if !crate::pane::available().await {
            eprintln!(
                "warning: no tmux server reachable — agents will list but cannot be attached to."
            );
        } else {
            // Brought up in the background, never awaited. Once it answers,
            // every pane read and write goes down one pipe instead of forking
            // a fresh tmux client, which is the difference between p50 ~70ms
            // and p50 ~20ms per round trip — and, on a machine at its process
            // cap, the difference between working and `spawn tmux EAGAIN`. It
            // is attached with `ignore-size`, so INV-1 holds.
            crate::tmux_client::tmux_control().start();
        }
    }

    deps.source.start().await?;
    deps.limits.start();

    // Keeps the activity line on every card current, not just the open one.
    let enricher = crate::enrich::FleetEnricher::new(deps.source.clone(), deps.tail_for.clone());
    enricher.start().await;

    let env = crate::env::server_env(opts.port).await;
    // One poller per pane for the whole server, not one per tab (INV-4).
    let hub: Arc<dyn HubApi> = Arc::new(crate::pane_hub::PaneHub::new(deps.panes.clone()));

    // Mock mode advertises the whole flow but must never start a real process
    // or type into anything.
    let (spawn, control): (Arc<dyn SpawnApi>, Arc<dyn ControlApi>) = if opts.mock {
        (Arc::new(mock_control::Spawn), Arc::new(mock_control::control()))
    } else {
        (Arc::new(live::Spawn), Arc::new(live::Control::live(deps.panes.clone())))
    };

    let count = deps.source.list().len();
    let app = Arc::new(App {
        deps,
        hub,
        mock: opts.mock,
        web_root: std::path::PathBuf::from(&opts.web_root),
        token: opts.token.clone(),
        env,
        browse_root: opts.browse_root.clone(),
        spawn,
        browse: Arc::new(live::Browse),
        control,
        pending: Some(pending),
    });

    let listener = tokio::net::TcpListener::bind((opts.host.as_str(), opts.port))
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                anyhow::anyhow!(
                    "port {} is already in use — try --port {}",
                    opts.port,
                    opts.port.saturating_add(1)
                )
            } else {
                anyhow::Error::from(e)
            }
        })?;

    let shown = if opts.host == "::1" { "[::1]".to_string() } else { opts.host.clone() };
    let query = opts.token.as_deref().map(|t| format!("?token={t}")).unwrap_or_default();
    println!("agent-commander on http://{shown}:{}/{query}", opts.port);
    if opts.mock {
        println!("  mock mode — no real agent is touched");
    } else {
        println!("  watching {count} agent(s)");
    }

    let result = axum::serve(listener, router(app.clone()))
        .with_graceful_shutdown(shutdown_signal())
        .await;

    enricher.stop().await;
    app.deps.limits.stop();
    app.deps.source.stop();
    if !opts.mock {
        crate::tmux_client::tmux_control().stop();
        crate::pane::cleanup().await;
    }
    result?;
    Ok(())
}

/// SIGINT or SIGTERM, whichever arrives first.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}

/// Serve `app` on an already-bound listener until the process is asked to stop.
///
/// Split out from `serve` so a test can bind port 0 and drive the real stack.
pub async fn run(app: Arc<App>, listener: tokio::net::TcpListener) -> anyhow::Result<()> {
    axum::serve(listener, router(app)).await?;
    Ok(())
}

/* -------------------------------------------------------------------------
 * Tests.
 *
 * These mirror `test/origin.test.ts`, `test/frame-errors.test.ts` and
 * `test/input-budget.test.ts`, which are the specification for this file.
 *
 * They live here rather than in `rust/tests/` because the crate has only a
 * `[[bin]]` target: an integration test in `tests/` has nothing to `use`.
 * They are still integration tests — each one binds a real socket and drives
 * a real server — they just compile into the binary's test harness.
 * ---------------------------------------------------------------------- */
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::{AgentPatch, AgentSource, LimitsApi, PaneMeta, PaneSample, TailRead};
    use crate::types::{AgentStatus, RateLimits, TimelineEvent, TimelineKind};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    const EVIL: &str = "https://evil.example";
    const SESSION: &str = "mock-busy";
    const PANE: &str = "%1";
    const DOC: &str = "<!doctype html>\n<html lang=\"en\">\n<body><div id=\"root\"></div></body>\n</html>\n";

    /* ---- fakes ---- */

    type Listeners<T> = Arc<Mutex<Vec<Option<Box<dyn Fn(T) + Send + Sync>>>>>;

    fn add_listener<T: 'static>(list: &Listeners<T>, f: Box<dyn Fn(T) + Send + Sync>) -> Unsubscribe {
        let list = list.clone();
        let idx = {
            let mut g = list.lock().unwrap();
            g.push(Some(f));
            g.len() - 1
        };
        Box::new(move || {
            if let Some(slot) = list.lock().unwrap().get_mut(idx) {
                *slot = None;
            }
        })
    }

    struct FakeSource {
        agents: Mutex<Vec<Agent>>,
        listeners: Listeners<Vec<Agent>>,
        patches: Mutex<Vec<(String, AgentPatch)>>,
    }

    impl FakeSource {
        fn new() -> Arc<Self> {
            let agent = Agent {
                session_id: SESSION.into(),
                pid: 1,
                name: "busy".into(),
                cwd: "/tmp".into(),
                folder: "tmp".into(),
                status: AgentStatus::Busy,
                kind: "interactive".into(),
                started_at: 0,
                pane_id: Some(PANE.into()),
                ..Default::default()
            };
            Arc::new(Self {
                agents: Mutex::new(vec![agent]),
                listeners: Default::default(),
                patches: Default::default(),
            })
        }
    }

    #[async_trait]
    impl AgentSource for FakeSource {
        fn list(&self) -> Vec<Agent> {
            self.agents.lock().unwrap().clone()
        }
        fn get(&self, session_id: &str) -> Option<Agent> {
            self.agents.lock().unwrap().iter().find(|a| a.session_id == session_id).cloned()
        }
        fn on_change(&self, f: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe {
            add_listener(&self.listeners, f)
        }
        fn enrich(&self, session_id: &str, patch: AgentPatch) {
            self.patches.lock().unwrap().push((session_id.to_string(), patch));
        }
        async fn start(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn stop(&self) {}
    }

    struct FakePanes {
        writes: AtomicUsize,
        /// Reads that must fail before one succeeds. `i64::MAX` never recovers.
        fail: AtomicI64,
        dead: bool,
        tick: AtomicUsize,
    }

    impl FakePanes {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                writes: AtomicUsize::new(0),
                fail: AtomicI64::new(0),
                dead: false,
                tick: AtomicUsize::new(0),
            })
        }
        fn dead() -> Arc<Self> {
            Arc::new(Self {
                writes: AtomicUsize::new(0),
                fail: AtomicI64::new(0),
                dead: true,
                tick: AtomicUsize::new(0),
            })
        }
        fn flaky(n: i64) -> Arc<Self> {
            Arc::new(Self {
                writes: AtomicUsize::new(0),
                fail: AtomicI64::new(n),
                dead: false,
                tick: AtomicUsize::new(0),
            })
        }
        fn writes(&self) -> usize {
            self.writes.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl PaneApi for FakePanes {
        async fn meta(&self, _pane_id: &str) -> anyhow::Result<PaneMeta> {
            if self.fail.fetch_sub(1, Ordering::SeqCst) > 0 {
                anyhow::bail!("spawn tmux EAGAIN");
            }
            Ok(PaneMeta {
                cols: 80,
                rows: 3,
                cursor_x: 0,
                cursor_y: 0,
                alternate: false,
                dead: self.dead,
            })
        }
        async fn capture(&self, _pane_id: &str, rows: usize) -> anyhow::Result<Vec<String>> {
            // Every read differs from the last, so a frame is never a no-op.
            let n = self.tick.fetch_add(1, Ordering::SeqCst);
            Ok((0..rows).map(|i| format!("row {i} @{n}")).collect())
        }
        async fn paste(&self, _pane_id: &str, _text: &str, _submit: bool) -> anyhow::Result<()> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn key(&self, _pane_id: &str, _key: &str) -> anyhow::Result<()> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct FakeLimits;

    impl LimitsApi for FakeLimits {
        fn current(&self) -> Option<RateLimits> {
            None
        }
        fn on_change(&self, _f: Box<dyn Fn(Option<RateLimits>) + Send + Sync>) -> Unsubscribe {
            Box::new(|| {})
        }
        fn start(&self) {}
        fn stop(&self) {}
    }

    struct FakeTail {
        n: usize,
    }

    #[async_trait]
    impl TailApi for FakeTail {
        async fn read(&mut self) -> anyhow::Result<TailRead> {
            self.n += 1;
            Ok(TailRead {
                events: vec![TimelineEvent {
                    id: format!("e{}", self.n),
                    at: 0,
                    kind: TimelineKind::User,
                    text: format!("event {}", self.n),
                    tool: None,
                    sidechain: None,
                }],
                patch: AgentPatch::default(),
                first: self.n == 1,
            })
        }
    }

    /// A hub with one polling task per pane, which is all `routes` asks of it.
    struct FakeHub {
        panes: Arc<dyn PaneApi>,
        loops: Mutex<HashMap<String, Listeners<Arc<HubEvent>>>>,
    }

    impl FakeHub {
        fn new(panes: Arc<dyn PaneApi>) -> Arc<Self> {
            Arc::new(Self { panes, loops: Mutex::new(HashMap::new()) })
        }
    }

    impl HubApi for FakeHub {
        fn subscribe(
            &self,
            pane_id: &str,
            listener: Box<dyn Fn(&HubEvent) + Send + Sync>,
        ) -> Unsubscribe {
            let listener: Box<dyn Fn(Arc<HubEvent>) + Send + Sync> =
                Box::new(move |event: Arc<HubEvent>| listener(&event));
            let mut loops = self.loops.lock().unwrap();
            let fresh = !loops.contains_key(pane_id);
            let list = loops.entry(pane_id.to_string()).or_default().clone();
            drop(loops);
            let unwatch = add_listener(&list, listener);
            if fresh {
                let panes = self.panes.clone();
                let pane_id = pane_id.to_string();
                let list = list.clone();
                tokio::spawn(async move {
                    loop {
                        let event = Arc::new(match panes.sample(&pane_id).await {
                            Ok(sample) => HubEvent::Sample(Arc::new(sample)),
                            Err(e) => HubEvent::Error(Arc::new(e)),
                        });
                        for slot in list.lock().unwrap().iter() {
                            if let Some(f) = slot {
                                f(event.clone());
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(15)).await;
                    }
                });
            }
            unwatch
        }
        fn wake(&self, _pane_id: &str) {}
    }

    struct OkSpawn;

    #[async_trait]
    impl SpawnApi for OkSpawn {
        async fn start(&self, req: NewAgentRequest) -> Result<SpawnResult, Failure> {
            Ok(SpawnResult { tmux_session: "test-session".into(), cwd: req.cwd })
        }
    }

    struct OkBrowse;

    #[async_trait]
    impl BrowseApi for OkBrowse {
        async fn list_dirs(
            &self,
            path: Option<String>,
            _root: Option<String>,
            _hidden: bool,
        ) -> Result<DirListing, Failure> {
            Ok(DirListing {
                path: path.unwrap_or_else(|| "/tmp".into()),
                parent: None,
                root: "/tmp".into(),
                entries: vec![],
            })
        }
    }

    /// Records what reached it, so a test can prove the body was read correctly.
    struct RecordingControl {
        calls: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ControlApi for RecordingControl {
        async fn close(&self, session_id: &str, _agent: Option<Agent>) -> Result<bool, Failure> {
            self.calls.lock().unwrap().push(format!("close:{session_id}"));
            Ok(false)
        }
        async fn set_mode(
            &self,
            _session_id: &str,
            _agent: Option<Agent>,
            value: String,
        ) -> Result<ModeOutcome, Failure> {
            self.calls.lock().unwrap().push(format!("mode:{value}"));
            Ok(ModeOutcome { ok: true, mode: Some(value) })
        }
        async fn set_model(
            &self,
            _session_id: &str,
            _agent: Option<Agent>,
            value: String,
        ) -> Result<(), Failure> {
            self.calls.lock().unwrap().push(format!("model:{value}"));
            Ok(())
        }
        async fn set_goal(
            &self,
            _session_id: &str,
            _agent: Option<Agent>,
            value: String,
        ) -> Result<GoalOutcome, Failure> {
            self.calls.lock().unwrap().push(format!("goal:{value}"));
            Ok(GoalOutcome {
                ok: true,
                goal: Some(GoalState {
                    condition: value,
                    met: false,
                    at: 0,
                    reason: None,
                    fresh: Some(true),
                }),
            })
        }
        async fn clear_goal(&self, _session_id: &str, _agent: Option<Agent>) -> Result<(), Failure> {
            self.calls.lock().unwrap().push("clear".into());
            Ok(())
        }
    }

    /* ---- harness ---- */

    struct Harness {
        port: u16,
        panes: Arc<FakePanes>,
        source: Arc<FakeSource>,
        control: Arc<RecordingControl>,
        web_root: tempfile::TempDir,
    }

    impl Harness {
        fn base(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }
    }

    async fn start(token: Option<&str>, panes: Arc<FakePanes>, mock: bool) -> Harness {
        let web_root = tempfile::tempdir().unwrap();
        std::fs::write(web_root.path().join("index.html"), DOC).unwrap();
        std::fs::write(web_root.path().join("app.js"), "console.log(1)\n").unwrap();

        let source = FakeSource::new();
        let control = Arc::new(RecordingControl { calls: Mutex::new(vec![]) });
        let hub = FakeHub::new(panes.clone());
        let app = Arc::new(App {
            deps: Deps {
                source: source.clone(),
                panes: panes.clone(),
                limits: Arc::new(FakeLimits),
                tail_for: Arc::new(|_agent: &Agent| {
                    Some(Box::new(FakeTail { n: 0 }) as Box<dyn TailApi>)
                }),
            },
            hub,
            mock,
            web_root: web_root.path().to_path_buf(),
            token: token.map(str::to_string),
            env: ServerEnv {
                tailscale: None,
                tmux: true,
                port: 0,
                platform: "darwin".into(),
            },
            browse_root: None,
            spawn: Arc::new(OkSpawn),
            browse: Arc::new(OkBrowse),
            control: control.clone(),
            pending: None,
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = run(app, listener).await;
        });
        Harness { port, panes, source, control, web_root }
    }

    async fn plain(panes: Arc<FakePanes>) -> Harness {
        start(None, panes, false).await
    }

    /* ---- raw HTTP, because `Host` is not a header a real client will set ---- */

    async fn raw(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = stream.read_to_string(&mut out).await;
        out
    }

    async fn get(port: u16, path: &str, headers: &str) -> String {
        raw(
            port,
            &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{headers}Connection: close\r\n\r\n"),
        )
        .await
    }

    fn status(response: &str) -> String {
        response.lines().next().unwrap_or("").to_string()
    }

    fn body(response: &str) -> String {
        response.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default()
    }

    async fn post(port: u16, path: &str, headers: &str, payload: Option<&str>) -> String {
        let body = payload.unwrap_or("");
        let length = if payload.is_some() {
            format!("Content-Length: {}\r\n", body.len())
        } else {
            "Content-Length: 0\r\n".to_string()
        };
        raw(
            port,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{headers}{length}Connection: close\r\n\r\n{body}"
            ),
        )
        .await
    }

    /// A WebSocket handshake driven by hand, so a refusal can be read as a status.
    async fn try_ws(port: u16, headers: &str) -> String {
        let request = format!(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{headers}\r\n"
        );
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = [0u8; 512];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string()
    }

    /* ---- INV-3: the token ---- */

    #[tokio::test]
    async fn refuses_a_request_with_no_token_when_one_is_configured() {
        let h = start(Some("s3cret"), FakePanes::new(), false).await;
        let res = get(h.port, "/api/agents", "").await;
        assert!(status(&res).contains("401"), "{}", status(&res));
    }

    #[tokio::test]
    async fn accepts_the_token_in_the_query() {
        let h = start(Some("s3cret"), FakePanes::new(), false).await;
        let res = get(h.port, "/api/agents?token=s3cret", "").await;
        assert!(status(&res).contains("200"), "{}", status(&res));
    }

    #[tokio::test]
    async fn accepts_the_token_in_an_authorization_header() {
        let h = start(Some("s3cret"), FakePanes::new(), false).await;
        let res = get(h.port, "/api/agents", "Authorization: Bearer s3cret\r\n").await;
        assert!(status(&res).contains("200"), "{}", status(&res));
    }

    #[tokio::test]
    async fn refuses_a_token_that_is_merely_a_prefix() {
        let h = start(Some("s3cret"), FakePanes::new(), false).await;
        for wrong in ["s3cre", "s3cretx", "S3CRET", ""] {
            let res = get(h.port, &format!("/api/agents?token={wrong}"), "").await;
            assert!(status(&res).contains("401"), "{wrong}: {}", status(&res));
        }
    }

    #[tokio::test]
    async fn a_token_replaces_the_origin_gate() {
        // The Tailscale flow: a legitimate name that is not loopback, which
        // INV-3 already requires `--token` for.
        let h = start(Some("s3cret"), FakePanes::new(), false).await;
        let res = raw(
            h.port,
            &format!(
                "GET /api/agents?token=s3cret HTTP/1.1\r\nHost: laptop.tailnet.ts.net\r\nOrigin: http://laptop.tailnet.ts.net\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(status(&res).contains("200"), "{}", status(&res));
    }

    /* ---- INV-3: the origin gate on a tokenless server ---- */

    #[tokio::test]
    async fn refuses_the_fleet_listing_to_a_foreign_origin() {
        let h = plain(FakePanes::new()).await;
        let res = get(h.port, "/api/agents", &format!("Origin: {EVIL}\r\n")).await;
        assert!(status(&res).contains("403"), "{}", status(&res));
    }

    #[tokio::test]
    async fn refuses_to_start_an_agent_for_a_foreign_origin() {
        // A form POST needs no preflight, so a browser sends this for real.
        let h = plain(FakePanes::new()).await;
        let res = post(
            h.port,
            "/api/agents",
            &format!("Origin: {EVIL}\r\nContent-Type: text/plain;charset=UTF-8\r\n"),
            Some("{\"cwd\":\"/tmp\"}"),
        )
        .await;
        assert!(status(&res).contains("403"), "{}", status(&res));
    }

    #[tokio::test]
    async fn refuses_to_set_a_goal_for_a_foreign_origin() {
        let h = plain(FakePanes::new()).await;
        let res = post(
            h.port,
            &format!("/api/agents/{SESSION}/goal"),
            &format!("Origin: {EVIL}\r\nContent-Type: text/plain;charset=UTF-8\r\n"),
            Some("{\"value\":\"exfiltrate the repo\"}"),
        )
        .await;
        assert!(status(&res).contains("403"), "{}", status(&res));
        assert!(h.control.calls.lock().unwrap().is_empty(), "nothing may reach control");
    }

    #[tokio::test]
    async fn still_serves_the_app_to_its_own_origin() {
        let h = plain(FakePanes::new()).await;
        let origin = h.base();
        let res = get(h.port, "/api/agents", &format!("Origin: {origin}\r\n")).await;
        assert!(status(&res).contains("200"), "{}", status(&res));
        assert!(body(&res).contains("\"agents\""));
    }

    #[tokio::test]
    async fn a_page_with_no_origin_at_all_is_not_the_threat_this_guards() {
        // A CLI or a native client sends no Origin; only browsers are gated.
        let h = plain(FakePanes::new()).await;
        assert!(status(&get(h.port, "/api/agents", "").await).contains("200"));
    }

    #[tokio::test]
    async fn a_sandboxed_null_origin_is_refused_like_any_other_stranger() {
        let h = plain(FakePanes::new()).await;
        let res = get(h.port, "/api/agents", "Origin: null\r\n").await;
        assert!(status(&res).contains("403"), "{}", status(&res));
    }

    /* ---- INV-3: DNS rebinding ---- */

    #[tokio::test]
    async fn refuses_a_rebound_hostname_however_consistent() {
        let h = plain(FakePanes::new()).await;
        let res = raw(
            h.port,
            "GET /api/agents HTTP/1.1\r\nHost: evil.example\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(status(&res).contains("403"), "{}", status(&res));
    }

    #[tokio::test]
    async fn refuses_a_rebound_name_that_sends_no_origin_either() {
        let h = plain(FakePanes::new()).await;
        let res = raw(
            h.port,
            "GET /api/agents HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(status(&res).contains("403"), "{}", status(&res));
    }

    #[tokio::test]
    async fn serves_every_honest_spelling_of_loopback() {
        let h = plain(FakePanes::new()).await;
        for host in [
            format!("127.0.0.1:{}", h.port),
            format!("localhost:{}", h.port),
            format!("[::1]:{}", h.port),
            "127.7.7.7".to_string(),
        ] {
            let res = raw(
                h.port,
                &format!("GET /api/agents HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
            )
            .await;
            assert!(status(&res).contains("200"), "{host}: {}", status(&res));
        }
    }

    /* ---- INV-3: the WebSocket gets the same gate ---- */

    #[tokio::test]
    async fn the_websocket_refuses_a_foreign_origin() {
        let h = plain(FakePanes::new()).await;
        let line = try_ws(h.port, &format!("Origin: {EVIL}\r\n")).await;
        assert!(line.contains("403"), "{line}");
    }

    #[tokio::test]
    async fn the_websocket_refuses_a_rebound_name_too() {
        let h = plain(FakePanes::new()).await;
        let request = format!(
            "GET /ws HTTP/1.1\r\nHost: evil.example\r\nOrigin: http://evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        let mut stream = TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = [0u8; 256];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
        assert!(line.contains("403"), "{line}");
    }

    #[tokio::test]
    async fn the_websocket_refuses_a_handshake_with_no_token() {
        let h = start(Some("s3cret"), FakePanes::new(), false).await;
        let line = try_ws(h.port, "").await;
        assert!(line.contains("401"), "{line}");
    }

    #[tokio::test]
    async fn the_websocket_accepts_the_loopback_origin_it_is_served_at() {
        let h = plain(FakePanes::new()).await;
        let origin = h.base();
        let line = try_ws(h.port, &format!("Origin: {origin}\r\n")).await;
        assert!(line.contains("101"), "{line}");
    }

    #[tokio::test]
    async fn the_websocket_accepts_a_handshake_with_no_origin_at_all() {
        let h = plain(FakePanes::new()).await;
        assert!(try_ws(h.port, "").await.contains("101"));
    }

    #[tokio::test]
    async fn an_upgrade_aimed_anywhere_but_ws_is_refused() {
        let h = plain(FakePanes::new()).await;
        let request = format!(
            "GET /api/agents HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
            h.port
        );
        let mut stream = TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = [0u8; 256];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
        assert!(line.contains("401"), "{line}");
    }

    /* ---- static files ---- */

    #[tokio::test]
    async fn refuses_to_be_walked_out_of_its_web_root() {
        let h = plain(FakePanes::new()).await;
        // A real secret outside the root, one directory up from it.
        let outside = h.web_root.path().parent().unwrap().join("ac-secret.txt");
        std::fs::write(&outside, "TOP SECRET").unwrap();
        let name = outside.file_name().unwrap().to_string_lossy().to_string();

        for path in [
            format!("/../{name}"),
            format!("/../../{name}"),
            format!("/a/../../{name}"),
            format!("/%2e%2e/{name}"),
            format!("/..%2f{name}"),
            "/../../../../../../etc/passwd".to_string(),
            "/....//....//etc/passwd".to_string(),
        ] {
            let res = get(h.port, &path, "").await;
            assert!(!body(&res).contains("TOP SECRET"), "escaped with {path}");
            assert!(!body(&res).contains("root:"), "escaped with {path}");
        }
        let _ = std::fs::remove_file(outside);
    }

    #[tokio::test]
    async fn serves_the_document_and_falls_back_for_client_routes() {
        let h = plain(FakePanes::new()).await;
        assert!(body(&get(h.port, "/", "").await).contains("<div id=\"root\">"));
        // A client route is not a file, and must still get the document.
        assert!(body(&get(h.port, "/agent/xyz", "").await).contains("<div id=\"root\">"));
        // A genuinely missing asset still 404s, or the browser caches HTML as JS.
        assert!(status(&get(h.port, "/missing.js", "").await).contains("404"));
        assert!(body(&get(h.port, "/app.js", "").await).contains("console.log"));
    }

    #[tokio::test]
    async fn stamps_the_mock_flag_into_the_document_before_it_paints() {
        let h = start(None, FakePanes::new(), true).await;
        let doc = body(&get(h.port, "/", "").await);
        assert!(doc.contains("data-mock=\"true\""), "{doc}");
        // Not into anything else — only the document carries the banner.
        assert!(!body(&get(h.port, "/app.js", "").await).contains("data-mock"));
    }

    /* ---- JSON surface ---- */

    #[tokio::test]
    async fn serves_the_fleet_and_the_environment() {
        let h = plain(FakePanes::new()).await;
        let fleet = body(&get(h.port, "/api/agents", "").await);
        assert!(fleet.contains("\"mock\":false"), "{fleet}");
        assert!(fleet.contains(SESSION), "{fleet}");
        let env = body(&get(h.port, "/api/env", "").await);
        assert!(env.contains("\"tmux\":true"), "{env}");
    }

    #[tokio::test]
    async fn close_needs_no_body_at_all() {
        // The client omits the body entirely for `close`, so reading one would
        // hang or 500 on the request the real UI actually sends.
        let h = plain(FakePanes::new()).await;
        let res = post(h.port, &format!("/api/agents/{SESSION}/close"), "", None).await;
        assert!(status(&res).contains("200"), "{}", status(&res));
        assert!(body(&res).contains("\"detail\":\"exited\""), "{}", body(&res));
        assert_eq!(h.control.calls.lock().unwrap().as_slice(), &[format!("close:{SESSION}")]);
    }

    #[tokio::test]
    async fn control_reads_a_single_value_key() {
        let h = plain(FakePanes::new()).await;
        let json = "Content-Type: application/json\r\n";
        for (action, payload, expect) in [
            ("mode", "{\"value\":\"plan\"}", "mode:plan"),
            ("model", "{\"value\":\"opus\"}", "model:opus"),
            ("goal", "{\"value\":\"ship it\"}", "goal:ship it"),
        ] {
            let res =
                post(h.port, &format!("/api/agents/{SESSION}/{action}"), json, Some(payload)).await;
            assert!(status(&res).contains("200"), "{action}: {}", status(&res));
            assert!(h.control.calls.lock().unwrap().contains(&expect.to_string()), "{action}");
        }
    }

    #[tokio::test]
    async fn a_missing_or_null_value_becomes_the_empty_string() {
        // `String(body?.value ?? '')` — it does not 400 early, it flows into
        // each action's own validation. For `goal` that means "cleared".
        let h = plain(FakePanes::new()).await;
        let json = "Content-Type: application/json\r\n";
        for payload in ["{\"value\":null}", "{}", "{\"value\":\"   \"}"] {
            h.control.calls.lock().unwrap().clear();
            let res = post(h.port, &format!("/api/agents/{SESSION}/goal"), json, Some(payload)).await;
            assert!(status(&res).contains("200"), "{payload}: {}", status(&res));
            assert!(body(&res).contains("\"detail\":\"cleared\""), "{payload}: {}", body(&res));
            assert_eq!(h.control.calls.lock().unwrap().as_slice(), &["clear".to_string()]);
        }
        // Clearing is the only place that knows a goal went away, so it must
        // publish the change itself.
        let patches = h.source.patches.lock().unwrap();
        assert!(patches.iter().any(|(id, p)| id == SESSION && matches!(p.goal, Some(None))));
    }

    #[tokio::test]
    async fn a_percent_encoded_session_id_is_decoded_before_lookup() {
        let h = plain(FakePanes::new()).await;
        let res = post(h.port, "/api/agents/a%2Fb/close", "", None).await;
        // `a/b` has a slash, so the route does not match at all and it falls
        // through to the static handler — the same as the TS regex, which
        // matches on the *encoded* path before decoding.
        assert!(status(&res).contains("404") || status(&res).contains("200"));
        let res = post(h.port, "/api/agents/mock%2Dbusy/close", "", None).await;
        assert!(status(&res).contains("200"), "{}", status(&res));
    }

    #[tokio::test]
    async fn refuses_an_oversized_request_body() {
        let h = plain(FakePanes::new()).await;
        let payload = format!("{{\"cwd\":\"/tmp\",\"name\":\"{}\"}}", "x".repeat(MAX_BODY * 2));
        let res = post(
            h.port,
            "/api/agents",
            "Content-Type: application/json\r\n",
            Some(&payload),
        )
        .await;
        assert!(status(&res).contains("500"), "{}", status(&res));
        assert!(body(&res).contains("too large"), "{}", body(&res));
    }

    /* ---- INV-12 and INV-6: the guards must actually be reached ---- */

    // The bucket itself and `check_key` are `control.rs`'s, with their own
    // tests. What is proved here is the thing those tests cannot: that this
    // file calls them on every inbound message.

    /* ---- the WebSocket, driven the way the client drives it ---- */

    use futures_util::SinkExt as _;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    type Client = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn open(port: u16) -> Client {
        let (client, _) =
            tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws")).await.unwrap();
        client
    }

    async fn send_json(client: &mut Client, value: serde_json::Value) {
        client.send(WsMessage::Text(value.to_string())).await.unwrap();
    }

    /// The next server message matching `want`, or `None` if none arrives in time.
    async fn next_msg(
        client: &mut Client,
        want: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return None;
            }
            let frame = match tokio::time::timeout(left, client.next()).await {
                Ok(Some(Ok(f))) => f,
                _ => return None,
            };
            let WsMessage::Text(text) = frame else { continue };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            if want(&value) {
                return Some(value);
            }
        }
    }

    fn is_type(value: &serde_json::Value, ty: &str) -> bool {
        value.get("type").and_then(|t| t.as_str()) == Some(ty)
    }

    #[tokio::test]
    async fn sends_the_fleet_the_moment_the_socket_opens() {
        let h = plain(FakePanes::new()).await;
        let mut client = open(h.port).await;
        let fleet = next_msg(&mut client, |m| is_type(m, "fleet")).await.unwrap();
        assert_eq!(fleet["mock"], serde_json::json!(false));
        assert_eq!(fleet["agents"][0]["sessionId"], serde_json::json!(SESSION));
        // A fresh tab needs the quota reading immediately, not at the next
        // statusline render.
        assert!(next_msg(&mut client, |m| is_type(m, "limits")).await.is_some());
    }

    #[tokio::test]
    async fn refuses_a_key_that_is_not_on_the_allow_list() {
        // INV-2. The key name becomes an argv entry to `send-keys`, so the
        // server's list is the boundary and the browser's is a convenience.
        let h = plain(FakePanes::new()).await;
        let mut client = open(h.port).await;
        send_json(&mut client, serde_json::json!({"type":"key","sessionId":SESSION,"key":"C-z"}))
            .await;
        let err = next_msg(&mut client, |m| is_type(m, "error")).await.unwrap();
        assert_eq!(err["message"], serde_json::json!("key not allowed: C-z"));
        assert_eq!(h.panes.writes(), 0);
    }

    #[tokio::test]
    async fn refuses_a_destructive_key_that_nobody_confirmed() {
        // INV-6, on this side of the wire and not only in `Terminal.tsx`.
        let h = plain(FakePanes::new()).await;
        let mut client = open(h.port).await;
        for key in ["C-c", "C-d", "Escape"] {
            send_json(
                &mut client,
                serde_json::json!({"type":"key","sessionId":SESSION,"key":key}),
            )
            .await;
            let err = next_msg(&mut client, |m| is_type(m, "error")).await.unwrap();
            assert_eq!(
                err["message"],
                serde_json::json!(format!("{key} discards work in progress and needs confirmation"))
            );
        }
        // Not even a truthy-looking value gets through; only a JSON `true`.
        send_json(
            &mut client,
            serde_json::json!({"type":"key","sessionId":SESSION,"key":"C-c","confirmed":false}),
        )
        .await;
        assert!(next_msg(&mut client, |m| is_type(m, "error")).await.is_some());
        assert_eq!(h.panes.writes(), 0, "nothing destructive reached the pane");

        // Confirmed, it goes through.
        send_json(
            &mut client,
            serde_json::json!({"type":"key","sessionId":SESSION,"key":"C-c","confirmed":true}),
        )
        .await;
        for _ in 0..40 {
            if h.panes.writes() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(h.panes.writes(), 1);
    }

    #[tokio::test]
    async fn refuses_a_paste_larger_than_the_intent_cap() {
        let h = plain(FakePanes::new()).await;
        let mut client = open(h.port).await;
        let text = "x".repeat(MAX_PASTE + 1);
        send_json(
            &mut client,
            serde_json::json!({"type":"paste","sessionId":SESSION,"text":text,"submit":false}),
        )
        .await;
        let err = next_msg(&mut client, |m| is_type(m, "error")).await.unwrap();
        assert_eq!(err["message"], serde_json::json!("input too large"));
        assert_eq!(h.panes.writes(), 0);
    }

    #[tokio::test]
    async fn refuses_an_oversized_frame_before_it_is_parsed() {
        // `MAX_PASTE` would refuse this too, but only after the whole frame
        // had been buffered and the string built.
        let h = plain(FakePanes::new()).await;
        let mut client = open(h.port).await;
        assert!(next_msg(&mut client, |m| is_type(m, "fleet")).await.is_some());
        let text = "x".repeat(MAX_FRAME_BYTES + 1_000_000);
        let _ = client
            .send(WsMessage::Text(
                serde_json::json!({"type":"paste","sessionId":SESSION,"text":text,"submit":false})
                    .to_string(),
            ))
            .await;
        // The connection ends rather than the message being answered.
        let mut ended = false;
        for _ in 0..40 {
            match tokio::time::timeout(Duration::from_millis(100), client.next()).await {
                Ok(None) | Ok(Some(Err(_))) => {
                    ended = true;
                    break;
                }
                Ok(Some(Ok(WsMessage::Close(_)))) => {
                    ended = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(ended, "an oversized frame must end the connection, not be answered");
        assert_eq!(h.panes.writes(), 0);
    }

    #[tokio::test]
    async fn a_flood_of_keystrokes_does_not_all_reach_the_agent() {
        // INV-12, and the point of the test is that `routes` *calls* the
        // budget: `control.rs` proves the bucket arithmetic separately.
        let h = plain(FakePanes::new()).await;
        let mut client = open(h.port).await;
        for _ in 0..5000 {
            send_json(&mut client, serde_json::json!({"type":"key","sessionId":SESSION,"key":"Up"}))
                .await;
        }
        let err = next_msg(&mut client, |m| {
            is_type(m, "error")
                && m["message"].as_str().map(|s| s.contains("too much input")).unwrap_or(false)
        })
        .await;
        assert!(err.is_some(), "the client is told once that it is being slowed down");
        tokio::time::sleep(Duration::from_millis(400)).await;
        let writes = h.panes.writes();
        // Before the budget this was 5000.
        assert!(writes > 0 && writes < 500, "writes = {writes}");
    }

    #[tokio::test]
    async fn a_dead_pane_ends_the_terminal_and_not_the_conversation() {
        let h = start(None, FakePanes::dead(), false).await;
        let mut client = open(h.port).await;
        send_json(&mut client, serde_json::json!({"type":"focus","sessionId":SESSION})).await;
        assert!(next_msg(&mut client, |m| is_type(m, "timeline")).await.is_some());
        send_json(&mut client, serde_json::json!({"type":"attach","sessionId":SESSION,"on":true}))
            .await;
        let err = next_msg(&mut client, |m| is_type(m, "error")).await.unwrap();
        assert_eq!(err["message"], serde_json::json!(DEAD_PANE));
        // The transcript is on disk and is still the record of what this agent
        // did, so the chat must keep arriving.
        assert!(
            next_msg(&mut client, |m| is_type(m, "timeline")).await.is_some(),
            "the transcript poll must survive the pane"
        );
    }

    #[tokio::test]
    async fn rides_out_a_run_of_failures_and_then_draws_the_pane() {
        // On a machine at its process cap `spawn tmux EAGAIN` is an ordinary
        // event, and it used to end the Attach view for good.
        let h = start(None, FakePanes::flaky(FRAME_FAIL_LIMIT as i64 - 2), false).await;
        let mut client = open(h.port).await;
        send_json(&mut client, serde_json::json!({"type":"focus","sessionId":SESSION})).await;
        send_json(&mut client, serde_json::json!({"type":"attach","sessionId":SESSION,"on":true}))
            .await;
        let frame = next_msg(&mut client, |m| is_type(m, "frame")).await;
        assert!(frame.is_some(), "a blip must not end the terminal");
    }

    #[tokio::test]
    async fn still_gives_up_when_the_failures_do_not_stop() {
        let h = start(None, FakePanes::flaky(i64::MAX), false).await;
        let mut client = open(h.port).await;
        send_json(&mut client, serde_json::json!({"type":"focus","sessionId":SESSION})).await;
        send_json(&mut client, serde_json::json!({"type":"attach","sessionId":SESSION,"on":true}))
            .await;
        let err = next_msg(&mut client, |m| is_type(m, "error")).await.unwrap();
        // The reason shown is the real one from tmux, not a guess.
        assert!(
            err["message"].as_str().unwrap_or("").contains("EAGAIN"),
            "{}",
            err["message"]
        );
    }

    #[tokio::test]
    async fn a_paste_is_acknowledged_whether_or_not_the_write_worked() {
        let h = plain(FakePanes::new()).await;
        let mut client = open(h.port).await;
        send_json(
            &mut client,
            serde_json::json!({"type":"paste","sessionId":SESSION,"text":"hi","submit":true,"seq":7}),
        )
        .await;
        let ack = next_msg(&mut client, |m| is_type(m, "paste-ack")).await.unwrap();
        assert_eq!(ack["seq"], serde_json::json!(7));
        assert_eq!(ack["sessionId"], serde_json::json!(SESSION));
    }

    /* ---- security helpers, attacked directly ---- */

    #[test]
    fn only_loopback_names_are_loopback() {
        for good in ["localhost", "::1", "127.0.0.1", "127.7.7.7", "127.255.255.255"] {
            assert!(is_loopback_name(good), "{good}");
        }
        for bad in [
            "evil.example",
            "127.0.0.1.evil.example",
            "localhost.evil.example",
            "0.0.0.0",
            "1270.0.0.1",
            "127.0.0",
            "127.0.0.1.2",
            "::2",
            "null",
            "",
        ] {
            assert!(!is_loopback_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_hostname_is_only_what_a_url_parser_would_accept() {
        assert_eq!(hostname_of(Some("http://127.0.0.1:4317")).as_deref(), Some("127.0.0.1"));
        assert_eq!(hostname_of(Some("127.0.0.1:4317")).as_deref(), Some("127.0.0.1"));
        assert_eq!(hostname_of(Some("[::1]:4317")).as_deref(), Some("::1"));
        assert_eq!(hostname_of(Some("http://[::1]/x")).as_deref(), Some("::1"));
        assert_eq!(hostname_of(Some("null")).as_deref(), Some("null"));
        // Credentials must not smuggle a loopback name past the check.
        assert_eq!(
            hostname_of(Some("http://127.0.0.1@evil.example")).as_deref(),
            Some("evil.example")
        );
        // A bare IPv6 without brackets is not a URL Node would parse.
        assert_eq!(hostname_of(Some("http://::1")), None);
        assert_eq!(hostname_of(Some("")), None);
        assert_eq!(hostname_of(None), None);
        // A path cannot extend the authority.
        assert_eq!(
            hostname_of(Some("http://evil.example/127.0.0.1")).as_deref(),
            Some("evil.example")
        );
    }

    #[test]
    fn is_inside_compares_segments_and_not_prefixes() {
        let root = Path::new("/app/dist/web");
        assert!(is_inside(root, Path::new("/app/dist/web")));
        assert!(is_inside(root, Path::new("/app/dist/web/index.html")));
        assert!(!is_inside(root, Path::new("/app/dist/web-backup/secrets")));
        assert!(!is_inside(root, Path::new("/app/dist")));
    }

    #[test]
    fn normalisation_cannot_climb_above_the_root() {
        assert_eq!(normalize("/../../etc/passwd"), "/etc/passwd");
        assert_eq!(normalize("/a/../../b"), "/b");
        assert_eq!(normalize("/index.html"), "/index.html");
        assert_eq!(normalize("/a/./b/"), "/a/b");
        assert_eq!(normalize("../secret"), "../secret");
    }

    #[test]
    fn a_query_token_is_decoded_the_way_a_browser_encoded_it() {
        assert_eq!(query_param("token=a%20b", "token").as_deref(), Some("a b"));
        assert_eq!(query_param("x=1&token=s3cret", "token").as_deref(), Some("s3cret"));
        assert_eq!(query_param("token=", "token").as_deref(), Some(""));
        assert_eq!(query_param("tok=1", "token"), None);
        assert_eq!(query_param("", "token"), None);
    }

    #[test]
    fn the_control_route_matches_exactly_what_the_ts_regex_did() {
        assert_eq!(
            control_route("/api/agents/abc/close"),
            Some(("abc".into(), "close".into()))
        );
        assert_eq!(control_route("/api/agents/a%2Fb/goal"), Some(("a/b".into(), "goal".into())));
        assert_eq!(control_route("/api/agents/a/b/close"), None, "an id may not span segments");
        assert_eq!(control_route("/api/agents//close"), None);
        assert_eq!(control_route("/api/agents/abc/kill"), None);
        assert_eq!(control_route("/api/agents"), None);
    }
}
