//! Codex session provider.
//!
//! Codex (the CLI and the editor extension) keeps every thread as a zstd-compressed JSONL "rollout"
//! under `~/.codex/sessions/YYYY/MM/DD/`, and the thread names in `~/.codex/session_index.jsonl`.
//! Like Claude Code, there is no API and nothing to configure: the files are already on disk.
//!
//! # The privacy design
//!
//! Same rule as `claude.rs`: an explicit allowlist, enforced by the types. Every line is
//! deserialised into structs that name the few fields kept; serde skips everything else without
//! building it. Never read: message content, reasoning, tool arguments and outputs, command text and
//! output, diffs and file contents, the first user message, instructions.
//!
//! What is kept: timestamps, the working directory, the model, tool NAMES, and the PATHS of changed
//! files (the keys of a file change, never its content).
//!
//! # Tolerance
//!
//! The format is undocumented and changes between versions. A line that does not parse costs that
//! line; a file that does not decompress costs that file. Nothing here may crash REWIND.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::de::IgnoredAny;
use serde::Deserialize;

use crate::claude::{bursts, parse_iso_ms, BURST_GAP_MS};
use crate::store::{Event, Store};

#[derive(Deserialize, Default)]
#[serde(default)]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    timestamp: Option<String>,
    payload: Payload,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Payload {
    #[serde(rename = "type")]
    kind: Option<String>,
    /// `session_meta`: the thread id.
    id: Option<String>,
    /// `session_meta` and `turn_context`.
    cwd: Option<String>,
    cli_version: Option<String>,
    /// `session_meta`: a string for a user thread, an object for a sub-agent.
    source: Option<Source>,
    /// `turn_context`.
    model: Option<String>,
    /// `function_call` / `custom_tool_call`: the tool's name. Its `arguments`/`input` are skipped.
    name: Option<String>,
    /// `event_msg/item_completed`.
    item: Option<Item>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Source {
    Named(#[allow(dead_code)] String),
    Spawned(#[allow(dead_code)] IgnoredAny),
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Item {
    #[serde(rename = "type")]
    kind: Option<String>,
    /// `FileChange`: keyed by path. Only the keys are kept; each value (content or diff) is skipped.
    changes: Option<BTreeMap<String, IgnoredAny>>,
    /// `McpToolCall`.
    server: Option<String>,
}

#[derive(Default, Debug)]
struct Session {
    session_id: String,
    project_path: Option<String>,
    version: Option<String>,
    subagent: bool,
    models: Vec<String>,
    files_touched: Vec<String>,
    tools: BTreeMap<String, u64>,
    tool_calls: u64,
    stamps: Vec<u64>,
}

fn read_lines(reader: impl BufRead) -> (Session, u64) {
    let mut session = Session::default();
    let mut skipped = 0u64;
    for line in reader.lines() {
        // A decompression error mid-file ends the read with whatever was gathered so far.
        let Ok(line) = line else {
            skipped += 1;
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Line>(&line) else {
            skipped += 1;
            continue;
        };
        if let Some(ts) = parsed.timestamp.as_deref().and_then(parse_iso_ms) {
            session.stamps.push(ts);
        }
        let p = parsed.payload;
        match (parsed.kind.as_str(), p.kind.as_deref()) {
            // Only the first one describes this thread. A sub-agent's rollout carries its parent's
            // history too, parent `session_meta` included, and reading that one as well would
            // relabel the sub-agent as the user thread it was spawned from.
            ("session_meta", _) if session.session_id.is_empty() => {
                session.session_id = p.id.unwrap_or_default();
                session.project_path = p.cwd;
                session.version = p.cli_version;
                session.subagent = matches!(p.source, Some(Source::Spawned(_)));
            }
            ("turn_context", _) => {
                if session.project_path.is_none() {
                    session.project_path = p.cwd;
                }
                if let Some(model) = p.model {
                    if !session.models.contains(&model) {
                        session.models.push(model);
                    }
                }
            }
            ("response_item", Some("function_call" | "custom_tool_call")) => {
                if let Some(name) = p.name {
                    *session.tools.entry(name).or_insert(0) += 1;
                    session.tool_calls += 1;
                }
            }
            ("event_msg", Some("item_completed")) => {
                let Some(item) = p.item else { continue };
                match item.kind.as_deref() {
                    Some("FileChange") => {
                        for path in item.changes.unwrap_or_default().into_keys() {
                            if !session.files_touched.contains(&path) {
                                session.files_touched.push(path);
                            }
                        }
                    }
                    Some("McpToolCall") => {
                        let name = format!("mcp:{}", item.server.unwrap_or_default());
                        *session.tools.entry(name).or_insert(0) += 1;
                        session.tool_calls += 1;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    (session, skipped)
}

fn read_session(path: &Path) -> (Session, u64) {
    let Ok(file) = std::fs::File::open(path) else {
        return (Session::default(), 0);
    };
    let compressed = path.extension().and_then(|e| e.to_str()) == Some("zst");
    if compressed {
        match ruzstd::decoding::StreamingDecoder::new(file) {
            Ok(decoder) => read_lines(BufReader::new(decoder)),
            Err(_) => (Session::default(), 1),
        }
    } else {
        read_lines(BufReader::new(file))
    }
}

fn codex_home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").map(PathBuf::from) {
        return dir.is_dir().then_some(dir);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let dir = home.join(".codex");
    dir.is_dir().then_some(dir)
}

/// Thread id → name, from `session_index.jsonl`. The last entry for an id wins: renames append.
fn thread_names(home: &Path) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct Entry {
        id: String,
        thread_name: Option<String>,
    }
    let mut names = HashMap::new();
    let Ok(file) = std::fs::File::open(home.join("session_index.jsonl")) else {
        return names;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let Ok(entry) = serde_json::from_str::<Entry>(&line) {
            if let Some(name) = entry.thread_name.filter(|n| !n.trim().is_empty()) {
                names.insert(entry.id, name);
            }
        }
    }
    names
}

fn events_for(session: &Session, title: Option<&str>, tz: i32) -> Vec<Event> {
    if session.session_id.is_empty() || session.stamps.is_empty() {
        return Vec::new();
    }
    if session.tool_calls == 0 && session.files_touched.is_empty() {
        return Vec::new();
    }
    let project = session
        .project_path
        .as_deref()
        .and_then(|p| p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next())
        .unwrap_or("")
        .to_owned();
    let title = title
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Codex — {project}"));

    let mut top: Vec<_> = session.tools.iter().collect();
    top.sort_by(|a, b| b.1.cmp(a.1));
    let tools: Vec<String> = top
        .into_iter()
        .take(8)
        .map(|(name, n)| format!("{name}×{n}"))
        .collect();

    let spans = bursts(&session.stamps, BURST_GAP_MS);
    let last = spans.len().saturating_sub(1);
    spans
        .iter()
        .enumerate()
        .map(|(i, &(start, end))| {
            let mut metadata = serde_json::json!({
                "agent": "codex",
                "sessionId": session.session_id,
                "projectPath": session.project_path,
                "project": project,
                "version": session.version,
                "isSidechain": session.subagent,
            });
            if i == last {
                let map = metadata.as_object_mut().expect("object");
                map.insert("models".into(), serde_json::json!(session.models));
                map.insert(
                    "toolCallCount".into(),
                    serde_json::json!(session.tool_calls),
                );
                map.insert("tools".into(), serde_json::json!(tools));
                map.insert(
                    "filesTouched".into(),
                    serde_json::json!(session.files_touched.iter().take(25).collect::<Vec<_>>()),
                );
                map.insert(
                    "filesTouchedCount".into(),
                    serde_json::json!(session.files_touched.len()),
                );
            }
            Event {
                timestamp: start,
                end_timestamp: Some(end),
                tz_offset_minutes: tz,
                source: "agent".to_owned(),
                kind: "agent.session".to_owned(),
                app_id: "codex".to_owned(),
                app_display: "Codex".to_owned(),
                title: title.clone(),
                pid: None,
                metadata: metadata.to_string(),
                redaction_version: String::new(),
                redaction_applied: Vec::new(),
                redaction_count: 0,
                importance: 70,
            }
        })
        .collect()
}

fn rollouts(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                rollouts(&path, depth - 1, out);
            }
        } else {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with("rollout-")
                && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
            {
                out.push(path);
            }
        }
    }
}

/// Scan once. Same contract as `claude::scan`: size-gated, redact before store, and a paused pass
/// records how far each file was read without writing anything.
pub fn scan(store: &Store, tz: i32, recording: bool) -> (usize, u64) {
    let Some(home) = codex_home() else {
        return (0, 0);
    };
    let mut files = Vec::new();
    // sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]
    rollouts(&home.join("sessions"), 3, &mut files);
    if files.is_empty() {
        return (0, 0);
    }
    let names = thread_names(&home);
    let redactor = crate::redact::Redactor::shared();
    let mut written = 0usize;
    let mut skipped_lines = 0u64;

    for path in files {
        let key = path.display().to_string();
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if store.source_unchanged(&key, size).unwrap_or(false) {
            continue;
        }
        if !recording {
            let _ = store.remember_source(&key, size);
            continue;
        }
        let (session, skipped) = read_session(&path);
        skipped_lines += skipped;

        let mut redacted = Vec::new();
        let title = names.get(&session.session_id).map(String::as_str);
        for mut event in events_for(&session, title, tz) {
            let Some((title, stamp)) = redactor.redact(&event.title) else {
                continue;
            };
            event.title = title;
            event.redaction_version = stamp.patterns_version;
            event.redaction_applied = stamp.applied;
            event.redaction_count = stamp.count;
            redacted.push(event);
        }
        if !redacted.is_empty()
            && store
                .replace_agent_session(&redacted, &session.session_id)
                .is_ok()
        {
            written += redacted.len();
        }
        let _ = store.remember_source(&key, size);
    }
    (written, skipped_lines)
}

pub fn spawn(
    store: std::sync::Arc<Store>,
    capture: std::sync::Arc<crate::capture::Capture>,
    tz: i32,
) {
    std::thread::spawn(move || loop {
        let (written, skipped) = scan(&store, tz, capture.is_recording());
        if written > 0 || skipped > 0 {
            println!("REWIND: Codex — {written} session(s), {skipped} ligne(s) ignorée(s)");
        }
        std::thread::sleep(std::time::Duration::from_secs(60));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str) -> Session {
        read_lines(BufReader::new(text.as_bytes())).0
    }

    const SAMPLE: &str = r#"{"timestamp":"2026-10-01T09:00:00.000Z","type":"session_meta","payload":{"id":"t-1","cwd":"/work/atlas","cli_version":"1.2.3","source":"vscode","base_instructions":"SHOULD NOT BE KEPT"}}
{"timestamp":"2026-10-01T09:00:01.000Z","type":"turn_context","payload":{"cwd":"/work/atlas","model":"some-model","sandbox_policy":{}}}
{"timestamp":"2026-10-01T09:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"secret prompt"}]}}
{"timestamp":"2026-10-01T09:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":\"cat .env\"}"}}
{"timestamp":"2026-10-01T09:02:00.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch"}}
{"timestamp":"2026-10-01T09:02:01.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","changes":{"/work/atlas/src/a.rs":{"type":"update","unified_diff":"-old\n+new"}}}}}
{"timestamp":"2026-10-01T09:03:00.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"docs","tool":"search","arguments":{"q":"x"},"result":"y"}}}
{"timestamp":"2026-10-01T12:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{}}}
{"torn line"#;

    #[test]
    fn keeps_metadata_and_names_only() {
        let s = read(SAMPLE);
        assert_eq!(s.session_id, "t-1");
        assert_eq!(s.project_path.as_deref(), Some("/work/atlas"));
        assert_eq!(s.models, vec!["some-model"]);
        assert_eq!(s.files_touched, vec!["/work/atlas/src/a.rs"]);
        assert_eq!(s.tool_calls, 3);
        assert_eq!(s.tools.get("shell"), Some(&1));
        assert_eq!(s.tools.get("mcp:docs"), Some(&1));
        assert!(!s.subagent);
        // Nothing that was said, typed, run or written survives into the session.
        let dump = format!("{s:?}");
        for leaked in [
            "secret prompt",
            "cat .env",
            "Begin Patch",
            "+new",
            "SHOULD NOT",
        ] {
            assert!(!dump.contains(leaked), "leaked {leaked}");
        }
    }

    #[test]
    fn a_thread_left_open_is_cut_into_bursts() {
        let events = events_for(&read(SAMPLE), Some("Fix the parser"), 0);
        // 09:00–09:03, then a lone record three hours later.
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].title, "Fix the parser");
        assert_eq!(events[0].app_id, "codex");
        // Totals only on the last burst.
        assert!(!events[0].metadata.contains("filesTouched"));
        assert!(events[1].metadata.contains("a.rs"));
    }

    #[test]
    fn a_subagent_is_marked_as_such() {
        let s = read(
            r#"{"timestamp":"2026-10-01T09:00:00.000Z","type":"session_meta","payload":{"id":"t-2","cwd":"/w","source":{"subagent":{"thread_spawn":{"depth":1}}}}}"#,
        );
        assert!(s.subagent);
    }

    #[test]
    fn a_subagent_keeps_its_own_identity_over_its_parents() {
        let s = read(concat!(
            r#"{"timestamp":"2026-10-01T09:00:00.000Z","type":"session_meta","payload":{"id":"child","cwd":"/w","source":{"subagent":{}}}}"#,
            "\n",
            r#"{"timestamp":"2026-10-01T08:00:00.000Z","type":"session_meta","payload":{"id":"parent","cwd":"/other","source":"vscode"}}"#,
        ));
        assert_eq!(s.session_id, "child");
        assert_eq!(s.project_path.as_deref(), Some("/w"));
        assert!(s.subagent);
    }

    #[test]
    fn a_session_with_no_work_is_not_an_event() {
        let s = read(
            r#"{"timestamp":"2026-10-01T09:00:00.000Z","type":"session_meta","payload":{"id":"t-3","cwd":"/w","source":"cli"}}"#,
        );
        assert!(events_for(&s, None, 0).is_empty());
    }
}
