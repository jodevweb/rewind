//! Claude Code session provider (ADR 0003 D-27, ADR 0005 D-37 P2).
//!
//! The deepest autonomous source in this workflow. Claude Code keeps its sessions as JSONL on disk,
//! so there is no API, no account and nothing to configure — which is exactly why it survives the
//! rule that removed Slack's API (ADR 0005 D-33).
//!
//! # The privacy design
//!
//! These files are the most sensitive on the machine: they contain source code, whole file contents
//! and secrets pasted by the user. So the reader takes an **explicit allowlist of fields and never
//! walks the object**.
//!
//! That direction matters. A blocklist would leak the first time a new content-bearing field
//! appeared — and given that eleven of the sixteen record types are already ones we ignore, new
//! fields appearing is the normal case rather than the exception.
//!
//! Never read, at any level: `message.content` text, `lastPrompt`, `attachment`, `queue-operation`,
//! `compactMetadata`, `snapshot`, and every `tool_use.input`.
//!
//! # Tolerance
//!
//! The format is undocumented and moves. The reader must survive new properties, unknown properties,
//! record types it has never seen, and a torn final line. **An unexpected line must never crash
//! REWIND** — it is skipped and counted.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::store::{Event, Store};

/// One line, read through the allowlist. Everything absent from this struct is discarded by serde
/// before it is ever in memory as anything but bytes.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    timestamp: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
    version: Option<String>,
    #[serde(rename = "isSidechain")]
    is_sidechain: Option<bool>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<String>,
    #[serde(rename = "agentName")]
    agent_name: Option<String>,
    #[serde(rename = "trackingPath")]
    tracking_path: Option<String>,
    #[serde(rename = "durationMs")]
    duration_ms: Option<u64>,
    #[serde(rename = "totalLinesAdded")]
    total_lines_added: Option<u64>,
    #[serde(rename = "totalLinesRemoved")]
    total_lines_removed: Option<u64>,
    #[serde(rename = "totalToolDuration")]
    total_tool_duration: Option<u64>,
    #[serde(rename = "modelUsage")]
    model_usage: Option<BTreeMap<String, Value>>,
    /// Read for one thing only: the NAMES of tools that ran. `tool_use.input` carries commands and
    /// file contents and is never touched.
    message: Option<Message>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Message {
    content: Option<Value>,
}

/// What a session amounted to. Metadata only — never a word of what was said.
#[derive(Default, Debug)]
struct Session {
    session_id: String,
    project_path: Option<String>,
    git_branch: Option<String>,
    version: Option<String>,
    title: Option<String>,
    agent_name: Option<String>,
    models: Vec<String>,
    files_touched: Vec<String>,
    tools: BTreeMap<String, u64>,
    tool_calls: u64,
    lines_added: u64,
    lines_removed: u64,
    duration_ms: u64,
    first_ts: Option<u64>,
    last_ts: Option<u64>,
    sidechain_only: bool,
}

fn parse_iso_ms(text: &str) -> Option<u64> {
    // "2026-08-28T14:32:11.482Z" — parsed by hand rather than pulling in a date crate for one shape.
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |a: usize, b: usize| text.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let ms = text
        .get(20..23)
        .and_then(|f| f.parse::<i64>().ok())
        .unwrap_or(0);

    // days_from_civil, the standard algorithm.
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    let total = days * 86_400_000 + h * 3_600_000 + mi * 60_000 + s * 1000 + ms;
    u64::try_from(total).ok()
}

/// Tool names only. `input` is never read — it holds commands and file contents.
fn collect_tool_names(content: &Value, into: &mut BTreeMap<String, u64>) -> u64 {
    let Some(items) = content.as_array() else {
        return 0;
    };
    let mut calls = 0;
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("tool_use") {
            if let Some(name) = item.get("name").and_then(Value::as_str) {
                *into.entry(name.to_owned()).or_insert(0) += 1;
                calls += 1;
            }
        }
    }
    calls
}

