//! Durable event store — SQLite (STORAGE.md).
//!
//! One file, WAL, in the OS data directory. Two properties carry the design:
//!
//!   - **Nothing is persisted without a redaction stamp.** `redaction_version` is `NOT NULL` with no
//!     default, so an unredacted event cannot be inserted — the fail-closed rule of PRIVACY §4.2
//!     enforced by the schema rather than by discipline.
//!   - **Writes are small and immediate.** A crash costs the open span's end time, never an event
//!     (§96).
//!
//! The table is generic over sources from the start. A store shaped around window focus would have
//! needed rewriting the moment a second source arrived, and the second source arrived immediately.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::platform::data_dir;

/// One stored event. Mirrors EVENT_MODEL §2, narrowed to what the daemon produces today.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub timestamp: u64,
    pub end_timestamp: Option<u64>,
    pub tz_offset_minutes: i32,
    pub source: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub app_id: String,
    pub app_display: String,
    /// Redacted before it ever reaches this struct.
    pub title: String,
    pub pid: Option<u32>,
    /// Type-specific payload, as JSON. Kept opaque here so a new source needs no schema change.
    pub metadata: String,
    pub redaction_version: String,
    /// Detector ids that fired. Never the matched values.
    pub redaction_applied: Vec<String>,
    pub redaction_count: usize,
    pub importance: i64,
}

/// One work day that has events in it, for the day navigator.
///
/// Counted in SQL rather than by loading the events, because the point of the navigator is to let
/// someone reach a day from six months ago without the interface having read the six months first.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaySummary {
    /// `YYYY-MM-DD`, on the 04:00 cutoff.
    pub day: String,
    pub count: u64,
    pub first: u64,
    pub last: u64,
}

pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

/// The projection every event query selects. Written once so two queries cannot drift into
/// disagreeing about column order, which fails at runtime and nowhere else.
const EVENT_COLUMNS: &str = "timestamp, end_timestamp, tz_offset_minutes, source, type, app_id, \
     app_display, title, pid, metadata, \
     redaction_version, redaction_applied, redaction_count, importance";

fn read_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    let applied: String = row.get(11)?;
    Ok(Event {
        timestamp: row.get::<_, i64>(0)? as u64,
        end_timestamp: row.get::<_, Option<i64>>(1)?.map(|v| v as u64),
        tz_offset_minutes: row.get(2)?,
        source: row.get(3)?,
        kind: row.get(4)?,
        app_id: row.get(5)?,
        app_display: row.get(6)?,
        title: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        pid: row.get(8)?,
        metadata: row
            .get::<_, Option<String>>(9)?
            .unwrap_or_else(|| "{}".into()),
        redaction_version: row.get(10)?,
        redaction_applied: if applied.is_empty() {
            Vec::new()
        } else {
            applied.split(',').map(str::to_owned).collect()
        },
        redaction_count: row.get::<_, i64>(12)? as usize,
        importance: row.get(13)?,
    })
}

