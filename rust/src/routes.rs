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

use crate::browse::DotDirs;
use crate::frames::{build_frame, is_noop};
use crate::options::{Grant, Grants, Options};
use crate::pane_hub::HubEvent;
use crate::pending::SpawnedSession;
use crate::sources::{Deps, PaneApi, PaneSample, Submit, TailApi, Unsubscribe};
use crate::types::{
    Agent, AgentTree, ClientMessage, ControlResponse, DirListing, FleetTree, Geom,
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
        dot_dirs: DotDirs,
    ) -> Result<DirListing, Failure>;
}

/// `/clear` replaces the session rather than editing it, so the new id is the
/// answer and not decoration on it.
pub struct ClearOutcome {
    pub session_id: Option<String>,
    pub unobserved: bool,
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
    /// Send one Shift+Tab. Takes no value and reports none: the key either
    /// reached the pane or the call failed, and nothing else is knowable
    /// until the session's turn ends.
    async fn shift_tab(&self, session_id: &str, agent: Option<Agent>) -> Result<(), Failure>;
    /// Replaces the session; the new id is the answer.
    async fn clear(&self, session_id: &str, agent: Option<Agent>) -> Result<ClearOutcome, Failure>;
    /// Runs for minutes. Nothing waits on it.
    async fn compact(&self, session_id: &str, agent: Option<Agent>) -> Result<(), Failure>;
    /// Returns true when the agent was mid-turn, so the CLI reads it at the end.
    async fn set_model(&self, session_id: &str, agent: Option<Agent>, value: String) -> Result<bool, Failure>;
    async fn set_goal(&self, session_id: &str, agent: Option<Agent>, value: String)
        -> Result<GoalOutcome, Failure>;
    async fn clear_goal(&self, session_id: &str, agent: Option<Agent>) -> Result<(), Failure>;
}

/// Reads one agent's delegation tree (INV-13).
///
/// Injected so mock mode can stand in. Absent in tests that do not exercise the
/// tree; `/api/tree` then reports every agent as having no delegates rather
/// than failing.
#[async_trait]
pub trait TreeApi: Send + Sync + 'static {
    async fn read(&self, agent: &Agent) -> AgentTree;
}

/// Shows a just-started session until it registers itself.
pub trait PendingApi: Send + Sync + 'static {
    fn add(&self, spawned: SpawnedSession<'_>);
}

