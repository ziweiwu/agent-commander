//! Whether anybody is at a browser tab, for the push channel (INV-14).
//!
//! A push used to be held back while any connected tab said it was visible.
//! Visible is not the same as watched: a desk tab left on screen when its owner
//! walked away kept every push off the phone in their pocket, which is the one
//! device the push exists for. So a tab counts as somebody being there only
//! while it is visible **and** has seen a pointer, a key or a touch within
//! [`PRESENCE_WINDOW`]. A tab that is visible and untouched does not hold a
//! push back, so the mistake this rule makes is a duplicate alert — the phone
//! buzzes beside a screen already showing the block — never a missed one. A
//! hidden tab never counts, however recently it was used.
//!
//! Each tab reports its own input as a `present` message, at most once per
//! `PRESENCE_REPORT_MS` (`transport.ts`) and only when an input event fires,
//! never on a timer (INV-4). A browser's own notification is a separate,
//! per-device matter and still stands down while its own tab is visible.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long one input keeps a visible tab counting as somebody being there.
///
/// Three minutes, because it has to be three things at once. Several times
/// the client's report interval (30 seconds), so a tab in steady use never
/// lapses between two reports. Longer than a person reads a screenful of an
/// agent's reply without touching anything, so reading at the desk does not
/// buzz the phone for every block. And short, because it is also how long a
/// walk away from the desk can still swallow a push: a block that begins
/// inside it is consumed by a screen nobody is looking at any more.
pub const PRESENCE_WINDOW: Duration = Duration::from_secs(180);

/// Which connected tab a report is about. Handed out by [`Presence::arrive`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TabId(u64);

/// One tab: whether it says it is on screen, when it last felt a hand, and
/// which session it has open.
#[derive(Debug, Default, Clone)]
struct Tab {
    visible: bool,
    last_input_at: Option<Instant>,
    focused: Option<String>,
}

impl Tab {
    fn has_someone_at_it(&self, now: Instant) -> bool {
        let lately = |at: Instant| now.saturating_duration_since(at) < PRESENCE_WINDOW;
        self.visible && self.last_input_at.is_some_and(lately)
    }
}

/// Every connected tab's visibility and last input, by tab.
#[derive(Default)]
pub struct Presence {
    next: AtomicU64,
    tabs: Mutex<HashMap<TabId, Tab>>,
}

impl Presence {
    /// A name for a tab that has just connected. It counts for nothing until
    /// it says it is on screen and is used.
    pub fn arrive(&self) -> TabId {
        TabId(self.next.fetch_add(1, Ordering::Relaxed))
    }

    pub fn on_screen(&self, tab: TabId) {
        self.update(tab, |t| t.visible = true);
    }

    pub fn off_screen(&self, tab: TabId) {
        self.update(tab, |t| t.visible = false);
    }

    /// The tab felt a pointer, a key or a touch at `moment`.
    pub fn touched(&self, tab: TabId, moment: Instant) {
        self.update(tab, |t| t.last_input_at = Some(moment));
    }

    /// The tab opened a session, or closed the one it had (`None`).
    pub fn focus(&self, tab: TabId, session_id: Option<String>) {
        self.update(tab, |t| t.focused = session_id);
    }

    /// The sessions some tab has open while it is on screen — what "new since
    /// opened in this app" counts as seen (`seen.rs`). On screen alone, not
    /// [`PRESENCE_WINDOW`]: a conversation left open on a visible tab is being
    /// shown, which is the whole of the claim, while a hidden tab's open
    /// session is shown to nobody.
    pub fn on_screen_sessions(&self) -> HashSet<String> {
        let tabs = self.tabs.lock().unwrap();
        tabs.values().filter(|tab| tab.visible).filter_map(|tab| tab.focused.clone()).collect()
    }

    pub fn gone(&self, tab: TabId) {
        self.tabs.lock().unwrap().remove(&tab);
    }

    /// Whether any tab is on screen and was used within [`PRESENCE_WINDOW`]
    /// of `now` — the only thing that holds a push back.
    pub fn anyone_there(&self, now: Instant) -> bool {
        self.tabs.lock().unwrap().values().any(|tab| tab.has_someone_at_it(now))
    }

    fn update(&self, tab: TabId, change: impl FnOnce(&mut Tab)) {
        change(self.tabs.lock().unwrap().entry(tab).or_default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A_MOMENT: Duration = Duration::from_secs(1);

    #[test]
    fn inv14_a_visible_tab_nobody_has_used_is_nobody() {
        let presence = Presence::default();
        let tab = presence.arrive();
        presence.on_screen(tab);
        assert!(!presence.anyone_there(Instant::now()), "a desk tab left on screen must not silence the phone");
    }

    #[test]
    fn inv14_a_visible_tab_used_just_now_is_somebody() {
        let presence = Presence::default();
        let tab = presence.arrive();
        let now = Instant::now();
        presence.on_screen(tab);
        presence.touched(tab, now);
        assert!(presence.anyone_there(now + A_MOMENT));
    }

    #[test]
    fn inv14_a_hidden_tab_is_never_somebody() {
        let presence = Presence::default();
        let tab = presence.arrive();
        let now = Instant::now();
        presence.touched(tab, now);
        assert!(!presence.anyone_there(now), "never said it was visible");
        presence.on_screen(tab);
        presence.off_screen(tab);
        presence.touched(tab, now);
        assert!(!presence.anyone_there(now), "hidden, however recently used");
    }

    #[test]
    fn inv14_input_older_than_the_window_lapses() {
        let presence = Presence::default();
        let tab = presence.arrive();
        let then = Instant::now();
        presence.on_screen(tab);
        presence.touched(tab, then);
        assert!(presence.anyone_there(then + PRESENCE_WINDOW - A_MOMENT));
        assert!(!presence.anyone_there(then + PRESENCE_WINDOW));
        presence.touched(tab, then + PRESENCE_WINDOW);
        assert!(presence.anyone_there(then + PRESENCE_WINDOW), "used again, there again");
    }

    #[test]
    fn inv14_one_attended_tab_among_idle_ones_is_enough_and_a_closed_one_counts_for_nothing() {
        let presence = Presence::default();
        let now = Instant::now();
        let idle = presence.arrive();
        presence.on_screen(idle);
        let used = presence.arrive();
        presence.on_screen(used);
        presence.touched(used, now);
        assert!(presence.anyone_there(now));
        presence.gone(used);
        assert!(!presence.anyone_there(now));
    }
}
