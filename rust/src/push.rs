//! A push off the Mac when an agent starts needing you.
//!
//! The app's only out-of-tab alert was a browser `Notification`, fired by the
//! page when it watched a block begin — and on the device this app exists for
//! that page is usually not running. iOS closes a backgrounded web app's
//! socket, gives a Home Screen web app no background sync, and evicts the
//! page outright; a phone in a pocket cannot watch a transition. Measured on
//! this machine's transcripts, 21% of the questions an agent asked waited more
//! than ten minutes for an answer and the night-time ninety-fifth percentile
//! was over seven hours — an agent asking after bedtime and getting its answer
//! at breakfast.
//!
//! So the transition is watched here, where the fleet is, and handed to a
//! channel that reaches a phone on its own: an ntfy topic (self-hosted or
//! ntfy.sh) or a Telegram bot. Both are one outbound HTTPS request per
//! transition and open no port, which is what keeps INV-3 whole; the body is
//! the agent's name and what it is waiting for, and the click is a link into
//! this app, so answering still goes through the card and its pane check
//! (INV-2, INV-16) — nothing is answered from a lock screen.
//!
//! **INV-14 holds here as it does in the browser, rule for rule.** The first
//! fleet this tracker sees is backlog, not news: an agent that has been
//! waiting three days when the server starts notifies nobody. A standing block
//! never re-fires; one that unblocks and blocks again is news again. And a
//! visible tab is already the notification, so while any browser reports
//! itself visible the transition is consumed and no push goes — presence the
//! client declares on its heartbeat, the same way Claude Code's own Remote
//! Control suppresses pushes while you are at the terminal. An inferred
//! status never fires: it can never be `waiting` (INV-11), and this checks
//! that a second time rather than trusting it.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use crate::types::{Agent, AgentStatus};

/// Where a push goes. Parsed once from `--notify`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Channel {
    /// `https://ntfy.sh/<topic>` or a self-hosted topic URL. An access token,
    /// where the server wants one, comes from `AGENT_COMMANDER_NTFY_TOKEN`.
    Ntfy { url: String, token: Option<String> },
    /// `telegram:<chat_id>`; the bot token comes from
    /// `AGENT_COMMANDER_TELEGRAM_TOKEN` or the 0600 file beside this app's own.
    Telegram { chat_id: String, token: String },
}

/// The 0600 file the Telegram bot token may live in instead of the environment.
pub fn telegram_token_file() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".claude")
        .join("agent-commander")
        .join("telegram-token")
}

impl Channel {
    /// What `--notify` accepts, and why each refusal.
    pub fn parse(spec: &str, env: &dyn Fn(&str) -> Option<String>) -> Result<Channel, String> {
        if let Some(chat_id) = spec.strip_prefix("telegram:") {
            if chat_id.is_empty() || !chat_id.chars().all(|c| c.is_ascii_digit() || c == '-') {
                return Err(format!("--notify telegram:<chat_id> needs a numeric chat id, got {chat_id:?}"));
            }
            let token = env("AGENT_COMMANDER_TELEGRAM_TOKEN")
                .or_else(|| crate::token_file::read(&telegram_token_file()))
                .ok_or_else(|| {
                    format!(
                        "--notify telegram: needs the bot token in AGENT_COMMANDER_TELEGRAM_TOKEN or in {}",
                        telegram_token_file().display()
                    )
                })?;
            return Ok(Channel::Telegram { chat_id: chat_id.to_string(), token });
        }
        if spec.starts_with("https://") || spec.starts_with("http://") {
            let path = spec.splitn(4, '/').nth(3).unwrap_or("");
            if path.is_empty() || path.contains('/') || path.contains('?') {
                return Err(format!("--notify wants an ntfy topic URL like https://ntfy.sh/my-topic, got {spec:?}"));
            }
            return Ok(Channel::Ntfy { url: spec.to_string(), token: env("AGENT_COMMANDER_NTFY_TOKEN") });
        }
        Err(format!("--notify takes an ntfy topic URL or telegram:<chat_id>, got {spec:?}"))
    }
}

/// One notification, composed here and sent by a `Pusher`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Push {
    pub title: String,
    pub body: String,
    /// Straight to the card that can answer it, when the server knows its own
    /// address on the phone (`--notify-link`).
    pub link: Option<String>,
    /// The session, so a channel that groups by tag replaces rather than stacks.
    pub tag: String,
}

/// The transport, so the tracker can be tested without a network.
#[async_trait::async_trait]
pub trait Pusher: Send + Sync + 'static {
    async fn push(&self, push: &Push) -> Result<(), String>;
}

/// INV-14's tracker, server-side.
pub struct Notifier {
    seen: Mutex<Option<HashSet<String>>>,
    link_base: Option<String>,
    pusher: Arc<dyn Pusher>,
}

impl Notifier {
    pub fn new(pusher: Arc<dyn Pusher>, link_base: Option<String>) -> Arc<Self> {
        let link_base = link_base.map(|base| base.trim_end_matches('/').to_string());
        Arc::new(Self { seen: Mutex::new(None), link_base, pusher })
    }

