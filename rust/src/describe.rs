//! What a session is working on *now*, in its own words.
//!
//! Claude Code names a session once, from its opening exchange, and then never
//! revisits that name. Measured across 236 transcripts on this machine, every
//! session had exactly one distinct `ai-title` however long it ran and however
//! far it wandered: one titled "Under the Witch download" spent its last
//! thousand messages on a Telegram skill. The title is not wrong, it is old.
//!
//! So a card carries a second line, taken from the most recent prompt the user
//! typed that actually says something. The session describes itself. Nothing is
//! generated and no model is asked, so this costs one pass over records the
//! tail has already read (INV-4).
//!
//! The filtering is the whole job, because most prompts describe nothing.
//! "done", "grab them" and "U can add" are real recent prompts from this
//! machine, and each would make a worse card than the stale title it replaced.
//! A prompt that fails every test leaves the description alone rather than
//! replacing it with noise, so the line only ever moves forward onto something
//! worth reading.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

/// A description has to name at least this many distinct things to be worth a
/// line. Below it the prompt is a reaction ("does that work?") rather than a
/// statement of what the session is doing.
const MIN_TOPIC_WORDS: usize = 3;

/// One more than that when the prompt opens like a continuation, where the
/// subject usually sits in the previous message rather than in this one:
/// "also add the header" names nothing a reader of the card could place.
const MIN_TOPIC_WORDS_AFTER_FOLLOW_UP: usize = 4;

/// Shorter than this and there is no room for a request.
const MIN_PROMPT_CHARS: usize = 10;

/// What one line of a card can carry before it is clipped.
const MAX_DESCRIPTION_CHARS: usize = 70;

/// The longest `<…>` run treated as markup rather than prose, so that a stray
/// less-than in an ordinary sentence cannot swallow the rest of the line.
const MAX_TAG_CHARS: usize = 80;

/// The shortest `/…` or `~/…` run treated as a filesystem path. Short ones are
/// ordinary words with a slash in them, like "and/or".
const MIN_PATH_CHARS: usize = 8;

/// Whole prompts that acknowledge rather than ask. These are the ones that make
/// the current card useless, so they are matched exactly and always rejected.
const ACKNOWLEDGEMENTS: &[&str] = &[
    "yes", "no", "ok", "okay", "done", "continue", "proceed", "go", "go ahead", "thanks",
    "thank you", "sure", "yep", "yeah", "nope", "stop", "next", "more", "again", "good", "nice",
    "perfect", "great", "cool", "fix it", "do it", "try again", "keep going", "carry on",
    "resume", "retry", "ship it", "lgtm", "please", "go on", "grab them", "u can add",
    "you can add",
];

/// Openers that make a prompt a continuation of the one before it.
const FOLLOW_UP_OPENERS: &[&str] = &[
    "also ", "and ", "then ", "now ", "plus ", "another ", "same ", "for ", "what about",
    "how about", "why not", "ok ", "okay ", "update the", "proceed", "continue", "do that",
    "do this", "try that", "try this", "fix that", "fix this", "use that", "use this",
];

/// Openers that answer a question the agent asked. These read as intent but are
/// the user settling a detail, not naming the work: "as long as it is 720p I am
/// ok" described a session whose actual subject was a Telegram skill.
const PREFERENCE_OPENERS: &[&str] = &[
    "as long as", "i am ok", "im ok", "i think", "i guess", "maybe", "it depends", "sounds good",
    "looks good", "that works", "i prefer", "my preference", "i like", "not sure", "probably",
    "either", "both are", "yes but", "no but",
];