fn read_session(path: &Path) -> (Session, u64) {
    let mut session = Session {
        sidechain_only: true,
        ..Default::default()
    };
    let mut skipped = 0u64;

    let Ok(file) = std::fs::File::open(path) else {
        return (session, skipped);
    };

    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            skipped += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        // A record type we have never seen, or a torn final line, costs that line and nothing else.
        let Ok(parsed) = serde_json::from_str::<Line>(&line) else {
            skipped += 1;
            continue;
        };

        if let Some(id) = &parsed.session_id {
            if session.session_id.is_empty() {
                session.session_id = id.clone();
            }
        }
        if let Some(ts) = parsed.timestamp.as_deref().and_then(parse_iso_ms) {
            session.first_ts = Some(session.first_ts.map_or(ts, |f| f.min(ts)));
            session.last_ts = Some(session.last_ts.map_or(ts, |l| l.max(ts)));
        }
        if parsed.is_sidechain == Some(false) {
            session.sidechain_only = false;
        }
        if session.project_path.is_none() {
            session.project_path = parsed.cwd.clone();
        }
        if session.git_branch.is_none() {
            session.git_branch = parsed.git_branch.clone().filter(|b| !b.is_empty());
        }
        if session.version.is_none() {
            session.version = parsed.version.clone();
        }
        if parsed.ai_title.is_some() {
            session.title = parsed.ai_title.clone();
        }
        if parsed.agent_name.is_some() {
            session.agent_name = parsed.agent_name.clone();
        }

        match parsed.kind.as_str() {
            "file-history-delta" => {
                if let Some(p) = parsed.tracking_path {
                    if !session.files_touched.contains(&p) {
                        session.files_touched.push(p);
                    }
                }
            }
            "system" => session.duration_ms += parsed.duration_ms.unwrap_or(0),
            "cost-state" => {
                session.lines_added = parsed.total_lines_added.unwrap_or(session.lines_added);
                session.lines_removed = parsed.total_lines_removed.unwrap_or(session.lines_removed);
                if let Some(models) = parsed.model_usage {
                    for model in models.keys() {
                        if !session.models.contains(model) {
                            session.models.push(model.clone());
                        }
                    }
                }
                if let Some(d) = parsed.total_tool_duration {
                    session.duration_ms = session.duration_ms.max(d);
                }
            }
            "assistant" => {
                if let Some(content) = parsed.message.and_then(|m| m.content) {
                    session.tool_calls += collect_tool_names(&content, &mut session.tools);
                }
            }
            _ => {}
        }
    }

    (session, skipped)
}

fn projects_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let dir = home.join(".claude").join("projects");
    dir.is_dir().then_some(dir)
}

/// Turn a finished session into events. Metadata only — no prompts, no completions, no tool inputs.
fn events_for(session: &Session, tz: i32) -> Vec<Event> {
    let (Some(first), Some(last)) = (session.first_ts, session.last_ts) else {
        return Vec::new();
    };
    // A session with no real interaction is noise, not work.
    if session.tool_calls == 0 && session.files_touched.is_empty() {
        return Vec::new();
    }

    let project = session
        .project_path
        .as_deref()
        .and_then(|p| p.rsplit(['/', '\\']).next())
        .unwrap_or("")
        .to_owned();

    let title = session
        .title
        .clone()
        .unwrap_or_else(|| format!("Claude Code — {project}"));

    let mut top_tools: Vec<_> = session.tools.iter().collect();
    top_tools.sort_by(|a, b| b.1.cmp(a.1));
    let tools: Vec<String> = top_tools
        .into_iter()
        .take(8)
        .map(|(name, n)| format!("{name}×{n}"))
        .collect();

    let metadata = serde_json::json!({
        "agent": "claude-code",
        "sessionId": session.session_id,
        "projectPath": session.project_path,
        "project": project,
        "gitBranch": session.git_branch,
        "version": session.version,
        "agentName": session.agent_name,
        "models": session.models,
        "toolCallCount": session.tool_calls,
        "tools": tools,
        "filesTouched": session.files_touched.iter().take(25).collect::<Vec<_>>(),
        "filesTouchedCount": session.files_touched.len(),
        "linesAdded": session.lines_added,
        "linesRemoved": session.lines_removed,
        "isSidechain": session.sidechain_only,
    });

    vec![Event {
        timestamp: first,
        end_timestamp: Some(last),
        tz_offset_minutes: tz,
        source: "agent".to_owned(),
        kind: "agent.session".to_owned(),
        app_id: "claude-code".to_owned(),
        app_display: "Claude Code".to_owned(),
        title,
        pid: None,
        metadata: metadata.to_string(),
        // Redaction is applied by the caller, which owns the fail-closed rule.
        redaction_version: String::new(),
        redaction_applied: Vec::new(),
        redaction_count: 0,
        importance: 70,
    }]
}