    /// The agents this frame shows newly blocked, as pushes.
    ///
    /// Empty on the first frame, whose blocked agents are backlog and not news.
    pub fn freshly_blocked(&self, agents: &[Agent]) -> Vec<Push> {
        match self.record(agents) {
            Some(crossed) => crossed.iter().map(|a| self.compose(a)).collect(),
            None => Vec::new(),
        }
    }

    /// Note this frame's transitions and push none of them, for when a browser
    /// reports itself visible: the screen is the notification, so the
    /// transition is consumed rather than deferred, exactly as the browser's
    /// own tracker does.
    pub fn watched_on_screen(&self, agents: &[Agent]) {
        self.record(agents);
    }

    /// Swap in this frame's blocked set, answering with the agents that just
    /// crossed into it — or `None` on the first frame, which has no before.
    fn record<'a>(&self, agents: &'a [Agent]) -> Option<Vec<&'a Agent>> {
        let blocked: HashSet<String> = agents
            .iter()
            .filter(|a| a.status == AgentStatus::Waiting && a.status_inferred != Some(true))
            .map(|a| a.session_id.clone())
            .collect();
        let before = self.seen.lock().unwrap().replace(blocked.clone())?;
        let crossed = agents
            .iter()
            .filter(|a| blocked.contains(&a.session_id) && !before.contains(&a.session_id))
            .collect();
        Some(crossed)
    }

    fn compose(&self, agent: &Agent) -> Push {
        let body = match agent.waiting_for.as_deref() {
            Some(reason) => format!("Waiting on you — {reason}"),
            None => "Waiting on you".to_string(),
        };
        Push {
            title: agent.name.clone(),
            body,
            link: self.link_base.as_ref().map(|base| format!("{base}/agent/{}", agent.session_id)),
            tag: agent.session_id.clone(),
        }
    }

    /// Send one, logging a failure rather than retrying: a push that did not
    /// go is a push that did not go, and the next transition sends its own.
    pub async fn deliver(&self, push: Push) {
        if let Err(why) = self.pusher.push(&push).await {
            eprintln!("agent-commander: push for {} not delivered: {why}", push.tag);
        }
    }
}

/// The real transport: one HTTPS request per push, nothing inbound.
pub struct HttpPusher {
    channel: Channel,
    client: reqwest::Client,
}