/// Words that name nothing on their own. A prompt built only from these is
/// grammar without a subject, so they are excluded from the topic count.
const STOP_WORDS: &[&str] = &[
    "a", "an", "the", "this", "that", "these", "those", "it", "its", "is", "are", "was", "were",
    "be", "been", "being", "am", "do", "does", "did", "done", "doing", "can", "could", "will",
    "would", "shall", "should", "may", "might", "must", "i", "you", "he", "she", "they", "we",
    "me", "my", "your", "our", "their", "him", "her", "them", "us", "and", "or", "but", "if",
    "then", "than", "so", "because", "as", "of", "to", "in", "on", "at", "by", "for", "with",
    "from", "into", "over", "under", "what", "which", "who", "whom", "whose", "why", "how",
    "when", "where", "whether", "add", "update", "fix", "change", "make", "set", "use", "run",
    "get", "put", "show", "give", "tell", "let", "try", "keep", "move", "also", "more", "another",
    "same", "again", "now", "next", "please", "just", "still", "yet", "even", "only", "very",
    "much", "one", "two", "three", "all", "any", "some", "no", "not", "none", "out", "up", "down",
    "off", "about", "after", "before", "good", "better", "best", "bad", "worse", "worst", "new",
    "old", "ones", "other", "thing", "things",
];

static STOP_WORD_SET: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| STOP_WORDS.iter().copied().collect());

static FENCED_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)```.*?```").unwrap());

static MARKUP_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"<[^>\n]{{0,{MAX_TAG_CHARS}}}>")).unwrap());

static LEADING_SLASH_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/(\w[\w-]*)\s*").unwrap());

static WEB_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://\S+").unwrap());

static FILE_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"[/~][\w./-]{{{MIN_PATH_CHARS},}}")).unwrap());

/// The description this record supports, if it is a prompt worth showing.
///
/// `None` for everything that is not the user speaking — tool results, task
/// notifications, compaction summaries and the dashboard's own sends — and for
/// prompts that say nothing a card could use.
pub fn description_from(rec: &Value) -> Option<String> {
    if rec.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if !is_typed_by_a_person(rec) {
        return None;
    }
    describe(&prompt_text(rec)?)
}

/*
 * Which records are the user speaking.
 *
 * Claude Code labels the origin of every prompt, and only `human` is a person
 * at a keyboard. The rest share the `user` record type but are machinery:
 * `system` carries task notifications, `sdk` carries programmatic sends, and
 * `peer` carries another agent. Reading the label beats guessing from the text,
 * which was the first attempt here and mistook pasted terminal output and skill
 * preambles for intent.
 *
 * INV-11: describing a session by a prompt it never received would be the
 * dashboard asserting more than it knows. The dashboard's own sends are
 * excluded for the same reason — a card must not quote us back to ourselves as
 * though the user had said it.
 */
fn is_typed_by_a_person(rec: &Value) -> bool {
    if rec.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
        || rec.get("isMeta").and_then(Value::as_bool) == Some(true)
        || rec.get("toolUseResult").is_some()
    {
        return false;
    }
    let origin_is_human = rec
        .get("origin")
        .and_then(|origin| origin.get("kind"))
        .and_then(Value::as_str)
        == Some("human");
    let source = rec.get("promptSource").and_then(Value::as_str);
    origin_is_human || matches!(source, Some("typed") | Some("queued"))
}

/// The prompt's text, whether the record spells its content as a bare string or
/// as a list of blocks.
fn prompt_text(rec: &Value) -> Option<String> {
    let content = rec.get("message")?.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let blocks = content.as_array()?;
    let joined = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    (!joined.is_empty()).then_some(joined)
}

/// One line describing this prompt, or `None` when it describes nothing.
pub fn describe(raw: &str) -> Option<String> {
    let prompt = strip_markup(raw);
    if !says_something(&prompt) {
        return None;
    }
    Some(clip(first_sentence(&prompt)))
}