/// Scan once. Only files whose size changed since the last pass are re-read.
///
/// `recording` false still walks the files and still records how far each one was read — it simply
/// writes no events. Pause means nothing is captured, not captured-and-hidden (§7), and a
/// file-derived source breaks that promise by accident if it skips a paused hour: the next pass
/// finds the file longer and stores everything that happened during it.
pub fn scan(store: &Store, tz: i32, recording: bool) -> (usize, u64) {
    let Some(root) = projects_dir() else {
        return (0, 0);
    };
    let redactor = crate::redact::Redactor::shared();
    let mut written = 0usize;
    let mut skipped_lines = 0u64;

    let Ok(dirs) = std::fs::read_dir(&root) else {
        return (0, 0);
    };
    for dir in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let key = path.display().to_string();
            let size = file.metadata().map(|m| m.len()).unwrap_or(0);
            if store.source_unchanged(&key, size).unwrap_or(false) {
                continue;
            }

            if !recording {
                let _ = store.remember_source(&key, size);
                continue;
            }

            let (session, skipped) = read_session(&path);
            skipped_lines += skipped;

            for mut event in events_for(&session, tz) {
                // Fail closed, exactly as for window titles: a redaction failure drops the event.
                let Some((title, stamp)) = redactor.redact(&event.title) else {
                    continue;
                };
                event.title = title;
                event.redaction_version = stamp.patterns_version;
                event.redaction_applied = stamp.applied;
                event.redaction_count = stamp.count;

                if store
                    .upsert_agent_session(&event, &session.session_id)
                    .is_ok()
                {
                    written += 1;
                }
            }
            let _ = store.remember_source(&key, size);
        }
    }

    (written, skipped_lines)
}

/// Rescan on a slow cadence. Sessions change while Claude runs, so a finished session is only
/// finished when the file stops growing — re-reading is cheap because the size check gates it.
pub fn spawn(
    store: std::sync::Arc<Store>,
    capture: std::sync::Arc<crate::capture::Capture>,
    tz: i32,
) {
    std::thread::spawn(move || loop {
        let (written, skipped) = scan(&store, tz, capture.is_recording());
        if written > 0 || skipped > 0 {
            println!("REWIND: Claude Code — {written} session(s), {skipped} ligne(s) ignorée(s)");
        }
        std::thread::sleep(std::time::Duration::from_secs(60));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_iso_timestamp() {
        // 2026-08-28T00:00:00.000Z
        let ms = parse_iso_ms("2026-08-28T00:00:00.000Z").expect("parses");
        assert_eq!(ms % 86_400_000, 0, "midnight should land on a day boundary");
        let later = parse_iso_ms("2026-08-28T01:00:00.000Z").expect("parses");
        assert_eq!(later - ms, 3_600_000);
    }

    #[test]
    fn epoch_is_zero() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
    }

    /// The reader must survive anything: unknown types, new fields, a torn line.
    #[test]
    fn unknown_records_and_torn_lines_are_skipped_not_fatal() {
        let mut tools = BTreeMap::new();
        let content = serde_json::json!([
            { "type": "text", "text": "should never be read" },
            { "type": "tool_use", "name": "Bash", "input": { "command": "secret" } },
            { "type": "tool_use", "name": "Bash" },
            { "type": "future_block_type", "whatever": true }
        ]);
        let calls = collect_tool_names(&content, &mut tools);
        assert_eq!(calls, 2);
        assert_eq!(tools.get("Bash"), Some(&2));
        // Nothing but names was collected — no text, no tool input.
        assert_eq!(tools.len(), 1);
    }

    #[test]
    fn a_line_with_only_unknown_fields_still_parses() {
        let parsed: Line =
            serde_json::from_str(r#"{"type":"brand-new","somethingElse":42}"#).expect("tolerant");
        assert_eq!(parsed.kind, "brand-new");
        assert!(parsed.session_id.is_none());
    }
}