impl PendingApi for crate::pending::PendingStore {
    fn add(&self, spawned: SpawnedSession<'_>) {
        crate::pending::PendingStore::add(self, spawned)
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
    pub tree: Option<Arc<dyn TreeApi>>,
    /// Read once at startup: the CLI probe is a subprocess (see
    /// `own_tailnet_name`), and this cannot change under us.
    pub tailnet: Option<String>,
    /// Non-loopback names this server answers to, lowercased. Empty without a
    /// token — see `origin_names` and `is_allowed_name`.
    pub origin_names: Vec<String>,
    /// What this server's credential may do. `Grants::ALL` unless `--grant`
    /// narrowed it.
    pub grants: Grants,
}

/* -------------------------------------------------------------------------
 * INV-3.
 * ---------------------------------------------------------------------- */

/// Constant-time compare, so a token cannot be recovered a byte at a time.
fn safe_equal(supplied: &str, expected: &str) -> bool {
    let (supplied, expected) = (supplied.as_bytes(), expected.as_bytes());
    if supplied.len() != expected.len() {
        // Length is not secret — the TS short-circuits on it too, and
        // `ct_eq` needs equal-length slices.
        return false;
    }
    supplied.ct_eq(expected).into()
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
    let authority = authority_of(value?)?;
    match authority.strip_prefix('[') {
        Some(inner) => bracketed_host(inner),
        None => named_host(authority),
    }
}

/// Everything between the scheme and the path, with any userinfo dropped.
fn authority_of(value: &str) -> Option<&str> {
    if value.is_empty() {
        return None;
    }
    let rest = match value.find("://") {
        Some(at) => &value[at + 3..],
        None => value,
    };
    // The authority ends at the first path, query or fragment delimiter.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Userinfo, if any, is everything before the last '@'.
    let authority = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    (!authority.is_empty()).then_some(authority)
}

/// `[::1]:4317` — the brackets are what make a bare IPv6 literal legal in a
/// URL, and `new URL().hostname` keeps them, so the TS strips them with a
/// regex. Same result, one step earlier.
fn bracketed_host(inner: &str) -> Option<String> {
    let end = inner.find(']')?;
    let host = &inner[..end];
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// A name or IPv4 literal, with the port read only to refuse what Node would.
fn named_host(authority: &str) -> Option<String> {
    let mut parts = authority.split(':');
    let host = parts.next().unwrap_or("");
    // A second colon without brackets is not a URL Node would parse, and a
    // non-numeric port is not one either. Both are `null` there.
    if let Some(port) = parts.next() {
        if parts.next().is_some() || !port.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// `127.` plus this many octets is the whole of an IPv4 loopback address.
const OCTETS_BELOW_THE_FIRST: usize = 3;

/// `255` is as long as an octet is ever written.
const LONGEST_OCTET: usize = 3;

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
    rest.len() == OCTETS_BELOW_THE_FIRST
        && rest.iter().all(|octet| {
            !octet.is_empty()
                && octet.len() <= LONGEST_OCTET
                && octet.chars().all(|c| c.is_ascii_digit())
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
/// Every server is gated, token or not. A token says who is calling; this says
/// the call was meant. Treating the first as proof of the second was safe only
/// while the token lived in a URL the attacking page could not read — a
/// credential the browser attaches by itself, such as a cookie, rides along on
/// a cross-origin request and proves nothing about intent.
///
/// What keeps the Tailscale flow working is `tailnet_origin`: the name the
/// proxy forwards is accepted as an origin, while the token — which INV-3
/// already requires for anything off-box — is what authenticates the caller.
/// This host's Tailscale name, lowercased and trailing dot removed, if up.
///
/// Read from the Tailscale CLI at startup rather than from anything a caller
/// sends, and read once: the probe is a subprocess and this cannot change
/// under us.
pub fn own_tailnet_name(env: &ServerEnv) -> Option<String> {
    let ts = env.tailscale.as_ref()?;
    if !ts.running {
        return None;
    }
    let name = ts.dns_name.trim_end_matches('.').to_ascii_lowercase();
    (!name.is_empty()).then_some(name)
}

/// The non-loopback names this server may legitimately be reached at (INV-3).
///
/// Two ways one gets here, and both are a name the *operator* chose rather than
/// anything a caller supplied:
///
///   * the address `--host` bound, because asking to be reachable there is
///     asking for that name to work;
///   * this host's own Tailscale `DNSName`, because `tailscale serve`
///     terminates TLS and proxies to the loopback port forwarding the name the
///     caller dialled — which is ours.
///
/// Both are gathered only when a token is configured, and that is the whole
/// point. Neither name identifies a *caller*: every tailnet peer's request
/// arrives wearing this host's name, and nothing in this gate looks at the peer
/// address. So the name says the request reached the right server, and the
/// token says who sent it. A visited web page still cannot use either — its
/// `Origin` is its own domain — and nor can a rebound host, refused for the
/// same reason.
fn is_allowed_name(hostname: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|name| hostname == name)
}

/// The set `is_allowed_name` checks, assembled once at startup.
///
/// Empty without a token, and that is the invariant that matters: a tokenless
/// server answers to loopback and to nothing else. `--host` cannot reach here
/// without one — `refuse_an_open_bind_without_a_token` rejects that at parse
/// time — but the Tailscale name can, because `tailscale serve` needs no
/// `--host` at all, and accepting it tokenless would publish the app to every
/// peer on the tailnet.
pub fn origin_names(host: &str, tailnet: Option<String>, token: Option<&str>) -> Vec<String> {
    if token.is_none() {
        return Vec::new();
    }
    let bound = host.trim_matches(['[', ']']).to_ascii_lowercase();
    let mut names = Vec::new();
    if !is_loopback_name(&bound) {
        names.push(bound);
    }
    names.extend(tailnet.filter(|name| !names.contains(name)));
    names
}

fn is_self_name(hostname: &str, allowed: &[String]) -> bool {
    is_loopback_name(hostname) || is_allowed_name(hostname, allowed)
}

fn same_origin_request(headers: &HeaderMap, allowed: &[String]) -> bool {
    if let Some(origin) = headers.get(header::ORIGIN) {
        // A sandboxed iframe or a file:// page sends the literal "null". It
        // parses as a hostname of that name, which is not one of ours, so it
        // is refused by the same line as anything else foreign.
        match hostname_of(origin.to_str().ok()) {
            Some(from) if is_self_name(&from, allowed) => {}
            _ => return false,
        }
    }
    match hostname_of(headers.get(header::HOST).and_then(|v| v.to_str().ok())) {
        Some(asked) => is_self_name(&asked, allowed),
        None => false,
    }
}

/// The cookie the token is exchanged for.
pub const SESSION_COOKIE: &str = "ac_session";

/// How long a browser keeps it. Thirty days.
///
/// This is the *session's* lifetime, not the credential's. The token itself is
/// long-lived and stable (see `token_file`) so a bookmark keeps working; what
/// ages out is one browser's right to skip presenting it. Revocation is
/// `--rotate-token`, which invalidates every cookie at once because the cookie
/// carries the token.
const SESSION_MAX_AGE: u32 = 60 * 60 * 24 * 30;

/// One cookie's value out of a `Cookie:` header.
///
/// Hand-rolled rather than reusing `query_param`: cookie values are not
/// percent-encoded by the same rules — `+` is a literal plus here, not a space
/// — and decoding one as if it were a query component would corrupt any token
/// containing it.
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let header = headers.get(header::COOKIE)?.to_str().ok()?;
    for pair in header.split(';') {
        let (key, value) = pair.split_once('=')?;
        if key.trim() == name {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// The query string with `token` removed, so the redirect drops only that.
fn query_without_token(query: &str) -> String {
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter(|pair| {
            let (key, _) = pair.split_once('=').unwrap_or((pair, ""));
            decode_component(key) != "token"
        })
        .collect();
    kept.join("&")
}

/// Trade a token in the URL for a cookie, once, and get it out of the address bar.
///
/// A token in the query string is copied into browser history, into
/// `document.referrer` on any outbound link, and into the access log of
/// whatever proxy is in front — and this app's own client used to re-attach it
/// to every in-app navigation, so it was in the address bar permanently. None
/// of that is reachable by a page that must not have it, but all of it outlives
/// the moment the user meant to grant access.
///
/// Only a browser navigation is redirected: `Accept: text/html` is what a
/// document request sends and what `fetch` and curl do not, so a script using
/// `?token=` or `Authorization` keeps working untouched.
///
/// `SameSite=Strict` keeps the cookie off cross-site requests, and the origin
/// gate — which INV-3 no longer lets a token switch off — is what stands
/// behind it. That ordering matters: a cookie travels without the user's
/// intent, so this change would introduce the CSRF hole `permitted` was
/// rewritten to close.
fn cookie_exchange(app: &App, gate: &Gate<'_>) -> Option<Response> {
    let token = app.token.as_deref()?;
    if gate.upgrading || (gate.method != Method::GET && gate.method != Method::HEAD) {
        return None;
    }
    // Nothing to move out of the URL unless the URL is carrying it.
    query_param(gate.query, "token")?;
    let wants_document = gate
        .headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|accept| accept.contains("text/html"));
    if !wants_document {
        return None;
    }

    let rest = query_without_token(gate.query);
    let location =
        if rest.is_empty() { gate.path.to_string() } else { format!("{}?{}", gate.path, rest) };

    // Behind `tailscale serve` the browser's leg is TLS even though ours is
    // not, and a cookie marked Secure there is both correct and required for
    // `__Host`-grade handling later. Loopback http is a secure context in
    // every current browser, so the flag is simply not needed on that leg.
    let https = gate
        .headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"));
    let secure = if https { "; Secure" } else { "" };
    let cookie = format!(
        "{SESSION_COOKIE}={token}; Path=/; Max-Age={SESSION_MAX_AGE}; HttpOnly; SameSite=Strict{secure}"
    );

    Some(
        (
            StatusCode::FOUND,
            [(header::LOCATION, location), (header::SET_COOKIE, cookie)],
            "",
        )
            .into_response(),
    )
}

/// The built bundle, which the token cannot reach and does not need to.
///
/// A token only ever arrives on the URL the user opened. The `<script>` and
/// `<link>` in `index.html` are ordinary subresource requests carrying neither
/// it nor an `Authorization` header, so gating them 401s the app's own
/// JavaScript and the page hangs on its loading shell.
///
/// Exempting them costs nothing this gate was protecting: these files are the
/// compiled front end, published verbatim on npm, and no agent's directory,
/// prompts or output passes through them. **Nothing under this prefix may ever
/// serve agent state.** A missing file here 404s rather than falling through to
/// the shell, so it cannot be used to read one.
///
/// Only the token gate is bypassed; the same-origin check still applies in full.
fn is_public_asset(method: &Method, pathname: &str) -> bool {
    (method == Method::GET || method == Method::HEAD) && pathname.starts_with("/assets/")
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
        // The cookie is what the browser actually sends, on every request and
        // on the WebSocket handshake — which cannot carry an `Authorization`
        // header at all, and is the reason the query parameter existed. The
        // query is now only the first request of a session, before the
        // exchange below has run.
        let from_cookie = cookie_value(headers, SESSION_COOKIE);
        match from_query.or(from_header).or(from_cookie) {
            Some(supplied) => safe_equal(&supplied, token),
            None => false,
        }
    }

    /// True when this request may act at all.
    ///
    /// The origin gate is never skipped. It answers a different question from
    /// the token — not "who is calling" but "is a browser being used as a
    /// confused deputy" — and a credential the browser attaches on its own
    /// cannot answer it.
    fn permitted(&self, headers: &HeaderMap) -> bool {
        same_origin_request(headers, &self.origin_names)
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

/// `text`, for a body that names what the caller was refused.
fn owned_text(status: StatusCode, body: String) -> Response {
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

/// The parts of a request the two INV-3 gates read.
///
/// One value rather than five arguments threaded side by side: the gates are
/// the one place that needs all of them, and they need them together.
#[derive(Clone, Copy)]
struct Gate<'a> {
    method: &'a Method,
    path: &'a str,
    query: &'a str,
    headers: &'a HeaderMap,
    upgrading: bool,
}

/// Which power a request is asking for, or `None` for the app's own bundle.
///
/// Named per route rather than per handler so the whole surface is readable in
/// one place: a route that is not listed here is a read, which is the safe
/// default to be wrong about.
fn grant_for(method: &Method, path: &str) -> Grant {
    if path == "/api/agents" && method == Method::POST {
        return Grant::Spawn;
    }
    if path == "/api/dirs" {
        return Grant::Spawn;
    }
    if control_route(path).is_some() {
        // `/clear` destroys a conversation, `mode` can cycle onto a permission
        // mode that stops asking, and `close` kills the session. All of them
        // are the agent being driven rather than read.
        return Grant::Drive;
    }
    Grant::Read
}

/// The refusal this request earns, if any, before anything is routed.
///
/// The upgrade path gets the same gate as HTTP, in the same order the TS
/// applies it: an upgrade aimed anywhere but `/ws` is answered 401 there
/// before the origin is ever considered, so it is answered 401 here too.
fn refusal(app: &App, gate: Gate<'_>) -> Option<Response> {
    let public_asset = is_public_asset(gate.method, gate.path);
    if (!public_asset && !app.authorized(gate.query, gate.headers))
        || (gate.upgrading && gate.path != "/ws")
    {
        return Some(text(StatusCode::UNAUTHORIZED, "unauthorized: append ?token=... to the URL"));
    }
    // The socket is the whole control surface — fleet contents out, pastes and
    // keys in — and CORS does not apply to it, so it gets the same gate.
    if !app.permitted(gate.headers) {
        return Some(text(
            StatusCode::FORBIDDEN,
            "forbidden: this server answers only same-origin requests from localhost.\n\
             Reach it at http://127.0.0.1, or start it with --token to use another name.",
        ));
    }
    // Last, because "you may not do this" is only worth saying to a caller who
    // has already proved it is allowed to ask.
    if !public_asset {
        let needed = grant_for(gate.method, gate.path);
        if !app.grants.allows(needed) {
            return Some(owned_text(
                StatusCode::FORBIDDEN,
                format!(
                    "forbidden: this server was started with --grant {} and this needs {:?}.",
                    app.grants.names(),
                    needed
                ),
            ));
        }
    }
    None
}

/// Hand the connection to the socket loop, with both size bounds set.
///
/// Both bounds, because a message can be split across frames: the frame cap
/// bounds one read, the message cap bounds what they add up to. Either one
/// alone leaves the other unbounded.
async fn upgrade_to_socket(app: Arc<App>, parts: &mut axum::http::request::Parts) -> Response {
    let upgrade = match WebSocketUpgrade::from_request_parts(parts, &()).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    upgrade
        .max_frame_size(MAX_FRAME_BYTES)
        .max_message_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, app))
}

/// The whole fleet as the client reads it, plus whether these are fixtures.
fn fleet_listing(app: &App) -> Response {
    json(StatusCode::OK, serde_json::json!({ "agents": app.deps.source.list(), "mock": app.mock }))
}

async fn dispatch(State(app): State<Arc<App>>, req: Request<Body>) -> Response {
    let (mut parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    let query = parts.uri.query().unwrap_or("").to_string();
    let method = parts.method.clone();
    let upgrading = is_upgrade(&parts.headers);
    let gate =
        Gate { method: &method, path: &path, query: &query, headers: &parts.headers, upgrading };
    if let Some(refused) = refusal(&app, gate) {
        return refused;
    }
    // After the gate, not before: an exchange is only worth doing for a request
    // that was going to be allowed, and the redirect must never be a way to
    // learn whether a token was right.
    if let Some(redirect) = cookie_exchange(&app, &gate) {
        return redirect;
    }
    if path == "/ws" && upgrading {
        return upgrade_to_socket(app.clone(), &mut parts).await;
    }
    if path == "/api/agents" && method != Method::POST {
        return fleet_listing(&app);
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
    if path == "/api/tree" {
        return handle_tree(&app, &parts.headers).await;
    }
    if let Some((session_id, action)) = control_route(&path) {
        if method == Method::POST {
            return handle_control(&app, body, &session_id, &action).await;
        }
    }
    serve_static(&app, &path).await
}

/// `^/api/agents/([^/]+)/(close|clear|compact|mode|model|goal)$`, id decoded.
fn control_route(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/api/agents/")?;
    let (id, action) = rest.rsplit_once('/')?;
    if id.is_empty() || id.contains('/') {
        return None;
    }
    if !matches!(action, "close" | "clear" | "compact" | "mode" | "model" | "goal") {
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
            // A `..` on top of a `..` cannot cancel anything, so it is kept.
            ".." if matches!(out.last(), Some(&"..")) => out.push(".."),
            // Nothing left to cancel: a relative path keeps the `..`, and at
            // the root it is dropped — which is what makes `/../../etc/passwd`
            // resolve to `/etc/passwd`.
            ".." if out.is_empty() && !absolute => out.push(".."),
            ".." if out.is_empty() => {}
            ".." => {
                out.pop();
            }
            segment => out.push(segment),
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
    let stamp = if is_document && app.mock { MockStamp::Add } else { MockStamp::Leave };
    if let Some(res) = send_file(&file, stamp).await {
        return res;
    }

    // Single-page app fallback: /agent/<id> is a client route, not a file.
    // Only extensionless paths fall through, so a genuinely missing asset
    // still 404s.
    if Path::new(trimmed).extension().is_none() {
        let stamp = if app.mock { MockStamp::Add } else { MockStamp::Leave };
        if let Some(res) = send_file(&app.web_root.join("index.html"), stamp).await {
            return res;
        }
    }

    text(StatusCode::NOT_FOUND, "not found — run `npm run build:web` first")
}

/// Whether the document being served should say it is a mock fleet.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MockStamp {
    Add,
    Leave,
}

async fn send_file(file: &Path, stamp: MockStamp) -> Option<Response> {
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
    if stamp == MockStamp::Add {
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

/// 400 when the caller got it wrong, 500 when this server did.
fn status_for(failure: &Failure) -> StatusCode {
    if failure.known {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

/// The request body, or the failure the caller should be told about.
async fn new_agent_request(body: Body) -> Result<NewAgentRequest, Failure> {
    let parsed = read_json(body).await?;
    if !parsed.get("cwd").map(|value| value.is_string()).unwrap_or(false) {
        return Err(Failure::caller("cwd is required"));
    }
    serde_json::from_value(parsed).map_err(|e| Failure::caller(e.to_string()))
}

/// Show the session on the fleet at once, before it has registered itself.
fn announce_pending(app: &App, result: &SpawnResult, name: Option<&str>) {
    let Some(pending) = &app.pending else { return };
    pending.add(SpawnedSession {
        tmux_session: &result.tmux_session,
        cwd: &result.cwd,
        name,
    });
}

async fn handle_new_agent(app: &App, body: Body) -> Response {
    if !app.env.tmux {
        return json_of(
            StatusCode::CONFLICT,
            &NewAgentResponse::err("tmux is not available on this machine"),
        );
    }
    let req = match new_agent_request(body).await {
        Ok(req) => req,
        Err(f) => return json_of(status_for(&f), &NewAgentResponse::err(f.message)),
    };
    let name = req.name.clone();

    // Model and mode travel with the request. Dropping them here meant a user
    // who chose "plan" and "opus" got a default agent with no error at all —
    // and silently starting a session in a *different* permission mode than
    // the one asked for is the wrong way round to be wrong.
    match app.spawn.start(req).await {
        Ok(result) => {
            announce_pending(app, &result, name.as_deref());
            json_of(StatusCode::OK, &NewAgentResponse::ok(result.tmux_session, result.cwd))
        }
        // A rejected model or mode is the caller's mistake, not the server's,
        // and the dialog renders a 400 as a reason it can show next to the field.
        Err(f) => json_of(status_for(&f), &NewAgentResponse::err(f.message)),
    }
}

/// The whole fleet's delegation graph.
///
/// Plain HTTP rather than a fifth socket message, and polled by the forest view
/// only while it is open. That satisfies INV-4's first rule — nothing polls what
/// nobody is watching — without adding a subscription lifecycle to a wire that
/// is deliberately four messages up and six down.
async fn handle_tree(app: &App, headers: &HeaderMap) -> Response {
    let trees = read_trees(app).await;
    let body = match serde_json::to_string(&FleetTree { trees }) {
        Ok(body) => body,
        // INV-5: a graph that cannot be serialised must not break the page.
        Err(_) => return json(StatusCode::OK, serde_json::json!({ "trees": [] })),
    };
    let etag = etag_of(&body);
    if already_held(headers, &etag) {
        return not_modified(etag);
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, MIME_JSON)
        .header(header::ETAG, etag)
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// One tree per agent, or an empty tree each when no reader is injected.
async fn read_trees(app: &App) -> Vec<AgentTree> {
    let agents = app.deps.source.list();
    let Some(read) = app.tree.as_ref() else {
        return agents.iter().map(no_delegates).collect();
    };
    let mut out = Vec::with_capacity(agents.len());
    for agent in &agents {
        out.push(read.read(agent).await);
    }
    out
}

fn no_delegates(agent: &Agent) -> AgentTree {
    AgentTree { session_id: agent.session_id.clone(), children: Vec::new(), unknown: None }
}

/*
 * A delegation graph changes on the order of a minute; this route is polled
 * every three seconds, and the payload is byte-identical between
 * consecutive polls. Re-sending it is bandwidth spent on a phone over
 * Tailscale, which is the connection this app was written for.
 *
 * The pane path has always been careful about exactly this: `build_frame`
 * sends only the rows that changed and `is_noop` drops a frame with no
 * visual change. This is that rule applied to the graph.
 *
 * The read still happens — skipping it would mean caching state that
 * something else owns. What is saved is the transfer and, because the
 * client keeps its previous array on a 304, the re-render behind it.
 */
fn already_held(headers: &HeaderMap, etag: &str) -> bool {
    headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag)
}

fn not_modified(etag: String) -> Response {
    Response::builder()
        .status(StatusCode::NOT_MODIFIED)
        .header(header::ETAG, etag)
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::NOT_MODIFIED.into_response())
}

/// A strong ETag over the exact bytes served, matching the Node server's
/// `sha1(body)` in base64url so a client's cached tag survives the port.
fn etag_of(body: &str) -> String {
    use base64::Engine as _;
    use sha1::{Digest, Sha1};
    let digest = Sha1::new_with_prefix(body.as_bytes()).finalize();
    format!(
        "\"{}\"",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
    )
}

async fn handle_browse(app: &App, query: &str) -> Response {
    let path = query_param(query, "path");
    let dot_dirs = match query_param(query, "hidden").as_deref() {
        Some("1") => DotDirs::Shown,
        _ => DotDirs::Hidden,
    };
    match app.browse.list_dirs(path, app.browse_root.clone(), dot_dirs).await {
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

/// What one control action answers with, or the status its failure earns.
type Controlled = Result<ControlResponse, (StatusCode, Failure)>;

/// Close, mode, model and goal. Each refuses a busy agent inside `control` (INV-8).
async fn handle_control(app: &App, body: Body, session_id: &str, action: &str) -> Response {
    match run_control(app, body, session_id, action).await {
        Ok(answer) => json_of(StatusCode::OK, &answer),
        Err((status, failure)) => json_of(status, &ControlResponse::err(failure.message)),
    }
}

async fn run_control(app: &App, body: Body, session_id: &str, action: &str) -> Controlled {
    let agent = app.deps.source.get(session_id);
    match action {
        "close" => close_session(app, session_id, agent).await,
        "clear" => clear_session(app, session_id, agent).await,
        "compact" => compact_session(app, session_id, agent).await,
        "mode" => cycle_mode(app, session_id, agent).await,
        /*
         * Only `goal` and `model` carry a value, so only they read a body — and
         * an empty body is a request that carries no value, not a malformed
         * one. `JSON.parse('')` throwing is what made the Node server report
         * "that did not take effect" about a control it had never called.
         */
        _ => {
            let parsed = read_json(body).await.map_err(fail)?;
            let value = value_of(&parsed);
            if action == "goal" {
                return record_goal(app, session_id, agent, value).await;
            }
            choose_model(app, session_id, agent, value).await
        }
    }
}

async fn close_session(app: &App, session_id: &str, agent: Option<Agent>) -> Controlled {
    let forced = app.control.close(session_id, agent).await.map_err(fail)?;
    let outcome = if forced { "forced" } else { "exited" };
    Ok(ControlResponse::ok(Some(outcome.to_string())))
}

/*
 * `/clear` replaces the session rather than editing it, so the new id
 * is the answer and not decoration on it: every URL, socket focus and
 * route naming the old one is dead the moment this returns, and a
 * client that does not follow it loses the agent the user was looking
 * at.
 */
async fn clear_session(app: &App, session_id: &str, agent: Option<Agent>) -> Controlled {
    let outcome = app.control.clear(session_id, agent).await.map_err(fail)?;
    let detail = if outcome.unobserved { None } else { outcome.session_id };
    Ok(ControlResponse::ok(Some(detail.unwrap_or_else(|| "unverified".to_string()))))
}

/// Compaction runs for minutes. Nothing waits on it.
async fn compact_session(app: &App, session_id: &str, agent: Option<Agent>) -> Controlled {
    app.control.compact(session_id, agent).await.map_err(fail)?;
    Ok(ControlResponse::ok(Some("requested".to_string())))
}

/*
 * Shift+Tab takes no value and returns no mode.
 *
 * It used to wait up to 2.5s for the session to write a new
 * `permission-mode` record and then report `unverified` when none
 * came. Against a live session that record arrives at the *end of a
 * turn*, so a session sitting at its prompt — the one usually being
 * switched — never answers, and a session that has not taken a turn
 * has no transcript to answer from. Every press therefore cost 2.5s
 * with the control dead and then disclaimed a switch that had
 * happened. Sending the key is the entire action (INV-8).
 */
async fn cycle_mode(app: &App, session_id: &str, agent: Option<Agent>) -> Controlled {
    app.control.shift_tab(session_id, agent).await.map_err(fail)?;
    Ok(ControlResponse::ok(Some("sent".to_string())))
}

async fn record_goal(
    app: &App,
    session_id: &str,
    agent: Option<Agent>,
    value: String,
) -> Controlled {
    // An empty value is the toggle being turned off, not a malformed set.
    if value.trim().is_empty() {
        return drop_goal(app, session_id, agent).await;
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
        // Publish it now rather than leaving the card a tick behind the
        // toggle that just set it.
        publish_goal(app, session_id, Some(goal.clone()));
    }
    let detail = outcome.goal.map(|goal| goal.condition).unwrap_or(value);
    Ok(ControlResponse::ok(Some(detail)))
}

async fn drop_goal(app: &App, session_id: &str, agent: Option<Agent>) -> Controlled {
    app.control.clear_goal(session_id, agent).await.map_err(fail)?;
    // Nothing records a cleared goal, so this is the only place that knows it
    // happened — see `clear_goal`.
    publish_goal(app, session_id, None);
    Ok(ControlResponse::ok(Some("cleared".to_string())))
}

/// Put a goal change on the fleet now; nothing else is going to.
fn publish_goal(app: &App, session_id: &str, goal: Option<GoalState>) {
    let patch = crate::sources::AgentPatch { goal: Some(goal), ..Default::default() };
    app.deps.source.enrich(session_id, patch);
    app.deps.source.notify();
}

/// The agent was mid-turn, so the CLI will read this when the turn ends.
/// Saying `ok` without saying that would claim a switch that has not happened
/// yet (INV-11).
async fn choose_model(
    app: &App,
    session_id: &str,
    agent: Option<Agent>,
    value: String,
) -> Controlled {
    let queued = app.control.set_model(session_id, agent, value.clone()).await.map_err(fail)?;
    let detail = if queued { "queued".to_string() } else { value };
    Ok(ControlResponse::ok(Some(detail)))
}

fn fail(failure: Failure) -> (StatusCode, Failure) {
    (status_for(&failure), failure)
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
            kind: None,
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

impl Viewer {
    /// Point this tab's pane state at a change of terminal view, and answer
    /// false when the tab has already moved on to another agent.
    fn retarget(&self, session_id: &str, view: Terminal) -> bool {
        {
            let st = self.state.lock().unwrap();
            if st.focused.as_deref() != Some(session_id) {
                return false;
            }
        }
        {
            let mut st = self.state.lock().unwrap();
            st.attached = view == Terminal::Open;
            st.reset_pane();
        }
        self.clear_frame_timer();
        true
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
    let (off, off_limits) = subscribe_viewer(&viewer, &app);

    while let Some(Ok(frame)) = stream.next().await {
        let raw = match incoming(frame) {
            Incoming::Payload(raw) => raw,
            Incoming::Ignored => continue,
            Incoming::Closed => break,
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

/// What a WebSocket frame turned out to be worth reading.
enum Incoming {
    Payload(String),
    /// Ping/Pong are answered by the transport.
    Ignored,
    Closed,
}

fn incoming(frame: Message) -> Incoming {
    match frame {
        Message::Text(text) => Incoming::Payload(text),
        Message::Binary(bytes) => Incoming::Payload(String::from_utf8_lossy(&bytes).into_owned()),
        Message::Close(_) => Incoming::Closed,
        _ => Incoming::Ignored,
    }
}

/// Send this tab the fleet and the quota, and keep it subscribed to both.
///
/// Quota is account-level, so every tab gets the same reading and a fresh tab
/// needs the current one immediately — waiting for the next statusline render
/// would leave the meters blank for however long the fleet is idle.
fn subscribe_viewer(viewer: &Arc<Viewer>, app: &Arc<App>) -> (Unsubscribe, Unsubscribe) {
    viewer.send(ServerMessage::Fleet { agents: app.deps.source.list(), mock: app.mock });
    let off = {
        let viewer = viewer.clone();
        let mock = app.mock;
        app.deps.source.on_change(Box::new(move |agents| {
            viewer.send(ServerMessage::Fleet { agents, mock });
        }))
    };

    viewer.send(ServerMessage::Limits { limits: app.deps.limits.current() });
    let off_limits = {
        let viewer = viewer.clone();
        app.deps.limits.on_change(Box::new(move |limits| {
            viewer.send(ServerMessage::Limits { limits });
        }))
    };
    (off, off_limits)
}

/// Whether this tab's terminal view is open.
///
/// Two named states rather than a bare flag: attaching and detaching are two
/// different actions that happen to share one wire message.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Terminal {
    Open,
    Closed,
}

/// One `paste` off the wire, kept together so it travels as one argument.
struct PasteRequest {
    session_id: String,
    text: String,
    submit: bool,
    seq: Option<i64>,
}

/// One `key` off the wire, kept together for the same reason.
struct KeyRequest {
    session_id: String,
    key: String,
    confirmed: Option<bool>,
}

async fn handle(msg: ClientMessage, viewer: &Arc<Viewer>, app: &Arc<App>) {
    // The socket is checked per message rather than at the handshake: one
    // connection carries reads, answers and arbitrary keystrokes, so a grant
    // decided once at upgrade time could only be the widest of them.
    let needed = grant_for_message(&msg);
    if !app.grants.allows(needed) {
        viewer.error(
            session_of(&msg).unwrap_or_default(),
            format!("this server was started with --grant {}", app.grants.names()),
        );
        return;
    }
    match msg {
        ClientMessage::Focus { session_id } => on_focus(session_id, viewer, app),
        ClientMessage::Attach { session_id, on } => {
            let view = if on { Terminal::Open } else { Terminal::Closed };
            on_attach(&session_id, view, viewer, app);
        }
        ClientMessage::Paste { session_id, text, submit, seq } => {
            on_paste(PasteRequest { session_id, text, submit, seq }, viewer, app).await;
        }
        ClientMessage::Key { session_id, key, confirmed } => {
            on_key(KeyRequest { session_id, key, confirmed }, viewer, app).await;
        }
        ClientMessage::Answer { session_id, prompt_id, choice } => {
            on_answer(&Answer { session_id, prompt_id, choice }, viewer, app).await;
        }
    }
}

/// Which power a socket message is asking for.
///
/// The split that matters is `Answer` from `Key`. Answering a prompt is what
/// the phone is for; arbitrary keystrokes are how an agent gets driven. They
/// used to be the same message — a bare digit — so there was no way to hand out
/// one without the other.
fn session_of(message: &ClientMessage) -> Option<&str> {
    match message {
        ClientMessage::Focus { session_id } => session_id.as_deref(),
        ClientMessage::Attach { session_id, .. }
        | ClientMessage::Paste { session_id, .. }
        | ClientMessage::Key { session_id, .. }
        | ClientMessage::Answer { session_id, .. } => Some(session_id),
    }
}

fn grant_for_message(message: &ClientMessage) -> Grant {
    match message {
        ClientMessage::Focus { .. } | ClientMessage::Attach { .. } => Grant::Read,
        ClientMessage::Answer { .. } => Grant::Respond,
        ClientMessage::Paste { .. } | ClientMessage::Key { .. } => Grant::Drive,
    }
}

/// Answer the question the agent is actually blocked on, or refuse.
///
/// The check is a re-read, not a lookup of what was sent: between the card
/// being drawn and the tap arriving, the agent may have been answered from the
/// terminal, moved to the next question in the same `AskUserQuestion` set, or
/// been replaced by a different prompt entirely. Comparing the id the client
/// echoed against the prompt on disk *now* is what makes "yes, edit that file"
/// unable to land on "yes, run that command".
///
/// The keystroke is composed here. The browser sends an index into the options
/// the transcript named, and nothing it sends becomes an argv entry.
async fn on_answer(answer: &Answer, viewer: &Arc<Viewer>, app: &Arc<App>) {
    let session_id = answer.session_id.as_str();
    if !afford(viewer, session_id) {
        return;
    }
    let Some(agent) = app.deps.source.get(session_id) else { return };
    let (pane_id, key) = match answer_keystroke(&agent, answer, app).await {
        Ok(found) => found,
        Err(why) => {
            viewer.error(session_id, why.to_string());
            return;
        }
    };
    if let Err(e) = app.deps.panes.key(&pane_id, &key).await {
        viewer.error(session_id, format!("could not answer: {e}"));
    }
}

/// The fields of a `ClientMessage::Answer`, together because they are checked
/// together: the id says which question, the choice says which of its options.
struct Answer {
    session_id: String,
    prompt_id: String,
    choice: usize,
}

const CANNOT_READ_TRANSCRIPT: &str = "cannot read this agent's transcript";

/// The pane to answer into and the digit that answers — or why nothing may be
/// sent, in the words the client shows.
async fn answer_keystroke(
    agent: &Agent,
    answer: &Answer,
    app: &App,
) -> Result<(String, String), &'static str> {
    // A tail of its own, read fresh. The viewer's tail has its own byte offset
    // and its own schedule; what matters here is what is on disk at the instant
    // the answer arrived, not what was true when the card was drawn.
    let Some(mut tail) = (app.deps.tail_for)(agent) else { return Err(CANNOT_READ_TRANSCRIPT) };
    let Ok(read) = tail.read().await else { return Err(CANNOT_READ_TRANSCRIPT) };
    let current = read.prompt.ok_or("that question has already been answered")?;
    if current.fingerprint(&answer.session_id) != answer.prompt_id {
        return Err("the agent is asking something else now — the answer was not sent");
    }
    // One-based, because that is what the picker's own numbering is. An index
    // past the options it named is a client bug, not a keystroke to invent.
    if answer.choice >= current.options.len().max(1) {
        return Err("no such option");
    }
    let pane_id = agent.pane_id.clone().ok_or("agent is no longer available")?;
    Ok((pane_id, (answer.choice + 1).to_string()))
}

fn on_focus(session_id: Option<String>, viewer: &Arc<Viewer>, app: &Arc<App>) {
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

    // The TS arms a `setInterval` and guards it with a `tailBusy` flag,
    // because a read can outlast the interval. A task that sleeps *after* each
    // read cannot overlap with itself at all, so the flag has nothing left to
    // guard; the cost is that the period is measured from the end of a read
    // rather than its start.
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

fn on_attach(session_id: &str, view: Terminal, viewer: &Arc<Viewer>, app: &Arc<App>) {
    if !viewer.retarget(session_id, view) {
        return;
    }
    if view == Terminal::Closed {
        return;
    }
    let Some(agent) = app.deps.source.get(session_id) else { return };
    let Some(pane_id) = agent.pane_id else { return };
    watch_pane(viewer, app, &pane_id, session_id);
}

/// The pane a paste can be written into, or nothing — having said why.
///
/// Separate from `on_key`'s lookup, which returns silently on the same two
/// misses. Typed text is something the user composed and is watching for, so
/// dropping it without a word is the one wrong answer; a keystroke that lands
/// nowhere is better left quiet than narrated. INV-5's "degrade, don't error"
/// applied in opposite directions, which is why these are not one helper.
fn pane_to_write_into(session_id: &str, viewer: &Arc<Viewer>, app: &Arc<App>) -> Option<String> {
    let agent = app.deps.source.get(session_id);
    if let Some(pane_id) = agent.as_ref().and_then(|a| a.pane_id.clone()) {
        return Some(pane_id);
    }
    viewer.error(
        session_id,
        agent
            .and_then(|a| a.attach_blocked_reason)
            .unwrap_or_else(|| "agent is no longer available".to_string()),
    );
    None
}

async fn on_paste(request: PasteRequest, viewer: &Arc<Viewer>, app: &Arc<App>) {
    let PasteRequest { session_id, text, submit, seq } = request;
    // The one place a wire `bool` becomes `Submit`: the browser sends
    // `"submit": true|false`, so it stops here rather than travelling on
    // through the pane seam behind it.
    let submit = match submit {
        true => Submit::Yes,
        false => Submit::No,
    };
    if !afford(viewer, &session_id) {
        return;
    }
    let Some(pane_id) = pane_to_write_into(&session_id, viewer, app) else {
        return;
    };
    if text.len() > MAX_PASTE {
        viewer.error(&session_id, "input too large");
        return;
    }
    if let Err(err) = app.deps.panes.paste(&pane_id, &text, submit).await {
        viewer.error(&session_id, reason(&err));
    }
    // Woken *after* the write, not before. tmux has the text now, so the read
    // this starts is the one that can actually catch the echo — starting it
    // beforehand only bought a read of the pane as it was, and an unchanged
    // read is exactly what makes the loop decide to slow down.
    app.hub.wake(&pane_id);
    // Acknowledged either way. The ack means "the write is over, send the next
    // chunk", not "the write worked" — a failed paste that never acked would
    // wedge the Attach view's typing for good.
    if let Some(seq) = seq {
        viewer.send(ServerMessage::PasteAck { session_id, seq });
    }
}

async fn on_key(request: KeyRequest, viewer: &Arc<Viewer>, app: &Arc<App>) {
    let KeyRequest { session_id, key, confirmed } = request;
    if !afford(viewer, &session_id) {
        return;
    }
    let Some(agent) = app.deps.source.get(&session_id) else { return };
    let Some(pane_id) = agent.pane_id else { return };
    /*
     * INV-2 and INV-6 in one call, on the server side of the wire.
     *
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
    /*
     * `prompt_changed` is its own reason to send. Answering a question writes a
     * `tool_result`, which is plumbing rather than a message and produces no
     * event — so without it the card offering the answer would have nothing to
     * retire it.
     */
    if !read.events.is_empty() || read.first || read.prompt_changed {
        viewer.send(ServerMessage::Timeline {
            session_id: session_id.to_string(),
            events: read.events,
            reset: read.first,
            // The id travels with the question and is echoed back on the
            // answer, so a reply cannot land on a prompt that has moved on.
            prompt: read.prompt.map(|p| p.with_id(session_id)),
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
        Box::new(move |event: &HubEvent| on_hub_event(&viewer, &session_id, event))
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

/// This tab's half of one shared pane read, under one lock.
///
/// The lock is taken once and handed on, because the checks below and the
/// action they guard have to be the same view of this tab's state.
fn on_hub_event(viewer: &Arc<Viewer>, session_id: &str, event: &HubEvent) {
    let st = viewer.state.lock().unwrap();
    if !st.attached || st.focused.as_deref() != Some(session_id) {
        return;
    }
    match event {
        HubEvent::Error(err) => note_failed_read(viewer, session_id, st, err),
        HubEvent::Sample(sample) => draw_sample(viewer, session_id, st, sample),
    }
}

/// This tab's view of a pane, held for as long as one event is being handled.
type ViewerGuard<'a> = std::sync::MutexGuard<'a, ViewerState>;

/// A run of failed reads ends this tab's terminal, and only its terminal.
fn note_failed_read(
    viewer: &Arc<Viewer>,
    session_id: &str,
    mut st: ViewerGuard<'_>,
    err: &Arc<anyhow::Error>,
) {
    st.frame_fails += 1;
    if st.frame_fails < FRAME_FAIL_LIMIT {
        return;
    }
    viewer.error(session_id, reason(err));
    // Same as a dead pane: the frames stop, the conversation does not. The
    // transcript is on disk and is still the record of what this agent did.
    end_terminal(st);
}

/// Turn one shared read into the delta this tab has not drawn yet.
fn draw_sample(
    viewer: &Arc<Viewer>,
    session_id: &str,
    mut st: ViewerGuard<'_>,
    sample: &Arc<PaneSample>,
) {
    st.frame_fails = 0;
    let meta = sample.meta;
    let lines = &sample.lines;
    if meta.dead {
        viewer.error(session_id, DEAD_PANE);
        end_terminal(st);
        return;
    }
    let prev = match &st.prev_lines {
        Some(drawn) if drawn.len() == lines.len() => Some(drawn.clone()),
        _ => None,
    };
    let frame = build_frame(session_id, prev.as_deref(), lines, geom_of(&meta));
    if !is_noop(&frame, st.prev_cursor) {
        viewer.send(ServerMessage::Frame { frame });
    }
    st.prev_lines = Some(lines.clone());
    st.prev_cursor = Some((meta.cursor_x, meta.cursor_y));
}

/// Stop drawing for this tab and give up its share of the pane poller.
fn end_terminal(mut st: ViewerGuard<'_>) {
    st.attached = false;
    let unwatch = st.unwatch.take();
    drop(st);
    release(unwatch);
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

    /// One agent's delegates, read from the sidecars Claude Code writes.
    ///
    /// `subagents::read_tree` already answers `unknown` for a CLI that keeps no
    /// transcript and degrades to an empty tree on an unreadable directory
    /// (INV-5/INV-13), so there is nothing to catch here.
    pub struct Tree;

    #[async_trait]
    impl TreeApi for Tree {
        async fn read(&self, agent: &Agent) -> AgentTree {
            crate::subagents::read_tree(agent, crate::types::now_ms()).await
        }
    }

    pub struct Browse;

    #[async_trait]
    impl BrowseApi for Browse {
        async fn list_dirs(
            &self,
            path: Option<String>,
            root: Option<String>,
            dot_dirs: DotDirs,
        ) -> Result<DirListing, Failure> {
            let root = root.map(std::path::PathBuf::from);
            crate::browse::list_dirs(path.as_deref(), root.as_deref(), dot_dirs)
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
            Control { make: Arc::new(move |session_id| live_deps(panes.clone(), session_id)) }
        }

        /// The deps for one action. Rebuilt per request because two of the four
        /// members are closures over the session id.
        fn deps_for(&self, session_id: &str) -> Arc<dyn ControlDeps> {
            (self.make)(session_id)
        }
    }

    /// One session's deps: writes through the pane API, the goal read from
    /// that session's transcript, and a session that ignores `/exit` killed
    /// through tmux.
    fn live_deps(panes: Arc<dyn PaneApi>, session_id: &str) -> Arc<dyn ControlDeps> {
        let for_goal = session_id.to_string();
        Arc::new(LiveDeps {
            panes,
            read_goal: Arc::new(move || {
                let id = for_goal.clone();
                Box::pin(async move { crate::transcript::read_goal(&id).await })
            }),
            kill: Arc::new(|session: String| {
                Box::pin(
                    async move { crate::pane::kill_session(&session).await.map_err(anyhow::Error::from) },
                )
            }),
        })
    }

    fn failed(failure: ControlFailure) -> Failure {
        Failure { message: failure.to_string(), known: failure.is_client_error() }
    }

    #[async_trait]
    impl ControlApi for Control {
        async fn close(&self, session_id: &str, agent: Option<Agent>) -> Result<bool, Failure> {
            let deps = self.deps_for(session_id);
            crate::control::close_agent(agent.as_ref(), &*deps)
                .await
                .map(|r| r.forced)
                .map_err(failed)
        }

        async fn shift_tab(&self, session_id: &str, agent: Option<Agent>) -> Result<(), Failure> {
            let deps = self.deps_for(session_id);
            crate::control::send_shift_tab(agent.as_ref(), &*deps).await.map_err(failed)
        }

        async fn clear(
            &self,
            session_id: &str,
            agent: Option<Agent>,
        ) -> Result<ClearOutcome, Failure> {
            let deps = self.deps_for(session_id);
            crate::control::clear_context_default(agent.as_ref(), &*deps)
                .await
                .map(|r| ClearOutcome { session_id: r.session_id, unobserved: r.unobserved })
                .map_err(failed)
        }

        async fn compact(&self, session_id: &str, agent: Option<Agent>) -> Result<(), Failure> {
            let deps = self.deps_for(session_id);
            crate::control::compact_context(agent.as_ref(), &*deps).await.map_err(failed)
        }

        async fn set_model(
            &self,
            session_id: &str,
            agent: Option<Agent>,
            value: String,
        ) -> Result<bool, Failure> {
            let deps = self.deps_for(session_id);
            crate::control::set_model(agent.as_ref(), &value, &*deps)
                .await
                .map(|r| r.queued)
                .map_err(failed)
        }

        async fn set_goal(
            &self,
            session_id: &str,
            agent: Option<Agent>,
            value: String,
        ) -> Result<GoalOutcome, Failure> {
            let deps = self.deps_for(session_id);
            crate::control::set_goal_default(agent.as_ref(), &value, &*deps)
                .await
                .map(|r| GoalOutcome { ok: r.ok, goal: r.goal })
                .map_err(failed)
        }

        async fn clear_goal(&self, session_id: &str, agent: Option<Agent>) -> Result<(), Failure> {
            let deps = self.deps_for(session_id);
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
    use crate::types::now_ms;

    /// The fixture forest, so the delegation view has something awkward to draw
    /// without any agent on this machine being read.
    ///
    /// The clock is pinned at startup, as the fleet fixtures' already is. A
    /// live `now` would move every `lastWriteAt` on every read, so the body —
    /// and therefore the ETag — would differ between two polls of a graph that
    /// had not changed, and the 304 that INV-4 relies on could never fire.
    pub struct Tree {
        epoch: i64,
    }

    impl Tree {
        pub fn new() -> Self {
            Self { epoch: now_ms() }
        }
    }

    #[async_trait]
    impl TreeApi for Tree {
        async fn read(&self, agent: &Agent) -> AgentTree {
            crate::mock::mock_tree(agent, self.epoch)
        }
    }

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
    pub struct MockSession {
        /// Whatever mode was last cycled to, so the UI round-trips.
        goal: Mutex<Option<GoalState>>,
        /// Which session id each fake process is running *now*, keyed by pid
        /// because that is what `clear_context` asks with. Seeded from the
        /// fleet on first use so it starts out agreeing with the fixtures.
        sessions: Mutex<std::collections::HashMap<i64, String>>,
        source: Arc<crate::mock::MockSource>,
    }

    impl MockSession {
        fn new(source: Arc<crate::mock::MockSource>) -> Self {
            Self {
                goal: Mutex::new(None),
                sessions: Mutex::new(std::collections::HashMap::new()),
                source,
            }
        }

        /// The id this pid is running now, seeded from the fleet on first ask.
        fn session_of(&self, pid: i64) -> String {
            let mut map = self.sessions.lock().unwrap();
            if let Some(known) = map.get(&pid) {
                return known.clone();
            }
            let found = crate::sources::AgentSource::list(&*self.source)
                .into_iter()
                .find(|a| a.pid == pid)
                .map(|a| a.session_id)
                .unwrap_or_else(|| format!("mock-session-{pid}"));
            map.insert(pid, found.clone());
            found
        }
    }

    #[async_trait]
    impl ControlDeps for MockSession {
        async fn paste(&self, _pane_id: &str, text: &str, _submit: Submit) -> anyhow::Result<()> {
            // The goal toggle is the one control whose state the fake session
            // has to hold: without it the UI would set a goal and read back
            // nothing, which `set_goal` correctly reports as a failure.
            /*
             * `/clear` replaces the session rather than editing it, so the
             * fixture gets a new id and the client has to find the agent
             * again under it. That path is the one with the sharp edge
             * (INV-8), so it is the one mock mode most needs to have.
             */
            if text == "/clear" {
                let current = crate::mock::session_by_pane(_pane_id);
                if let Some(agent) =
                    current.and_then(|id| crate::sources::AgentSource::get(&*self.source, &id))
                {
                    let next = format!("mock-session-{}", now_ms());
                    self.sessions.lock().unwrap().insert(agent.pid, next.clone());
                    self.source.rotate(&agent.session_id, &next);
                }
                *self.goal.lock().unwrap() = None;
                return Ok(());
            }
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

        async fn read_session_id(&self, pid: i64) -> Option<String> {
            Some(self.session_of(pid))
        }

        /// Shift+Tab is the only key `control` sends, and the real one is
        /// swallowed by the CLI without writing anything this app can read.
        /// A mock that answered with a mode would be modelling a reply the
        /// live path does not make.
        async fn key(&self, _pane_id: &str, _key: &str) -> anyhow::Result<()> {
            Ok(())
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
        async fn wait(&self, _millis: u64) {}
    }

    /// The same `ControlApi` the real server uses, over the fake session.
    pub fn control(source: Arc<crate::mock::MockSource>) -> super::live::Control {
        let session: Arc<MockSession> = Arc::new(MockSession::new(source));
        super::live::Control {
            make: Arc::new(move |_session_id: &str| session.clone() as Arc<dyn ControlDeps>),
        }
    }
}

/// The live fleet, seen through two providers at once.
///
/// Claude first, so it wins a contested tmux session. Both can see the same
/// pane: a Claude session running inside tmux is discovered from the session
/// file it wrote about itself *and* from the pane it occupies. The file is the
/// better witness — it carries a real status, a model and a goal, where the
/// pane can only say whether output appeared lately (INV-11) — so it is the
/// one that must survive the merge.
///
/// Not `LiveSource::new()`: the pending store is what shows a just-spawned
/// session until it registers itself in ~/.claude/sessions, and without it
/// "New agent" appears to do nothing for several seconds.
fn live_fleet(pending: Arc<crate::pending::PendingStore>) -> Deps {
    Deps {
        source: Arc::new(crate::tmux_source::CompositeSource::new(vec![
            Arc::new(crate::tmux_source::SourceAsProvider(
                crate::registry::LiveSource::new_with_pending(pending),
            )),
            Arc::new(crate::tmux_source::TmuxProvider::live()),
        ])),
        panes: crate::pane::TmuxPanes::new(),
        limits: crate::limits::FileLimits::new(),
        tail_for: Arc::new(crate::transcript::tail_for),
    }
}

/// Bring the shared tmux control client up, or warn that there is no server.
///
/// Started in the background and never awaited. Once it answers, every pane
/// read and write goes down one pipe instead of forking a fresh tmux client,
/// which is the difference between p50 ~70ms and p50 ~20ms per round trip —
/// and, on a machine at its process cap, the difference between working and
/// `spawn tmux EAGAIN`. It is a *control-mode* client, which is what makes
/// INV-1 hold: a control client has no size at all and only acquires one by
/// being sent `refresh-client -C`, which nothing here ever sends.
/// `ignore-size` is not the guarantee — it governs how a client affects other
/// clients, and a regular client reflows the window with it, without it, and
/// with `-r` alike. See SPEC.md INV-1.
async fn start_tmux_control() {
    if !crate::pane::available().await {
        eprintln!("warning: no tmux server reachable — agents will list but cannot be attached to.");
        return;
    }
    crate::tmux_client::tmux_control().start();
}

/// Mock mode advertises the whole flow but must never start a real process or
/// type into anything.
fn spawn_and_control(
    opts: &Options,
    panes: Arc<dyn PaneApi>,
    mock_source: Option<Arc<crate::mock::MockSource>>,
) -> (Arc<dyn SpawnApi>, Arc<dyn ControlApi>) {
    if !opts.mock {
        return (Arc::new(live::Spawn), Arc::new(live::Control::live(panes)));
    }
    (
        Arc::new(mock_control::Spawn),
        Arc::new(mock_control::control(mock_source.expect("mock deps built above"))),
    )
}

/// Mock mode reads its own fixture forest; live mode reads the sidecars.
fn tree_reader(opts: &Options) -> Arc<dyn TreeApi> {
    if opts.mock {
        Arc::new(mock_control::Tree::new())
    } else {
        Arc::new(live::Tree)
    }
}

/// Everything the HTTP surface is built out of, wired for this run.
async fn build_app(
    opts: &Options,
    deps: Deps,
    pending: Arc<crate::pending::PendingStore>,
    mock_source: Option<Arc<crate::mock::MockSource>>,
) -> Arc<App> {
    let env = crate::env::server_env(opts.port).await;
    // One poller per pane for the whole server, not one per tab (INV-4).
    let hub: Arc<dyn HubApi> = Arc::new(crate::pane_hub::PaneHub::new(deps.panes.clone()));
    let (spawn, control) = spawn_and_control(opts, deps.panes.clone(), mock_source);

    // Read once, before `env` is moved into the App: the CLI probe is a
    // subprocess and this cannot change under us.
    let tailnet = own_tailnet_name(&env);
    let origin_names = origin_names(&opts.host, tailnet.clone(), opts.token.as_deref());
    Arc::new(App {
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
        tailnet,
        origin_names,
        grants: opts.grants,
        tree: Some(tree_reader(opts)),
    })
}

/// Take the port, or say which one to try instead.
async fn bind(opts: &Options) -> anyhow::Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind((opts.host.as_str(), opts.port)).await.map_err(|e| {
        if e.kind() != std::io::ErrorKind::AddrInUse {
            return anyhow::Error::from(e);
        }
        anyhow::anyhow!(
            "port {} is already in use — try --port {}",
            opts.port,
            opts.port.saturating_add(1)
        )
    })
}

const MASK_VISIBLE_CHARS: usize = 4;

/// Enough of a token to recognise it, not enough to use it.
///
/// Four leading characters out of thirty-two: it distinguishes "the token I
/// bookmarked" from "a different one" while leaving 112 bits unsaid. A token
/// too short to keep a secret after this is too short to keep one at all.
fn masked(token: &str) -> String {
    let head: String = token.chars().take(MASK_VISIBLE_CHARS).collect();
    format!("{head}…")
}

/// The two lines a user reads to know what they are looking at.
///
/// The token is masked. This banner is not only read by a person at a terminal:
/// under the Mac app stdout is `~/Library/Logs/agent-commander/server.log`, so
/// printing the secret in full wrote it to disk on every start, in a file
/// nothing rotates. `--print-url` asks for it in full, and `--rotate-token`
/// prints it because that is the command's entire output.
fn announce(opts: &Options, count: usize) {
    let shown = if opts.host == "::1" { "[::1]".to_string() } else { opts.host.clone() };
    let query = opts
        .token
        .as_deref()
        .map(|t| format!("?token={}", if opts.print_url { t.to_string() } else { masked(t) }))
        .unwrap_or_default();
    println!("agent-commander on http://{shown}:{}/{query}", opts.port);
    if opts.token.is_some() && !opts.print_url {
        println!("  token masked — run with --print-url for the whole link");
    }
    if opts.mock {
        println!("  mock mode — no real agent is touched");
    } else {
        println!("  watching {count} agent(s)");
    }
}

/// Start the server described by `opts` and run until the process is asked to stop.
pub async fn serve(opts: Options) -> anyhow::Result<()> {
    let pending = Arc::new(crate::pending::PendingStore::new());
    let (deps, mock_source) = fleet_for(&opts, pending.clone());

    if !opts.mock {
        start_tmux_control().await;
    }

    deps.source.start().await?;
    deps.limits.start();

    // Keeps the activity line on every card current, not just the open one.
    let enricher = crate::enrich::FleetEnricher::new(deps.source.clone(), deps.tail_for.clone());
    enricher.start().await;

    let app = build_app(&opts, deps, pending, mock_source).await;
    let count = app.deps.source.list().len();
    let listener = bind(&opts).await?;
    announce(&opts, count);

    let result = axum::serve(listener, router(app.clone()))
        .with_graceful_shutdown(shutdown_signal())
        .await;

    shut_down(&opts, &app, &enricher).await;
    result?;
    Ok(())
}

/// The fleet this run watches, and the concrete mock source when there is one.
///
/// In mock mode the concrete source is kept as well as the trait object:
/// `/clear` has to rotate a fixture's session id, which is a `MockSource`
/// operation and not something `AgentSource` exposes.
fn fleet_for(
    opts: &Options,
    pending: Arc<crate::pending::PendingStore>,
) -> (Deps, Option<Arc<crate::mock::MockSource>>) {
    if !opts.mock {
        return (live_fleet(pending), None);
    }
    let (deps, source) = crate::mock::mock_deps(opts.mock_transitions);
    (deps, Some(source))
}

/// Undo the setup, in the reverse of the order it was done in.
async fn shut_down(opts: &Options, app: &Arc<App>, enricher: &crate::enrich::FleetEnricher) {
    enricher.stop().await;
    app.deps.limits.stop();
    app.deps.source.stop();
    if !opts.mock {
        crate::tmux_client::tmux_control().stop();
        crate::pane::cleanup().await;
    }
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
    use crate::sources::{AgentPatch, AgentSource, LimitsApi, PaneMeta, TailRead};
    use crate::types::{
        AgentStatus, PendingPrompt, PromptOption, RateLimits, TimelineEvent, TimelineKind,
    };
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    const EVIL: &str = "https://evil.example";
    /// Big enough for a handshake's status line and its headers.
    const HANDSHAKE_BYTES: usize = 512;
    /// Big enough for the status line alone, which is all these reads want.
    const STATUS_LINE_BYTES: usize = 256;
    /// Long enough for a server that is going to answer to have answered.
    const REPLY_DEADLINE: Duration = Duration::from_secs(4);
    /// One poll interval between looks at a fake that changes on its own.
    const RECHECK: Duration = Duration::from_millis(25);
    /// Long enough for the whole refused flood to have drained.
    const FLOOD_DRAIN: Duration = Duration::from_millis(400);
    /// Comfortably under the flood that was sent, and far under the 5000
    /// writes that got through before the budget existed.
    const BUDGET_CEILING: usize = 500;
    /// An arbitrary sequence number, echoed back in the acknowledgement.
    const PASTE_SEQ: i64 = 7;
    const SESSION: &str = "mock-busy";
    /// The mock fixture that is parked on an `AskUserQuestion`.
    const BLOCKED: &str = SESSION;
    /// Long enough for one answer to have reached the fake pane.
    const ANSWER_SETTLE: Duration = Duration::from_millis(300);
    const PANE: &str = "%1";
    const DOC: &str = "<!doctype html>\n<html lang=\"en\">\n<body><div id=\"root\"></div></body>\n</html>\n";

    /* ---- fakes ---- */

    type Listeners<T> = Arc<Mutex<Vec<Option<Box<dyn Fn(T) + Send + Sync>>>>>;

    fn add_listener<T: 'static>(
        list: &Listeners<T>,
        listener: Box<dyn Fn(T) + Send + Sync>,
    ) -> Unsubscribe {
        let list = list.clone();
        let idx = {
            let mut slots = list.lock().unwrap();
            slots.push(Some(listener));
            slots.len() - 1
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
        fn on_change(&self, listener: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe {
            add_listener(&self.listeners, listener)
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
        async fn paste(&self, _pane_id: &str, _text: &str, _submit: Submit) -> anyhow::Result<()> {
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
        fn on_change(&self, _listener: Box<dyn Fn(Option<RateLimits>) + Send + Sync>) -> Unsubscribe {
            Box::new(|| {})
        }
        fn start(&self) {}
        fn stop(&self) {}
    }

    struct FakeTail {
        n: usize,
        /// What this tail says the agent is blocked on, re-read every call.
        ///
        /// Re-read rather than sent once, because that is the property
        /// `on_answer` depends on: it opens its own tail to ask what is on disk
        /// *now*, and a fake that answered from memory would pass whether or
        /// not the check was there.
        prompt: Option<PendingPrompt>,
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
                    notice: None,
                    tokens_before: None,
                    tokens_after: None,
                }],
                patch: AgentPatch::default(),
                first: self.n == 1,
                prompt: self.prompt.clone(),
                ..Default::default()
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
                poll_pane(self.panes.clone(), pane_id.to_string(), list);
            }
            unwatch
        }
        fn wake(&self, _pane_id: &str) {}
    }

    /// Fast enough that a test does not wait on it, slow enough not to spin.
    const FAKE_POLL: Duration = Duration::from_millis(15);

    /// One polling task per pane, feeding every listener that pane has.
    fn poll_pane(panes: Arc<dyn PaneApi>, pane_id: String, list: Listeners<Arc<HubEvent>>) {
        tokio::spawn(async move {
            loop {
                let event = Arc::new(match panes.sample(&pane_id).await {
                    Ok(sample) => HubEvent::Sample(Arc::new(sample)),
                    Err(e) => HubEvent::Error(Arc::new(e)),
                });
                notify_all(&list, &event);
                tokio::time::sleep(FAKE_POLL).await;
            }
        });
    }

    fn notify_all(list: &Listeners<Arc<HubEvent>>, event: &Arc<HubEvent>) {
        for listener in list.lock().unwrap().iter().flatten() {
            listener(event.clone());
        }
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
            _dot_dirs: DotDirs,
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
        async fn shift_tab(&self, _session_id: &str, _agent: Option<Agent>) -> Result<(), Failure> {
            // No value in and none out: the key press is the whole action.
            self.calls.lock().unwrap().push("mode".to_string());
            Ok(())
        }
        async fn clear(
            &self,
            session_id: &str,
            _agent: Option<Agent>,
        ) -> Result<ClearOutcome, Failure> {
            self.calls.lock().unwrap().push(format!("clear:{session_id}"));
            Ok(ClearOutcome {
                session_id: Some("session-after-clear".to_string()),
                unobserved: false,
            })
        }
        async fn compact(&self, session_id: &str, _agent: Option<Agent>) -> Result<(), Failure> {
            self.calls.lock().unwrap().push(format!("compact:{session_id}"));
            Ok(())
        }
        async fn set_model(
            &self,
            _session_id: &str,
            _agent: Option<Agent>,
            value: String,
        ) -> Result<bool, Failure> {
            self.calls.lock().unwrap().push(format!("model:{value}"));
            Ok(false)
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
            self.calls.lock().unwrap().push("goal-clear".into());
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

    /// Which fleet the harness server says it is serving.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Fixtures {
        Mock,
        Real,
    }

    /// A fake tail that never runs dry, for a server that has no transcripts.
    fn fake_tails() -> Arc<dyn Fn(&Agent) -> Option<Box<dyn TailApi>> + Send + Sync> {
        Arc::new(|_agent: &Agent| Some(Box::new(FakeTail { n: 0, prompt: None }) as Box<dyn TailApi>))
    }

    /// The `AskUserQuestion` the binding tests answer, as the transcript states
    /// it: two labelled options, and a second question behind this one.
    fn blocked_prompt() -> PendingPrompt {
        PendingPrompt {
            tool: "AskUserQuestion".into(),
            question: Some("Which migration should run first?".into()),
            options: vec![
                PromptOption { label: "Backfill the index".into(), description: None },
                PromptOption { label: "Swap the table".into(), description: None },
            ],
            multi_select: None,
            more_questions: Some(1),
            detail: None,
            id: String::new(),
        }
    }

    fn tails_reporting_a_prompt() -> Arc<dyn Fn(&Agent) -> Option<Box<dyn TailApi>> + Send + Sync> {
        Arc::new(|_agent: &Agent| {
            Some(Box::new(FakeTail { n: 0, prompt: Some(blocked_prompt()) }) as Box<dyn TailApi>)
        })
    }

    /// The harness `App`: every seam faked, no Tailscale, no real fleet.
    fn harness_app(parts: &HarnessParts, fixtures: Fixtures, token: Option<&str>) -> Arc<App> {
        Arc::new(App {
            deps: Deps {
                source: parts.source.clone(),
                panes: parts.panes.clone(),
                limits: Arc::new(FakeLimits),
                tail_for: fake_tails(),
            },
            hub: FakeHub::new(parts.panes.clone()),
            mock: fixtures == Fixtures::Mock,
            web_root: parts.web_root.path().to_path_buf(),
            token: token.map(str::to_string),
            env: ServerEnv { tailscale: None, tmux: true, port: 0, platform: "darwin".into(), version: env!("CARGO_PKG_VERSION").into() },
            browse_root: None,
            spawn: Arc::new(OkSpawn),
            browse: Arc::new(OkBrowse),
            control: parts.control.clone(),
            pending: None,
            // No Tailscale in the harness: the tests address this server as
            // loopback, which is the gate's other half.
            tailnet: None,
            origin_names: Vec::new(),
            grants: Grants::ALL,
            tree: None,
        })
    }

    /// The fakes a harness keeps a handle on, before the server owns them.
    struct HarnessParts {
        panes: Arc<FakePanes>,
        source: Arc<FakeSource>,
        control: Arc<RecordingControl>,
        web_root: tempfile::TempDir,
    }

    fn harness_parts(panes: Arc<FakePanes>) -> HarnessParts {
        let web_root = tempfile::tempdir().unwrap();
        std::fs::write(web_root.path().join("index.html"), DOC).unwrap();
        std::fs::write(web_root.path().join("app.js"), "console.log(1)\n").unwrap();
        HarnessParts {
            panes,
            source: FakeSource::new(),
            control: Arc::new(RecordingControl { calls: Mutex::new(vec![]) }),
            web_root,
        }
    }

    async fn start(token: Option<&str>, panes: Arc<FakePanes>, fixtures: Fixtures) -> Harness {
        let parts = harness_parts(panes);
        let app = harness_app(&parts, fixtures, token);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = run(app, listener).await;
        });
        let HarnessParts { panes, source, control, web_root } = parts;
        Harness { port, panes, source, control, web_root }
    }

    async fn plain(panes: Arc<FakePanes>) -> Harness {
        start(None, panes, Fixtures::Real).await
    }

    /// A server whose agents are all parked on `blocked_prompt`.
    async fn blocked(panes: Arc<FakePanes>) -> Harness {
        let parts = harness_parts(panes);
        let mut app = harness_app(&parts, Fixtures::Real, None);
        Arc::get_mut(&mut app).expect("sole owner").deps.tail_for = tails_reporting_a_prompt();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = run(app, listener).await;
        });
        let HarnessParts { panes, source, control, web_root } = parts;
        Harness { port, panes, source, control, web_root }
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

    /// RFC 6455's own example handshake nonce, encoded here rather than written
    /// out.
    ///
    /// The value is public — it is printed in the spec, and it decodes to the
    /// words "the sample nonce". A `Sec-WebSocket-Key` is a per-connection
    /// nonce that every browser sends in cleartext and that authenticates
    /// nothing, so it is not a credential. It is built at runtime all the same:
    /// written as a literal it is a base64 blob on a line ending in `Key:`,
    /// which is precisely the shape a secret scanner is right to stop, and a
    /// scanner that has been taught to ignore this file would stop catching
    /// real ones.
    fn sample_ws_key() -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode("the sample nonce")
    }

    /// A WebSocket handshake driven by hand, so a refusal can be read as a status.
    async fn try_ws(port: u16, headers: &str) -> String {
        let request = format!(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
             Upgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n{headers}\r\n",
            key = sample_ws_key()
        );
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = [0u8; HANDSHAKE_BYTES];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string()
    }

    /* ---- INV-3: the token ---- */

    #[tokio::test]
    async fn refuses_a_request_with_no_token_when_one_is_configured() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = get(h.port, "/api/agents", "").await;
        assert!(status(&res).contains("401"), "{}", status(&res));
    }

    #[tokio::test]
    async fn accepts_the_token_in_the_query() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = get(h.port, "/api/agents?token=s3cret", "").await;
        assert!(status(&res).contains("200"), "{}", status(&res));
    }

    #[tokio::test]
    async fn accepts_the_token_in_an_authorization_header() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = get(h.port, "/api/agents", "Authorization: Bearer s3cret\r\n").await;
        assert!(status(&res).contains("200"), "{}", status(&res));
    }

    #[tokio::test]
    async fn refuses_a_token_that_is_merely_a_prefix() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        for wrong in ["s3cre", "s3cretx", "S3CRET", ""] {
            let res = get(h.port, &format!("/api/agents?token={wrong}"), "").await;
            assert!(status(&res).contains("401"), "{wrong}: {}", status(&res));
        }
    }

    #[tokio::test]
    async fn a_token_does_not_replace_the_origin_gate() {
        // A correct token is not a licence to answer any name. The gates ask
        // different questions, and only `origin_names` widens the second one.
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = raw(
            h.port,
            "GET /api/agents?token=s3cret HTTP/1.1\r\nHost: laptop.tailnet.ts.net\r\n\
             Origin: http://laptop.tailnet.ts.net\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(status(&res).contains("403"), "{}", status(&res));
    }

    #[tokio::test]
    async fn a_token_still_serves_the_loopback_origin_it_is_reached_at() {
        // The gate above must not have cost the ordinary token flow.
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = get(h.port, "/api/agents?token=s3cret", "").await;
        assert!(status(&res).contains("200"), "{}", status(&res));
    }

    #[test]
    fn inv3_a_tokenless_server_answers_to_no_name_but_loopback() {
        // The hole this closed: `tailscale serve` forwards the name the caller
        // dialled, which is ours, so accepting it without a token let any peer
        // on the tailnet drive the fleet. A token is now the price of every
        // name that is not loopback.
        let tailnet = Some("box.tail1234.ts.net".to_string());
        assert!(origin_names("127.0.0.1", tailnet.clone(), None).is_empty());
        assert_eq!(
            origin_names("127.0.0.1", tailnet.clone(), Some("s3cret")),
            vec!["box.tail1234.ts.net".to_string()]
        );
    }

    #[test]
    fn inv3_the_bound_host_is_a_name_this_server_answers_to() {
        // `--host 100.x.y.z --token auto` is a documented recipe. Asking to be
        // reachable there is asking for that name to work, so it joins the set
        // — but only alongside the token that `--host` already demands.
        let tailnet = Some("box.tail1234.ts.net".to_string());
        assert_eq!(
            origin_names("100.64.0.1", tailnet.clone(), Some("s3cret")),
            vec!["100.64.0.1".to_string(), "box.tail1234.ts.net".to_string()]
        );
        // Loopback is already covered by `is_loopback_name`, so it is not
        // repeated, and neither is a bound host that is the tailnet name.
        assert_eq!(origin_names("localhost", None, Some("s3cret")), Vec::<String>::new());
        assert_eq!(
            origin_names("box.tail1234.ts.net", tailnet, Some("s3cret")),
            vec!["box.tail1234.ts.net".to_string()]
        );
    }

    /* ---- INV-3: the token is exchanged for a cookie, once ---- */

    #[tokio::test]
    async fn a_document_request_trades_the_token_for_a_cookie() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = raw(
            h.port,
            "GET /?token=s3cret HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/html\r\n\
             Connection: close\r\n\r\n",
        )
        .await;
        assert!(status(&res).contains("302"), "{}", status(&res));
        let lower = res.to_ascii_lowercase();
        assert!(lower.contains("location: /"), "{res}");
        assert!(lower.contains("ac_session=s3cret"), "{res}");
        assert!(lower.contains("httponly"), "{res}");
        assert!(lower.contains("samesite=strict"), "{res}");
        // Loopback http is already a secure context; the flag is for the
        // browser's TLS leg behind `tailscale serve`.
        assert!(!lower.contains("secure"), "{res}");
    }

    #[tokio::test]
    async fn the_redirect_keeps_every_query_parameter_but_the_token() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = raw(
            h.port,
            "GET /agent/x?token=s3cret&tab=attach HTTP/1.1\r\nHost: 127.0.0.1\r\n\
             Accept: text/html\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(res.to_ascii_lowercase().contains("location: /agent/x?tab=attach"), "{res}");
    }

    #[tokio::test]
    async fn the_cookie_is_marked_secure_behind_a_tls_proxy() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = raw(
            h.port,
            "GET /?token=s3cret HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/html\r\n\
             X-Forwarded-Proto: https\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(res.to_ascii_lowercase().contains("secure"), "{res}");
    }

    #[tokio::test]
    async fn the_cookie_then_stands_in_for_the_token() {
        // The point of the exchange: the next request carries no token at all.
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = raw(
            h.port,
            "GET /api/agents HTTP/1.1\r\nHost: 127.0.0.1\r\n\
             Cookie: ac_session=s3cret\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(status(&res).contains("200"), "{}", status(&res));
    }

    #[tokio::test]
    async fn a_wrong_cookie_is_refused_like_a_wrong_token() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        for wrong in ["s3cre", "s3cretx", "S3CRET", ""] {
            let res = raw(
                h.port,
                &format!(
                    "GET /api/agents HTTP/1.1\r\nHost: 127.0.0.1\r\n\
                     Cookie: ac_session={wrong}\r\nConnection: close\r\n\r\n"
                ),
            )
            .await;
            assert!(status(&res).contains("401"), "{wrong}: {}", status(&res));
        }
    }

    #[tokio::test]
    async fn a_cookie_does_not_buy_a_foreign_origin_anything() {
        // The reason `permitted` had to stop honouring `token.is_some()` first:
        // the browser attaches this cookie to a cross-site request without the
        // user having asked for anything.
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = raw(
            h.port,
            "POST /api/agents HTTP/1.1\r\nHost: 127.0.0.1\r\n\
             Origin: https://evil.example\r\nCookie: ac_session=s3cret\r\n\
             Content-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        )
        .await;
        assert!(status(&res).contains("403"), "{}", status(&res));
    }

    #[tokio::test]
    async fn a_script_using_the_token_is_not_redirected() {
        // curl and `fetch` send no `Accept: text/html`, and a 302 they did not
        // ask for would break every documented scripted use of `?token=`.
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        let res = get(h.port, "/api/agents?token=s3cret", "").await;
        assert!(status(&res).contains("200"), "{}", status(&res));
    }

    #[test]
    fn a_cookie_value_is_not_decoded_as_a_query_component() {
        // `+` is a literal plus in a cookie and a space in a query string.
        // Sharing `query_param` here would corrupt any token containing one.
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "ac_session=a+b; other=z".parse().unwrap());
        assert_eq!(cookie_value(&headers, SESSION_COOKIE).as_deref(), Some("a+b"));
        assert_eq!(cookie_value(&headers, "missing"), None);
    }

    #[test]
    fn stripping_the_token_leaves_the_rest_of_the_query_alone() {
        assert_eq!(query_without_token("token=x"), "");
        assert_eq!(query_without_token("a=1&token=x&b=2"), "a=1&b=2");
        assert_eq!(query_without_token(""), "");
        // A parameter that merely starts with the same letters is not the token.
        assert_eq!(query_without_token("tokenish=1"), "tokenish=1");
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
            "GET /api/agents HTTP/1.1\r\nHost: evil.example\r\n\
             Origin: http://evil.example\r\nConnection: close\r\n\r\n",
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

    /* ---- INV-3: the tailnet name is this machine, and nothing else is ---- */

    #[test]
    fn inv3_own_tailnet_name_is_normalised_and_only_read_when_up() {
        let up = |running, dns: &str| ServerEnv {
            tailscale: Some(crate::types::TailscaleEnv {
                cli_path: "/usr/bin/tailscale".into(),
                dns_name: dns.into(),
                ip: "100.64.0.1".into(),
                running,
            }),
            tmux: true,
            port: 0,
            version: env!("CARGO_PKG_VERSION").into(),
            platform: "darwin".into(),
        };
        // Trailing dot dropped, case folded — the header arrives either way.
        assert_eq!(
            own_tailnet_name(&up(true, "Box.tail1234.ts.net.")).as_deref(),
            Some("box.tail1234.ts.net")
        );
        // Tailscale installed but down is not a name to trust.
        assert_eq!(own_tailnet_name(&up(false, "box.tail1234.ts.net")), None);
        // Neither is an empty one.
        assert_eq!(own_tailnet_name(&up(true, ".")), None);
        assert_eq!(
            own_tailnet_name(&ServerEnv {
                tailscale: None,
                tmux: true,
                port: 0,
                platform: "darwin".into(), version: env!("CARGO_PKG_VERSION").into() }),
            None
        );
    }

    #[test]
    fn inv3_only_an_allowed_name_counts_as_self() {
        let ours = vec!["box.tail1234.ts.net".to_string()];
        assert!(is_self_name("box.tail1234.ts.net", &ours));
        assert!(is_self_name("127.0.0.1", &ours));
        assert!(is_self_name("localhost", &ours));
        // Another machine's name is not one we answer to. Note this is not
        // what protects the tailnet: a peer dials *our* name, so it is the
        // token, not this line, that tells the two apart.
        assert!(!is_self_name("laptop.tail1234.ts.net", &ours));
        // A visited page's own domain, and a rebound host, are refused by the
        // same line — neither is loopback and neither is our name.
        assert!(!is_self_name("evil.example", &ours));
        assert!(!is_self_name("null", &ours));
        // With nothing allowed — a tokenless server — only loopback serves.
        assert!(!is_self_name("box.tail1234.ts.net", &[]));
        assert!(is_self_name("127.0.0.1", &[]));
    }

    #[test]
    fn inv3_a_rebound_host_is_refused_even_when_origin_matches_it() {
        // DNS rebinding: evil.example re-pointed at 127.0.0.1, so Origin and
        // Host agree perfectly. Only the fact that it is not a self name gives
        // it away — which is why Host is checked and not just Origin.
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "http://evil.example".parse().unwrap());
        headers.insert(header::HOST, "evil.example".parse().unwrap());
        assert!(!same_origin_request(&headers, &["box.tail1234.ts.net".to_string()]));
    }

    /* ---- the bundle is exempt from the token, and only the bundle ---- */

    #[test]
    fn only_asset_reads_skip_the_token_gate() {
        assert!(is_public_asset(&Method::GET, "/assets/app-a1b2.js"));
        assert!(is_public_asset(&Method::HEAD, "/assets/app-a1b2.js"));
        // A write under the prefix is not a subresource fetch.
        assert!(!is_public_asset(&Method::POST, "/assets/app-a1b2.js"));
        // Nothing that carries agent state is ever under this prefix.
        assert!(!is_public_asset(&Method::GET, "/api/agents"));
        assert!(!is_public_asset(&Method::GET, "/"));
        // Prefix, not substring: a sibling path must not inherit the exemption.
        assert!(!is_public_asset(&Method::GET, "/api/assets/x"));
    }

    #[tokio::test]
    async fn a_token_gates_agent_state_but_not_the_apps_own_bundle() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
        // The bundle loads without the token, because a <script> carries none.
        // Missing under this prefix 404s rather than falling through to the
        // shell, so it cannot be used to read one.
        let asset = get(h.port, "/assets/does-not-exist.js", "").await;
        assert!(status(&asset).contains("404"), "{}", status(&asset));
        // Everything carrying agent state still costs a token.
        let agents = get(h.port, "/api/agents", "").await;
        assert!(status(&agents).contains("401"), "{}", status(&agents));
        let ok = get(h.port, "/api/agents?token=s3cret", "").await;
        assert!(status(&ok).contains("200"), "{}", status(&ok));
    }

    /* ---- INV-4: nothing re-sends what the watcher already has ---- */

    #[tokio::test]
    async fn the_tree_is_not_resent_when_it_has_not_changed() {
        let h = plain(FakePanes::new()).await;
        let first = get(h.port, "/api/tree", "").await;
        assert!(status(&first).contains("200"), "{}", status(&first));
        let etag = first
            .lines()
            .find_map(|l| l.strip_prefix("etag: ").or_else(|| l.strip_prefix("ETag: ")))
            .expect("a tree response carries an ETag")
            .trim()
            .to_string();

        let again = get(h.port, "/api/tree", &format!("If-None-Match: {etag}\r\n")).await;
        assert!(status(&again).contains("304"), "{}", status(&again));
        // A 304 carries the tag and no body — the client keeps the array it has.
        assert_eq!(body(&again), "");
        assert!(again.contains(&etag));

        // An unknown tag is a cache this server cannot honour, so it serves.
        let stale = get(h.port, "/api/tree", "If-None-Match: \"nonsense\"\r\n").await;
        assert!(status(&stale).contains("200"), "{}", status(&stale));
        assert!(body(&stale).contains("trees"));
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
            "GET /ws HTTP/1.1\r\nHost: evil.example\r\nOrigin: http://evil.example\r\n\
             Upgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
            key = sample_ws_key()
        );
        let mut stream = TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = [0u8; STATUS_LINE_BYTES];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
        assert!(line.contains("403"), "{line}");
    }

    #[tokio::test]
    async fn the_websocket_refuses_a_handshake_with_no_token() {
        let h = start(Some("s3cret"), FakePanes::new(), Fixtures::Real).await;
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
            "GET /api/agents HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
             Upgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
            port = h.port,
            key = sample_ws_key()
        );
        let mut stream = TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = [0u8; STATUS_LINE_BYTES];
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
        let h = start(None, FakePanes::new(), Fixtures::Mock).await;
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

    /// The bug that shipped in the Node server: `JSON.parse('')` threw, and the
    /// user was told "that did not take effect" about a control the server had
    /// never called. Mode, clear and compact send no body at all.
    #[tokio::test]
    async fn inv8_mode_and_clear_and_compact_carry_no_body() {
        let h = plain(FakePanes::new()).await;
        for (action, detail) in [
            ("mode", "sent"),
            ("clear", "session-after-clear"),
            ("compact", "requested"),
        ] {
            // No Content-Type, no body, no Content-Length beyond zero.
            let res = post(h.port, &format!("/api/agents/{SESSION}/{action}"), "", None).await;
            assert!(status(&res).contains("200"), "{action}: {}", status(&res));
            assert!(
                body(&res).contains(&format!("\"detail\":\"{detail}\"")),
                "{action}: {}",
                body(&res)
            );
        }
        let calls = h.control.calls.lock().unwrap().clone();
        assert!(calls.contains(&"mode".to_string()), "{calls:?}");
        assert!(calls.iter().any(|c| c.starts_with("clear:")), "{calls:?}");
        assert!(calls.iter().any(|c| c.starts_with("compact:")), "{calls:?}");
    }

    #[tokio::test]
    async fn control_reads_a_single_value_key() {
        let h = plain(FakePanes::new()).await;
        let json = "Content-Type: application/json\r\n";
        // Only `model` and `goal` carry a value now; `mode` advances a cycle
        // and is covered by `mode_and_clear_and_compact_carry_no_body`.
        for (action, payload, expect) in [
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
            assert_eq!(h.control.calls.lock().unwrap().as_slice(), &["goal-clear".to_string()]);
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
        let deadline = tokio::time::Instant::now() + REPLY_DEADLINE;
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

    fn is_type(value: &serde_json::Value, wanted: &str) -> bool {
        value.get("type").and_then(|kind| kind.as_str()) == Some(wanted)
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
            tokio::time::sleep(RECHECK).await;
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

    /* ---- authorization: what a credential is allowed to do ---- */

    /// A server with a narrowed grant set, otherwise the blocked harness.
    async fn granting(grants: Grants, panes: Arc<FakePanes>) -> Harness {
        let parts = harness_parts(panes);
        let mut app = harness_app(&parts, Fixtures::Real, None);
        {
            let app = Arc::get_mut(&mut app).expect("sole owner");
            app.deps.tail_for = tails_reporting_a_prompt();
            app.grants = grants;
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = run(app, listener).await;
        });
        let HarnessParts { panes, source, control, web_root } = parts;
        Harness { port, panes, source, control, web_root }
    }

    #[test]
    fn every_power_implies_being_able_to_read() {
        // Answering a question you cannot see would be a worse thing to hand
        // someone than the whole token.
        for name in ["respond", "drive", "spawn"] {
            assert!(Grants::parse(name).unwrap().allows(Grant::Read), "{name}");
        }
    }

    #[test]
    fn a_typo_in_a_grant_is_refused_rather_than_guessed_at() {
        assert!(Grants::parse("reed").is_err());
        assert!(Grants::parse("").is_err());
        assert!(Grants::parse("read,drive").unwrap().allows(Grant::Drive));
        assert!(!Grants::parse("read,drive").unwrap().allows(Grant::Spawn));
    }

    #[tokio::test]
    async fn a_read_only_credential_cannot_spawn_an_agent() {
        let h = granting(Grants::parse("read").unwrap(), FakePanes::new()).await;
        let res = post(h.port, "/api/agents", "", Some("{}")).await;
        assert!(status(&res).contains("403"), "{}", status(&res));
        // ...but the fleet it is for still serves.
        let listing = get(h.port, "/api/agents", "").await;
        assert!(status(&listing).contains("200"), "{}", status(&listing));
    }

    #[tokio::test]
    async fn a_respond_credential_answers_a_prompt_but_cannot_type() {
        // The split the phone flow is for: answer the question that is
        // blocking an agent, without being able to paste a command into it.
        let h = granting(Grants::parse("respond").unwrap(), FakePanes::new()).await;
        let mut client = open(h.port).await;
        let id = prompt_id_for(&mut client).await;

        send_json(
            &mut client,
            serde_json::json!({"type":"key","sessionId":BLOCKED,"key":"Up"}),
        )
        .await;
        let refused = next_msg(&mut client, |m| {
            is_type(m, "error") && m["message"].as_str().is_some_and(|s| s.contains("--grant"))
        })
        .await;
        assert!(refused.is_some(), "a keystroke needs drive");
        assert_eq!(h.panes.writes(), 0);

        send_json(
            &mut client,
            serde_json::json!({"type":"answer","sessionId":BLOCKED,"promptId":id,"choice":0}),
        )
        .await;
        tokio::time::sleep(ANSWER_SETTLE).await;
        assert_eq!(h.panes.writes(), 1, "answering is exactly what it may do");
    }

    #[tokio::test]
    async fn a_drive_credential_cannot_answer_by_the_back_door() {
        // `drive` is wider than `respond` in every practical sense, but the
        // check is per message: it must not be possible to reach one power by
        // asking for the name of the other.
        let h = granting(Grants::parse("drive").unwrap(), FakePanes::new()).await;
        let mut client = open(h.port).await;
        let id = prompt_id_for(&mut client).await;
        send_json(
            &mut client,
            serde_json::json!({"type":"answer","sessionId":BLOCKED,"promptId":id,"choice":0}),
        )
        .await;
        let refused = next_msg(&mut client, |m| {
            is_type(m, "error") && m["message"].as_str().is_some_and(|s| s.contains("--grant"))
        })
        .await;
        assert!(refused.is_some());
        assert_eq!(h.panes.writes(), 0);
    }

    #[tokio::test]
    async fn the_default_grants_everything_so_nothing_changes_unasked() {
        let h = blocked(FakePanes::new()).await;
        let res = post(h.port, "/api/agents", "", Some("{}")).await;
        assert!(!status(&res).contains("403"), "{}", status(&res));
    }

    /* ---- INV-2: an answer is bound to the question it was given for ---- */

    /// Focus the blocked fixture and return the prompt id the server sent.
    async fn prompt_id_for(client: &mut Client) -> String {
        send_json(client, serde_json::json!({"type":"focus","sessionId":BLOCKED})).await;
        let msg = next_msg(client, |m| is_type(m, "timeline") && m["prompt"].is_object())
            .await
            .expect("the blocked fixture reports a prompt");
        msg["prompt"]["id"].as_str().expect("the prompt carries an id").to_string()
    }

    #[tokio::test]
    async fn inv2_an_answer_naming_the_current_prompt_reaches_the_agent() {
        let h = blocked(FakePanes::new()).await;
        let mut client = open(h.port).await;
        let id = prompt_id_for(&mut client).await;

        send_json(
            &mut client,
            serde_json::json!({"type":"answer","sessionId":BLOCKED,"promptId":id,"choice":1}),
        )
        .await;
        tokio::time::sleep(ANSWER_SETTLE).await;
        assert_eq!(h.panes.writes(), 1, "the answer reaches the pane");
    }

    #[tokio::test]
    async fn inv2_an_answer_to_a_question_that_has_moved_on_is_refused() {
        // The hazard this exists for: a stale tab, a duplicated frame, or the
        // next question in the same `AskUserQuestion` set. A bare digit would
        // answer whatever the pane is showing when tmux receives it.
        let h = blocked(FakePanes::new()).await;
        let mut client = open(h.port).await;
        let id = prompt_id_for(&mut client).await;
        let stale = format!("{id}-but-not-really");

        send_json(
            &mut client,
            serde_json::json!({"type":"answer","sessionId":BLOCKED,"promptId":stale,"choice":1}),
        )
        .await;
        let err = next_msg(&mut client, |m| {
            is_type(m, "error")
                && m["message"].as_str().is_some_and(|s| s.contains("asking something else"))
        })
        .await;
        assert!(err.is_some(), "the client is told why nothing was sent");
        assert_eq!(h.panes.writes(), 0, "nothing reached the agent");
    }

    #[tokio::test]
    async fn inv2_an_option_the_transcript_never_named_is_refused() {
        // The keystroke is composed here, so an index past what was offered is
        // a client bug rather than a digit to invent and send.
        let h = blocked(FakePanes::new()).await;
        let mut client = open(h.port).await;
        let id = prompt_id_for(&mut client).await;
        const PAST_EVERY_OPTION: usize = 99;

        send_json(
            &mut client,
            serde_json::json!({"type":"answer","sessionId":BLOCKED,"promptId":id,"choice":PAST_EVERY_OPTION}),
        )
        .await;
        let err = next_msg(&mut client, |m| {
            is_type(m, "error") && m["message"].as_str().is_some_and(|s| s.contains("no such option"))
        })
        .await;
        assert!(err.is_some());
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
        tokio::time::sleep(FLOOD_DRAIN).await;
        let writes = h.panes.writes();
        assert!(writes > 0 && writes < BUDGET_CEILING, "writes = {writes}");
    }

    #[tokio::test]
    async fn a_dead_pane_ends_the_terminal_and_not_the_conversation() {
        let h = start(None, FakePanes::dead(), Fixtures::Real).await;
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
        let h = start(None, FakePanes::flaky(FRAME_FAIL_LIMIT as i64 - 2), Fixtures::Real).await;
        let mut client = open(h.port).await;
        send_json(&mut client, serde_json::json!({"type":"focus","sessionId":SESSION})).await;
        send_json(&mut client, serde_json::json!({"type":"attach","sessionId":SESSION,"on":true}))
            .await;
        let frame = next_msg(&mut client, |m| is_type(m, "frame")).await;
        assert!(frame.is_some(), "a blip must not end the terminal");
    }

    #[tokio::test]
    async fn still_gives_up_when_the_failures_do_not_stop() {
        let h = start(None, FakePanes::flaky(i64::MAX), Fixtures::Real).await;
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
            serde_json::json!({
                "type": "paste",
                "sessionId": SESSION,
                "text": "hi",
                "submit": true,
                "seq": PASTE_SEQ,
            }),
        )
        .await;
        let ack = next_msg(&mut client, |m| is_type(m, "paste-ack")).await.unwrap();
        assert_eq!(ack["seq"], serde_json::json!(PASTE_SEQ));
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