/// Prose, with the things that are addressed to the machine taken out: code
/// blocks, markup tags, backticks and emphasis, URLs and long paths. A pasted
/// block keeps the words wrapped inside it, which is where the request usually
/// is.
///
/// A path is cut down to its last segment rather than dropped, because that
/// segment is usually the most informative word in the sentence: "the bug in
/// agent-commander" still names the work, where "the bug in" names nothing.
fn strip_markup(raw: &str) -> String {
    let without_code = FENCED_CODE.replace_all(raw.trim(), " ");
    let spelled_out = LEADING_SLASH_COMMAND.replace(&without_code, "$1 ");
    let without_tags = MARKUP_TAG.replace_all(&spelled_out, " ");
    let without_urls = WEB_URL.replace_all(&without_tags, " ");
    let shortened_paths = FILE_PATH.replace_all(&without_urls, last_segment);
    shortened_paths.replace(['`', '*'], " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The last non-empty segment of a matched path.
fn last_segment(matched: &regex::Captures<'_>) -> String {
    matched[0].rsplit('/').find(|segment| !segment.is_empty()).unwrap_or_default().to_string()
}

/// Whether this prompt names enough to be worth a line on a card.
fn says_something(prompt: &str) -> bool {
    if prompt.chars().count() < MIN_PROMPT_CHARS {
        return false;
    }
    let folded = prompt.to_lowercase();
    let bare = folded.trim_end_matches(['.', '!', '?', ',']);
    if ACKNOWLEDGEMENTS.contains(&bare) {
        return false;
    }
    if PREFERENCE_OPENERS.iter().any(|opener| folded.starts_with(opener)) {
        return false;
    }
    let needed = match FOLLOW_UP_OPENERS.iter().any(|opener| folded.starts_with(opener)) {
        true => MIN_TOPIC_WORDS_AFTER_FOLLOW_UP,
        false => MIN_TOPIC_WORDS,
    };
    topic_words(&folded).len() >= needed
}

/// The distinct words in this prompt that name something.
///
/// Scripts without spaces are counted by character, since one han character or
/// kana carries about as much subject as one western word and a whole Chinese
/// prompt would otherwise count as a single word and always be rejected.
fn topic_words(folded: &str) -> HashSet<String> {
    let mut found = HashSet::new();
    let mut latin = String::new();
    for character in folded.chars() {
        if is_ideographic(character) {
            found.insert(character.to_string());
            take_word(&mut latin, &mut found);
        } else if character.is_alphanumeric() || character == '\'' || character == '-' {
            latin.push(character);
        } else {
            take_word(&mut latin, &mut found);
        }
    }
    take_word(&mut latin, &mut found);
    found
}

/// Move the word being built into the set, if it names anything.
fn take_word(building: &mut String, found: &mut HashSet<String>) {
    let word = std::mem::take(building);
    if word.chars().count() > 1 && !STOP_WORD_SET.contains(word.as_str()) {
        found.insert(word);
    }
}

fn is_ideographic(character: char) -> bool {
    matches!(character, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}')
}

/// The first sentence, which is where the request is when a prompt goes on to
/// add detail.
fn first_sentence(prompt: &str) -> &str {
    let mut end = prompt.len();
    for (index, character) in prompt.char_indices() {
        if matches!(character, '.' | '?' | '!')
            && prompt[index + character.len_utf8()..].starts_with(' ')
        {
            end = index + character.len_utf8();
            break;
        }
    }
    prompt[..end].trim_end()
}

/// Clipped to a card's width, on a character boundary, with an ellipsis when
/// anything was dropped.
fn clip(sentence: &str) -> String {
    if sentence.chars().count() <= MAX_DESCRIPTION_CHARS {
        return sentence.to_string();
    }
    let kept: String = sentence.chars().take(MAX_DESCRIPTION_CHARS).collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn human(text: &str) -> Value {
        json!({ "type": "user", "origin": { "kind": "human" }, "message": { "content": text } })
    }

    #[test]
    fn describes_a_session_by_the_last_thing_actually_asked() {
        let asked = "Don't use haiku for anything, create heuristic fallback";
        assert_eq!(description_from(&human(asked)).as_deref(), Some(asked));
    }

    #[test]
    fn an_acknowledgement_describes_nothing() {
        for reaction in ["done", "grab them", "U can add", "ok", "continue"] {
            assert_eq!(describe(reaction), None, "{reaction:?} should not reach a card");
        }
    }

    #[test]
    fn a_follow_up_needs_more_of_a_subject_than_a_fresh_request() {
        assert_eq!(describe("also fix the header"), None);
        assert_eq!(
            describe("also rewrite the registry discovery loop").as_deref(),
            Some("also rewrite the registry discovery loop")
        );
    }

    #[test]
    fn settling_a_detail_is_not_a_description() {
        assert_eq!(describe("As long as video least 720p I am ok"), None);
        assert_eq!(describe("sounds good to me, whichever is faster"), None);
    }

    #[test]
    fn keeps_the_request_wrapped_in_pasted_markup() {
        let pasted = "<pasted_content id=\"4875\"> Prevent system-sleep while charging the laptop";
        assert_eq!(
            describe(pasted).as_deref(),
            Some("Prevent system-sleep while charging the laptop")
        );
    }

    #[test]
    fn a_typed_slash_command_is_still_the_user_speaking() {
        assert_eq!(
            describe("/goal implant all the roadmap items").as_deref(),
            Some("goal implant all the roadmap items")
        );
    }

    #[test]
    fn keeps_the_name_at_the_end_of_a_path_and_drops_the_rest() {
        let prompt = "fix the discovery loop in /Users/ziweiwu/Projects/agent-commander please";
        assert_eq!(
            describe(prompt).as_deref(),
            Some("fix the discovery loop in agent-commander please")
        );
    }

    #[test]
    fn a_prompt_that_is_only_a_link_describes_nothing() {
        assert_eq!(describe("have a look at https://example.com/some/report now"), None);
    }

    #[test]
    fn counts_a_prompt_with_no_spaces_by_character() {
        assert!(describe("推荐三张八十年代日本城市流行专辑").is_some());
    }

    #[test]
    fn keeps_only_the_first_sentence_and_clips_to_one_line() {
        let long = "Rewrite the enricher tick. It should back off when the fleet is large.";
        assert_eq!(describe(long).as_deref(), Some("Rewrite the enricher tick."));
        let wide = "rebuild the registry discovery loop, the enricher tick and the \
                    transcript backfill so a large fleet still paces itself";
        let line = describe(wide).unwrap();
        assert!(line.chars().count() <= MAX_DESCRIPTION_CHARS + 1, "{line:?}");
        assert!(line.ends_with('…'), "{line:?}");
    }

    #[test]
    fn inv11_only_a_person_describes_a_session() {
        let machinery = [
            json!({ "type": "user", "promptSource": "system",
                    "message": { "content": "<task-notification>a monitor fired</task-notification>" } }),
            json!({ "type": "user", "promptSource": "sdk",
                    "message": { "content": "rerun the failing integration suite" } }),
            json!({ "type": "user", "origin": { "kind": "human" }, "isCompactSummary": true,
                    "message": { "content": "This session is being continued from a previous one" } }),
            json!({ "type": "user", "origin": { "kind": "human" }, "toolUseResult": { "ok": true },
                    "message": { "content": "the command printed nothing at all" } }),
            json!({ "type": "assistant", "origin": { "kind": "human" },
                    "message": { "content": "I will rewrite the registry loop now" } }),
        ];
        for rec in machinery {
            assert_eq!(description_from(&rec), None, "{rec}");
        }
    }

    #[test]
    fn reads_a_prompt_spelled_as_blocks() {
        let rec = json!({
            "type": "user",
            "promptSource": "queued",
            "message": { "content": [
                { "type": "text", "text": "port the registry discovery loop to rust" },
            ] },
        });
        assert_eq!(
            description_from(&rec).as_deref(),
            Some("port the registry discovery loop to rust")
        );
    }
}