/// The work day an instant belongs to, using the 04:00 local cutoff (INITIAL_ANALYSIS TR-8).
/// A 01:30 event belongs to the previous day's work, which is how people remember it.
pub fn work_day(timestamp_ms: u64, tz_offset_minutes: i32) -> String {
    let local_ms = timestamp_ms as i64 + (tz_offset_minutes as i64) * 60_000;
    let shifted = local_ms - 4 * 3_600_000;
    let days = shifted.div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

impl Store {
    pub fn open() -> rusqlite::Result<Self> {
        let dir = data_dir();
        std::fs::create_dir_all(&dir).ok();
        Self::open_at(dir.join("rewind.db"))
    }

    /// Open a store at an explicit path.
    ///
    /// Exists because the tests were opening the *user's* database — a suite that writes to real
    /// user data is a hazard regardless of what it asserts, and two tests racing on the same file is
    /// how the migration below started failing.
    pub fn open_at(path: PathBuf) -> rusqlite::Result<Self> {
        let conn = Connection::open(&path)?;

        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS events (
              id                INTEGER PRIMARY KEY AUTOINCREMENT,
              timestamp         INTEGER NOT NULL,
              end_timestamp     INTEGER,
              tz_offset_minutes INTEGER NOT NULL,
              work_day          TEXT    NOT NULL,
              source            TEXT    NOT NULL,
              type              TEXT    NOT NULL,
              app_id            TEXT    NOT NULL,
              app_display       TEXT    NOT NULL,
              title             TEXT,
              pid               INTEGER,
              -- NOT NULL with no default: this is what makes 'nothing is persisted without passing
              -- redaction' a property of the schema rather than a promise (PRIVACY §4.2).
              redaction_version TEXT    NOT NULL,
              redaction_applied TEXT    NOT NULL,
              redaction_count   INTEGER NOT NULL,
              importance        INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_events_time ON events(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_events_day  ON events(work_day, timestamp);

            -- How far each external source has been read, so a rescan is cheap and idempotent.
            CREATE TABLE IF NOT EXISTS sources (
              key       TEXT PRIMARY KEY,
              size      INTEGER NOT NULL,
              scanned_at INTEGER NOT NULL
            );
            "#,
        )?;

        // Additive migration: an existing database predates the generic metadata column, and
        // dropping the user's events to add a column would be the worst possible trade.
        let has_metadata: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'metadata'")?
            .exists([])?;
        if !has_metadata {
            const ADD_METADATA: &str =
                "ALTER TABLE events ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'";
            // Check-then-act is not atomic across connections, so losing the race is expected and
            // harmless: the column exists either way. Only a different failure is worth surfacing.
            if let Err(err) = conn.execute_batch(ADD_METADATA) {
                if !err.to_string().contains("duplicate column name") {
                    return Err(err);
                }
            }
        }

        // One agent session is one row, however many times its file is rescanned.
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_agent_session
             ON events(app_id, json_extract(metadata, '$.sessionId'))
             WHERE source = 'agent'",
        )
        .ok();

        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn insert(&self, event: &Event, day: &str) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().expect("store");
        conn.execute(
            r#"INSERT INTO events (
                 timestamp, end_timestamp, tz_offset_minutes, work_day, source, type,
                 app_id, app_display, title, pid, metadata,
                 redaction_version, redaction_applied, redaction_count, importance
               ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)"#,
            params![
                event.timestamp as i64,
                event.end_timestamp.map(|v| v as i64),
                event.tz_offset_minutes,
                day,
                event.source,
                event.kind,
                event.app_id,
                event.app_display,
                event.title,
                event.pid,
                event.metadata,
                event.redaction_version,
                event.redaction_applied.join(","),
                event.redaction_count as i64,
                event.importance,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// An agent session is rewritten as it grows, so it replaces its previous row rather than
    /// accumulating one per scan.
    pub fn upsert_agent_session(&self, event: &Event, session_id: &str) -> rusqlite::Result<()> {
        {
            let conn = self.conn.lock().expect("store");
            conn.execute(
                "DELETE FROM events WHERE source = 'agent'
                   AND app_id = ?1 AND json_extract(metadata, '$.sessionId') = ?2",
                params![event.app_id, session_id],
            )?;
        }
        let day = work_day(event.timestamp, event.tz_offset_minutes);
        self.insert(event, &day)?;
        Ok(())
    }

    /// Close a span. Separate from the insert because the end time is only known later, and waiting
    /// for it would mean losing the event entirely on a crash.
    pub fn close_span(&self, row_id: i64, end: u64, importance: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("store");
        conn.execute(
            "UPDATE events SET end_timestamp = ?1, importance = ?2 WHERE id = ?3",
            params![end as i64, importance, row_id],
        )?;
        Ok(())
    }

    pub fn recent(&self, limit: usize) -> rusqlite::Result<Vec<Event>> {
        let conn = self.conn.lock().expect("store");
        let mut stmt = conn.prepare(&format!(
            "SELECT {EVENT_COLUMNS} FROM events ORDER BY timestamp DESC LIMIT ?1"
        ))?;
        let rows = stmt.query_map([limit as i64], read_event)?;
        rows.collect()
    }

    /// Every event of one work day, oldest first.
    ///
    /// Indexed by `idx_events_day`, so reaching a day from six months ago costs the same as reaching
    /// yesterday. The limit is a safety rail against a single pathological day, not a page size —
    /// the interface needs the whole day or the engine reconstructs a partial one.
    pub fn for_day(&self, day: &str, limit: usize) -> rusqlite::Result<Vec<Event>> {
        let conn = self.conn.lock().expect("store");
        let mut stmt = conn.prepare(&format!(
            "SELECT {EVENT_COLUMNS} FROM events WHERE work_day = ?1
             ORDER BY timestamp ASC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![day, limit as i64], read_event)?;
        rows.collect()
    }

    /// Every work day that has anything in it, newest first.
    pub fn days(&self, limit: usize) -> rusqlite::Result<Vec<DaySummary>> {
        let conn = self.conn.lock().expect("store");
        let mut stmt = conn.prepare(
            "SELECT work_day, COUNT(*), MIN(timestamp), MAX(COALESCE(end_timestamp, timestamp))
             FROM events GROUP BY work_day ORDER BY work_day DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |row| {
            Ok(DaySummary {
                day: row.get(0)?,
                count: row.get::<_, i64>(1)? as u64,
                first: row.get::<_, i64>(2)? as u64,
                last: row.get::<_, i64>(3)? as u64,
            })
        })?;
        rows.collect()
    }

    pub fn count_for_day(&self, day: &str) -> rusqlite::Result<u64> {
        let conn = self.conn.lock().expect("store");
        conn.query_row(
            "SELECT COUNT(*) FROM events WHERE work_day = ?1",
            [day],
            |row| row.get::<_, i64>(0).map(|v| v as u64),
        )
    }

    pub fn total(&self) -> rusqlite::Result<u64> {
        let conn = self.conn.lock().expect("store");
        conn.query_row("SELECT COUNT(*) FROM events", [], |row| {
            row.get::<_, i64>(0).map(|v| v as u64)
        })
    }

    /// Has this external file been read at this size already?
    pub fn source_unchanged(&self, key: &str, size: u64) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().expect("store");
        let known: Option<i64> = conn
            .query_row("SELECT size FROM sources WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(known == Some(size as i64))
    }

    pub fn remember_source(&self, key: &str, size: u64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("store");
        conn.execute(
            "INSERT INTO sources (key, size, scanned_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET size = ?2, scanned_at = ?3",
            params![key, size as i64, crate::capture::now_ms() as i64],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_000), (2022, 1, 8));
    }

    /// A store of its own, in a temporary directory. A test must never touch the user's database.
    ///
    /// The counter is not decoration: cargo runs tests in parallel threads of one process, so a name
    /// built from the process id and the millisecond clock collides between two tests that start in
    /// the same millisecond.
    fn store() -> Store {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "rewind-store-test-{}-{}-{}.db",
            std::process::id(),
            crate::capture::now_ms(),
            n
        ));
        Store::open_at(path).expect("store")
    }

    fn event(timestamp: u64, title: &str) -> Event {
        Event {
            timestamp,
            end_timestamp: None,
            tz_offset_minutes: 60,
            source: "system".into(),
            kind: "system.window.focus".into(),
            app_id: "test".into(),
            app_display: "Test".into(),
            title: title.into(),
            pid: None,
            metadata: "{}".into(),
            redaction_version: "1".into(),
            redaction_applied: Vec::new(),
            redaction_count: 0,
            importance: 30,
        }
    }

    #[test]
    fn a_day_can_be_read_back_whole_and_on_its_own() {
        let store = store();
        // 09:00 and 03:00 the following morning, which the 04:00 cutoff files under the same day.
        let morning = 1_773_302_400_000u64;
        let small_hours = morning + 18 * 3_600_000;
        let next = morning + 30 * 3_600_000;
        for (ts, title) in [(morning, "a"), (small_hours, "b"), (next, "c")] {
            let day = work_day(ts, 60);
            store.insert(&event(ts, title), &day).expect("insert");
        }

        let first = work_day(morning, 60);
        let events = store.for_day(&first, 100).expect("for_day");
        assert_eq!(events.len(), 2, "the small hours belong to the evening before");
        assert_eq!(events[0].title, "a", "a day reads oldest first");

        let days = store.days(10).expect("days");
        assert_eq!(days.len(), 2);
        assert_eq!(days[0].day, work_day(next, 60), "newest day first");
        assert_eq!(days[1].count, 2);
        assert_eq!(days[1].first, morning);
    }

    #[test]
    fn the_work_day_cutoff_moves_the_small_hours_back() {
        // 03:00 and 09:00 on the same calendar date belong to different work days, because the
        // cutoff is 04:00 — a 01:30 commit is the previous day's work.
        let base = 1_773_270_000_000u64;
        let early = work_day(base, 60);
        let later = work_day(base + 6 * 3_600_000, 60);
        assert_eq!(early.len(), 10);
        assert_ne!(early, later);
    }
}