/// How long one push may take before it is given up on.
const PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl HttpPusher {
    /// Handed out as the trait object the notifier takes, like `FileLimits`.
    #[allow(clippy::new_ret_no_self)]
    pub fn new(channel: Channel) -> Arc<dyn Pusher> {
        let client = reqwest::Client::builder()
            .timeout(PUSH_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Arc::new(Self { channel, client })
    }

    fn ntfy(&self, url: &str, token: Option<&str>, push: &Push) -> reqwest::RequestBuilder {
        let mut req = self
            .client
            .post(url)
            .header("Title", push.title.replace(['\r', '\n'], " "))
            .header("Tags", "raised_hand")
            .header("Priority", "high")
            .body(push.body.clone());
        if let Some(link) = &push.link {
            req = req.header("Click", link.as_str());
        }
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        req
    }

    fn telegram(&self, chat_id: &str, token: &str, push: &Push) -> reqwest::RequestBuilder {
        let mut payload = serde_json::json!({
            "chat_id": chat_id,
            "text": format!("{}\n{}", push.title, push.body),
        });
        if let Some(link) = &push.link {
            payload["reply_markup"] =
                serde_json::json!({ "inline_keyboard": [[{ "text": "Open", "url": link }]] });
        }
        self.client
            .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
            .json(&payload)
    }
}

#[async_trait::async_trait]
impl Pusher for HttpPusher {
    async fn push(&self, push: &Push) -> Result<(), String> {
        let req = match &self.channel {
            Channel::Ntfy { url, token } => self.ntfy(url, token.as_deref(), push),
            Channel::Telegram { chat_id, token } => self.telegram(chat_id, token, push),
        };
        let res = req.send().await.map_err(|e| e.to_string())?;
        match res.status().is_success() {
            true => Ok(()),
            false => Err(format!("HTTP {}", res.status())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    struct Recorder(StdMutex<Vec<Push>>);

    #[async_trait::async_trait]
    impl Pusher for Recorder {
        async fn push(&self, push: &Push) -> Result<(), String> {
            self.0.lock().unwrap().push(push.clone());
            Ok(())
        }
    }

    fn agent(id: &str, status: AgentStatus) -> Agent {
        Agent {
            session_id: id.into(),
            name: format!("agent-{id}"),
            status,
            waiting_for: (status == AgentStatus::Waiting).then(|| "dialog open".to_string()),
            agent_kind: "claude".into(),
            ..Default::default()
        }
    }

    fn notifier() -> Arc<Notifier> {
        Notifier::new(Arc::new(Recorder(StdMutex::new(Vec::new()))), Some("https://box.ts.net/".into()))
    }

    #[test]
    fn inv14_the_first_frame_is_backlog_not_news() {
        let n = notifier();
        let first = n.freshly_blocked(&[agent("a", AgentStatus::Waiting)]);
        assert!(first.is_empty(), "an agent blocked before this server looked is not news");
        // The same standing block does not become news later either.
        assert!(n.freshly_blocked(&[agent("a", AgentStatus::Waiting)]).is_empty());
    }

    #[test]
    fn inv14_a_watched_transition_fires_once_and_again_only_after_it_clears() {
        let n = notifier();
        n.freshly_blocked(&[agent("a", AgentStatus::Busy)]);
        let fired = n.freshly_blocked(&[agent("a", AgentStatus::Waiting)]);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].title, "agent-a");
        assert_eq!(fired[0].body, "Waiting on you — dialog open");
        assert_eq!(fired[0].link.as_deref(), Some("https://box.ts.net/agent/a"));
        assert_eq!(fired[0].tag, "a");
        // Standing: silent. Unblocked then blocked: news again.
        assert!(n.freshly_blocked(&[agent("a", AgentStatus::Waiting)]).is_empty());
        n.freshly_blocked(&[agent("a", AgentStatus::Busy)]);
        assert_eq!(n.freshly_blocked(&[agent("a", AgentStatus::Waiting)]).len(), 1);
    }

    #[test]
    fn inv14_a_visible_tab_is_the_notification() {
        let n = notifier();
        n.freshly_blocked(&[agent("a", AgentStatus::Busy)]);
        n.watched_on_screen(&[agent("a", AgentStatus::Waiting)]);
        // Consumed, not deferred: the block is not re-announced once nobody looks.
        assert!(n.freshly_blocked(&[agent("a", AgentStatus::Waiting)]).is_empty());
    }

    #[test]
    fn inv11_an_inferred_status_never_fires() {
        let n = notifier();
        n.freshly_blocked(&[]);
        let mut guessed = agent("k", AgentStatus::Waiting);
        guessed.status_inferred = Some(true);
        assert!(n.freshly_blocked(&[guessed]).is_empty());
    }

    #[test]
    fn a_push_without_an_address_carries_no_link() {
        let n = Notifier::new(Arc::new(Recorder(StdMutex::new(Vec::new()))), None);
        n.freshly_blocked(&[]);
        let fired = n.freshly_blocked(&[agent("a", AgentStatus::Waiting)]);
        assert_eq!(fired[0].link, None);
    }

    #[test]
    fn the_channel_spec_is_parsed_and_refused_in_words() {
        let env = |key: &str| (key == "AGENT_COMMANDER_TELEGRAM_TOKEN").then(|| "123:abc".to_string());
        assert_eq!(
            Channel::parse("https://ntfy.sh/my-topic", &env),
            Ok(Channel::Ntfy { url: "https://ntfy.sh/my-topic".into(), token: None })
        );
        assert_eq!(
            Channel::parse("telegram:-1001", &env),
            Ok(Channel::Telegram { chat_id: "-1001".into(), token: "123:abc".into() })
        );
        assert!(Channel::parse("https://ntfy.sh/", &env).unwrap_err().contains("topic URL"));
        assert!(Channel::parse("https://ntfy.sh/a/b", &env).unwrap_err().contains("topic URL"));
        assert!(Channel::parse("telegram:me", &env).unwrap_err().contains("numeric"));
        assert!(Channel::parse("mailto:x", &env).unwrap_err().contains("ntfy topic URL"));
        let no_env = |_: &str| None;
        assert!(
            Channel::parse("telegram:1", &no_env).unwrap_err().contains("AGENT_COMMANDER_TELEGRAM_TOKEN")
                || crate::token_file::read(&telegram_token_file()).is_some()
        );
    }

    /// The ntfy request as ntfy documents it: title, click and tags in
    /// headers, the body as the message — against a local server, so nothing
    /// leaves this machine.
    #[tokio::test]
    async fn inv3_an_ntfy_push_is_one_outbound_post_with_the_documented_headers() {
        use axum::{extract::State, routing::post, Router};
        use std::sync::Arc as A;
        type Seen = A<StdMutex<Vec<(String, String, String, String)>>>;
        let seen: Seen = A::new(StdMutex::new(Vec::new()));
        async fn take(State(seen): State<Seen>, headers: axum::http::HeaderMap, body: String) -> &'static str {
            let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            seen.lock().unwrap().push((h("title"), h("click"), h("tags"), body));
            "ok"
        }
        let app = Router::new().route("/agents", post(take)).with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let pusher = HttpPusher::new(Channel::Ntfy { url: format!("http://127.0.0.1:{port}/agents"), token: None });
        let push = Push {
            title: "shop".into(),
            body: "Waiting on you — dialog open".into(),
            link: Some("https://box.ts.net/agent/a".into()),
            tag: "a".into(),
        };
        pusher.push(&push).await.unwrap();
        let got = seen.lock().unwrap().clone();
        assert_eq!(
            got,
            vec![("shop".into(), "https://box.ts.net/agent/a".into(), "raised_hand".into(), push.body.clone())]
        );
    }
}
