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
//! transition and open no port, which is what keeps INV-3 whole. The title is
//! the agent's name, or its folder and branch where Claude Code made the name
//! up, and never anything said in the conversation; the body is what it is
//! waiting for, in English or with `--notify-lang zh` in Chinese; and the
//! click is a link into this app, so answering still goes through the card and
//! its pane check (INV-2, INV-16) — nothing is answered from a lock screen.
//!
//! **INV-14 holds here as it does in the browser, rule for rule.** The first
//! fleet this tracker sees is backlog, not news: an agent that has been
//! waiting three days when the server starts notifies nobody. A standing block
//! never re-fires; one that unblocks and blocks again is news again. And a
//! tab somebody is at is already the notification, so while one is on screen
//! and was used within `PRESENCE_WINDOW` the transition is consumed and no
//! push goes — presence the client declares on its heartbeat and on input
//! (`presence.rs`), the way Claude Code's own Remote Control holds its pushes
//! while you are at the terminal. Visible alone is not enough: a desk tab left
//! on screen used to silence the phone. An inferred status never fires: it
//! can never be `waiting` (INV-11), and this checks that a second time rather
//! than trusting it.

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

/// The language a push's body is written in, from `--notify-lang`.
///
/// A server flag and not the browser's language setting, because that setting
/// is a preference and preferences never reach the server (FR-UI-12). The
/// title needs no translating: it is a name, a folder or a branch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PushLang {
    #[default]
    English,
    Chinese,
}

impl PushLang {
    /// What `--notify-lang` accepts, and the refusal for anything else.
    pub fn parse(spec: &str) -> Result<PushLang, String> {
        match spec {
            "en" => Ok(PushLang::English),
            "zh" => Ok(PushLang::Chinese),
            other => Err(format!("--notify-lang takes en or zh, got {other:?}")),
        }
    }

    /// "Waiting on you", and why, when the session says why.
    fn body(self, reason: Option<&str>) -> String {
        match (self, reason) {
            (PushLang::English, Some(reason)) => format!("Waiting on you — {reason}"),
            (PushLang::English, None) => "Waiting on you".to_string(),
            (PushLang::Chinese, Some(reason)) => format!("正在等你 — {}", reason_in_chinese(reason)),
            (PushLang::Chinese, None) => "正在等你".to_string(),
        }
    }
}

/// Claude Code's own words for why a session is blocked, as the card puts
/// them in Chinese (the `waiting*` keys in `i18n.ts`). The CLI picks from a
/// closed table; a reason outside it goes out as the CLI wrote it.
fn reason_in_chinese(reason: &str) -> &str {
    match reason {
        "dialog open" => "有对话框待确认",
        "permission prompt" => "有权限确认待处理",
        "input needed" => "需要输入",
        "sandbox request" => "有沙箱请求待处理",
        "goal proposal" => "有目标提议待确认",
        "worker request" => "有工作请求待处理",
        "starting up" => "正在启动",
        other => other,
    }
}

/// What a push is called: the agent's name, unless Claude Code made that name
/// up, and then where the agent is working.
///
/// The card leads a made-up name like `ziweiwu-35` with the conversation's
/// title, its description or its last prompt (`naming.ts`), so a push titled
/// with the raw name named a session nobody had seen on screen. A push cannot
/// borrow the card's choice: it leaves the machine for ntfy.sh or Telegram,
/// and all three are conversation (INV-3). The folder and the branch are on
/// the card's face and on the list of what is not conversation (`prefs.ts`).
fn push_title(agent: &Agent) -> String {
    if !name_is_derived(agent) || agent.folder.trim().is_empty() {
        return agent.name.clone();
    }
    match agent.git_branch.as_deref().map(str::trim).filter(|branch| !branch.is_empty()) {
        Some(branch) => format!("{} · {branch}", agent.folder),
        None => agent.folder.clone(),
    }
}

/// Whether Claude Code made this name up, decided as `isDerivedName` in
/// `naming.ts` decides it: the session file's own word when it has one, and
/// the shape of such names for a record from before it said.
fn name_is_derived(agent: &Agent) -> bool {
    agent.derived_name.unwrap_or_else(|| has_derived_shape(&agent.name))
}

/// How many hex digits Claude Code puts after the folder in a name it makes up.
const DERIVED_SUFFIX_DIGITS: std::ops::RangeInclusive<usize> = 2..=3;

/// `folder-35`, `my-repo-4af`: dash-separated letters and digits, then a short
/// hex suffix.
fn has_derived_shape(name: &str) -> bool {
    let Some((stem, suffix)) = name.rsplit_once('-') else { return false };
    let plain_word = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric());
    DERIVED_SUFFIX_DIGITS.contains(&suffix.len())
        && suffix.chars().all(|c| c.is_ascii_hexdigit())
        && stem.split('-').all(plain_word)
}

/// INV-14's tracker, server-side.
pub struct Notifier {
    seen: Mutex<Option<HashSet<String>>>,
    link_base: Option<String>,
    lang: PushLang,
    pusher: Arc<dyn Pusher>,
}

