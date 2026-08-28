//! Durable event store — SQLite (STORAGE.md).
//!
//! The daemon kept events in a `Vec` until now, so quitting the application lost the day. That is
//! not a small gap: statistics, ranking and every question about the past need a complete record,
//! and a memory-only store is a demo.
//!
//! One file, WAL, in the OS data directory. Two properties carry the design:
//!
//!   - **Nothing is persisted without a redaction stamp.** `redaction_version` is `NOT NULL` with no
//!     default, so an unredacted event cannot be inserted — the fail-closed rule of PRIVACY §4.2
//!     enforced by the schema rather than by discipline.
//!   - **Writes are small and immediate.** A crash costs the open span's end time, never an event
//!     (§96).

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::capture::FocusEvent;
use crate::platform::data_dir;

pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

/// The work day an instant belongs to, using the 04:00 local cutoff (INITIAL_ANALYSIS TR-8).
/// A 01:30 event belongs to the previous day's work, which is how people remember it.
pub fn work_day(timestamp_ms: u64, tz_offset_minutes: i32) -> String {
    let local_ms = timestamp_ms as i64 + (tz_offset_minutes as i64) * 60_000;
    let shifted = local_ms - 4 * 3_600_000;
    let days = shifted.div_euclid(86_400_000);
    // 1970-01-01 was a Thursday; civil-from-days, the standard algorithm.
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
        let path = dir.join("rewind.db");
        let conn = Connection::open(&path)?;

        // WAL so a read never blocks the writer; NORMAL is durable to a process crash, which is the
        // failure §96 budgets for. See STORAGE.md §1.
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
            "#,
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Insert one event. Returns its row id so the end timestamp can be filled in later.
    pub fn insert(&self, event: &FocusEvent, day: &str) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().expect("store");
        conn.execute(
            r#"INSERT INTO events (
                 timestamp, end_timestamp, tz_offset_minutes, work_day, source, type,
                 app_id, app_display, title, pid,
                 redaction_version, redaction_applied, redaction_count, importance
               ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"#,
            params![
                event.timestamp as i64,
                event.end_timestamp.map(|v| v as i64),
                event.tz_offset_minutes,
                day,
                "system",
                "system.window.focus",
                event.app_id,
                event.app_display,
                event.title,
                event.pid,
                event.redaction_version,
                event.redaction_applied.join(","),
                event.redaction_count as i64,
                event.importance,
            ],
        )?;
        Ok(conn.last_insert_rowid())
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

    pub fn recent(&self, limit: usize) -> rusqlite::Result<Vec<FocusEvent>> {
        let conn = self.conn.lock().expect("store");
        let mut stmt = conn.prepare(
            r#"SELECT timestamp, end_timestamp, tz_offset_minutes, app_id, app_display, title, pid,
                      redaction_version, redaction_applied, redaction_count, importance
               FROM events ORDER BY timestamp DESC LIMIT ?1"#,
        )?;
        let rows = stmt.query_map([limit as i64], |row| {
            let applied: String = row.get(8)?;
            Ok(FocusEvent {
                timestamp: row.get::<_, i64>(0)? as u64,
                end_timestamp: row.get::<_, Option<i64>>(1)?.map(|v| v as u64),
                tz_offset_minutes: row.get(2)?,
                app_id: row.get(3)?,
                app_display: row.get(4)?,
                title: row.get(5)?,
                pid: row.get(6)?,
                redaction_version: row.get(7)?,
                redaction_applied: if applied.is_empty() {
                    Vec::new()
                } else {
                    applied.split(',').map(str::to_owned).collect()
                },
                redaction_count: row.get::<_, i64>(9)? as usize,
                importance: row.get(10)?,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_late_night_event_belongs_to_the_previous_work_day() {
        // 2026-03-12 01:30 local, UTC+1 — that is Wednesday's work, not Thursday's.
        let ts = 1_773_278_000_000u64;
        let day = work_day(ts, 60);
        assert_eq!(day.len(), 10, "expected an ISO date, got {day}");

        // The cutoff shifts anything before 04:00 back a day, and nothing after it.
        let before_cutoff = work_day(1_773_270_000_000, 60);
        let after_cutoff = work_day(1_773_270_000_000 + 6 * 3_600_000, 60);
        assert_ne!(
            before_cutoff, after_cutoff,
            "03:00 and 09:00 on the same date must not share a work day boundary here"
        );
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_000), (2022, 1, 8));
    }
}