impl Notifier {
    pub fn new(pusher: Arc<dyn Pusher>, link_base: Option<String>, lang: PushLang) -> Arc<Self> {
        let link_base = link_base.map(|base| base.trim_end_matches('/').to_string());
        Arc::new(Self { seen: Mutex::new(None), link_base, lang, pusher })
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

    /// Note this frame's transitions and push none of them, for when somebody
    /// is at a tab: the screen is the notification, so the transition is
    /// consumed rather than deferred, exactly as the browser's own tracker
    /// does.
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
        Push {
            title: push_title(agent),
            body: self.lang.body(agent.waiting_for.as_deref()),
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
        notifier_in(PushLang::English)
    }

    fn notifier_in(lang: PushLang) -> Arc<Notifier> {
        Notifier::new(Arc::new(Recorder(StdMutex::new(Vec::new()))), Some("https://box.ts.net/".into()), lang)
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
    fn inv14_a_tab_somebody_is_at_is_the_notification() {
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

    /// The pushes one agent produces by being watched become blocked.
    fn pushes_for(n: &Notifier, waiting: &Agent) -> Vec<Push> {
        let mut before = waiting.clone();
        before.status = AgentStatus::Busy;
        n.freshly_blocked(&[before]);
        n.freshly_blocked(std::slice::from_ref(waiting))
    }

    /// A session Claude Code named itself, carrying every kind of
    /// conversation text a card might lead with instead of that name.
    fn derived(id: &str) -> Agent {
        Agent {
            name: "ziweiwu-35".into(),
            derived_name: Some(true),
            folder: "kb-vault".into(),
            cwd: "/Users/me/kb-vault".into(),
            git_branch: Some("main".into()),
            ai_title: Some("SEEDED-AI-TITLE refactor the billing page".into()),
            description: Some("SEEDED-DESCRIPTION make the export faster".into()),
            last_prompt: Some("SEEDED-PROMPT here is my password hunter2".into()),
            activity: Some("Bash: SEEDED-ACTIVITY cat ~/.ssh/id_rsa".into()),
            ..agent(id, AgentStatus::Waiting)
        }
    }

    #[test]
    fn a_derived_name_is_pushed_as_its_folder_and_branch() {
        let n = notifier();
        let fired = pushes_for(&n, &derived("a"));
        assert_eq!(fired[0].title, "kb-vault · main");

        let mut no_branch = derived("b");
        no_branch.git_branch = None;
        assert_eq!(pushes_for(&n, &no_branch)[0].title, "kb-vault");

        let mut unsaid = derived("c");
        unsaid.derived_name = None;
        assert_eq!(
            pushes_for(&n, &unsaid)[0].title,
            "kb-vault · main",
            "a record from before Claude Code said where its name came from gets the card's shape check"
        );

        let mut chosen = derived("d");
        chosen.derived_name = None;
        chosen.name = "billing".into();
        assert_eq!(pushes_for(&n, &chosen)[0].title, "billing", "a name somebody chose stays");
    }

    /// INV-3: a push leaves the machine for ntfy.sh or Telegram, so it may
    /// carry only what is not conversation — the card's title, description
    /// and prompts are exactly what it must never say.
    #[test]
    fn inv3_no_conversation_text_reaches_a_push() {
        let mut fired = Vec::new();
        for lang in [PushLang::English, PushLang::Chinese] {
            let n = notifier_in(lang);
            fired.extend(pushes_for(&n, &derived("a")));
            let mut unsaid = derived("b");
            unsaid.derived_name = None;
            fired.extend(pushes_for(&n, &unsaid));
        }
        assert_eq!(fired.len(), 4);
        for push in &fired {
            let all = format!("{} {} {:?} {}", push.title, push.body, push.link, push.tag);
            assert!(!all.contains("SEEDED"), "conversation text in a push: {all}");
        }
    }

    #[test]
    fn notify_lang_zh_writes_the_body_in_chinese() {
        let n = notifier_in(PushLang::Chinese);
        let fired = pushes_for(&n, &derived("a"));
        assert_eq!(fired[0].body, "正在等你 — 有对话框待确认");
        assert_eq!(fired[0].title, "kb-vault · main", "a folder and a branch are not translated");

        let mut unsaid = derived("b");
        unsaid.waiting_for = Some("a reason the CLI added later".into());
        assert_eq!(pushes_for(&n, &unsaid)[0].body, "正在等你 — a reason the CLI added later");
        unsaid.session_id = "c".into();
        unsaid.waiting_for = None;
        assert_eq!(pushes_for(&n, &unsaid)[0].body, "正在等你");

        assert_eq!(pushes_for(&notifier(), &derived("a"))[0].body, "Waiting on you — dialog open");
    }

    #[test]
    fn notify_lang_takes_en_or_zh_and_refuses_the_rest_in_words() {
        assert_eq!(PushLang::parse("en"), Ok(PushLang::English));
        assert_eq!(PushLang::parse("zh"), Ok(PushLang::Chinese));
        assert!(PushLang::parse("fr").unwrap_err().contains("en or zh"));
    }

    #[test]
    fn a_push_without_an_address_carries_no_link() {
        let n = Notifier::new(Arc::new(Recorder(StdMutex::new(Vec::new()))), None, PushLang::English);
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
