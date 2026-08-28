# REWIND — Storage

> SQLite schema, indexing, retention, compaction and growth. Companion to EVENT_MODEL.md.

---

## 1. Engine

SQLite via `rusqlite` (bundled — no system dependency), one file at
`%LOCALAPPDATA%\REWIND\rewind.db`.

| Setting        | Value    | Why                                                                                                                  |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `journal_mode` | `WAL`    | Concurrent reads during writes; the UI never blocks on the writer                                                    |
| `synchronous`  | `NORMAL` | With WAL, durable to process crash; loses at most the last transaction on power loss, which is within the §96 budget |
| `foreign_keys` | `ON`     | Deletion must actually cascade (PRIVACY §10)                                                                         |
| `temp_store`   | `MEMORY` | FTS merges stay off disk                                                                                             |
| `mmap_size`    | 256 MB   | Fast timeline scans                                                                                                  |
| `busy_timeout` | 5000 ms  | One writer, several readers                                                                                          |

**Why SQLite** (§36): local-first, single file, transactional, portable, and it carries both full-text
search and vector search as extensions — so the entire storage and retrieval layer is one dependency with
no service to run.

**Location note.** `%LOCALAPPDATA%`, not `%APPDATA%`, deliberately: roaming profiles and OneDrive sync
corrupt WAL files.

---

## 2. Schema

```sql
CREATE TABLE events (
  id                TEXT PRIMARY KEY,          -- UUIDv7
  timestamp         INTEGER NOT NULL,          -- epoch ms UTC
  end_timestamp     INTEGER,
  tz_offset_minutes INTEGER NOT NULL,
  source            TEXT NOT NULL,
  type              TEXT NOT NULL,
  producer_name     TEXT NOT NULL,
  producer_version  TEXT NOT NULL,
  app               TEXT,
  app_display       TEXT,
  title             TEXT,                      -- redacted
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  repository_id     TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  metadata          TEXT NOT NULL,             -- JSON, schema-validated per type
  privacy_level     TEXT NOT NULL,
  redaction_version TEXT NOT NULL,             -- the stamp; NOT NULL is the enforcement
  redaction_applied TEXT NOT NULL,             -- JSON array of detector ids
  searchable_text   TEXT,
  importance        INTEGER NOT NULL,
  activity_id       TEXT REFERENCES activities(id) ON DELETE SET NULL,
  context_id        TEXT REFERENCES contexts(id) ON DELETE SET NULL
);

CREATE INDEX idx_events_time        ON events(timestamp DESC);
CREATE INDEX idx_events_context     ON events(context_id, timestamp DESC);
CREATE INDEX idx_events_activity    ON events(activity_id);
CREATE INDEX idx_events_project     ON events(project_id, timestamp DESC);
CREATE INDEX idx_events_type_time   ON events(type, timestamp DESC);
CREATE INDEX idx_events_importance  ON events(importance DESC, timestamp DESC);
```

`redaction_version TEXT NOT NULL` is the mechanism behind PRIVACY §4.2: an unredacted event cannot be
inserted, because the column has no default and the writer only fills it from a completed redaction pass.

Remaining tables follow EVENT_MODEL §6–11: `activities`, `sessions`, `contexts`, `context_links`,
`decisions`, `outcomes`, `projects`, `repositories`, `pause_intervals`, `notes`, `jobs`, `privacy_rules`,
`context_rules`, `ai_sends` (the permanent receipt log from PRIVACY §12), `schema_version`.

Storage conventions: timestamps are integer epoch ms UTC, never text; IDs are UUIDv7 text; `metadata` is
JSON validated on write; arrays are junction tables, never JSON blobs, wherever they are queried.

---

## 3. Full-text search (§37)

Three external-content FTS5 tables so ranking can differ by layer:

```sql
CREATE VIRTUAL TABLE events_fts USING fts5(
  searchable_text,
  content='events', content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2",
  prefix='2 3 4'
);
```

Plus `activities_fts` and `contexts_fts`. Kept in sync inside the same transaction as the base write —
never by trigger, so a failed index write rolls the event back rather than leaving a half-indexed row.

**Identifier tokenisation.** Before indexing, `searchable_text` is augmented with split forms so
code-shaped queries work: `stripe.webhook.ts` also indexes `stripe webhook ts`;
`feature/auth-session` also indexes `feature auth session`; `getUserById` also indexes `get user by id`.
Without this, the search box fails on exactly the terms a developer would type.

**Rebuild path.** `INSERT INTO events_fts(events_fts) VALUES('rebuild')` runs at startup if the integrity
check finds a torn index (§96).

---

## 4. Vector search (§38)

`sqlite-vec`, statically linked into the rusqlite build — one file, one process, no service (TR-7).

```sql
CREATE VIRTUAL TABLE activity_vectors USING vec0(
  activity_id TEXT PRIMARY KEY,
  embedding   FLOAT[384]
);
```

Indexed: **activities and contexts only, never raw events** (TR-6). At ~200 activities/day, a year is
~73 000 vectors ≈ 112 MB — brute-force k-NN over that is single-digit milliseconds, so no ANN index is
needed at this scale.

**Degradation.** If the extension fails to load, `SearchIndex` reports `vector: unavailable`, ranking
renormalises over the remaining features, and the UI shows a one-time notice. Search never fails because
of the vector stage.

---

## 5. Migrations (§97)

Numbered SQL files applied in a transaction, tracked in `schema_version`.

```
migrations/0001_initial.sql
migrations/0002_context_links.sql
```

Rules: forward-only; every migration is idempotent-safe to re-run; **an automatic backup
(`rewind.db.bak.<version>`) is taken before any migration that drops or rewrites a table**; a failed
migration rolls back and the app starts on the backup with a visible warning rather than pretending
nothing happened. Every migration has an up-test from the previous version with realistic data.

---

## 6. Write path

```
NormalizedEvent → batch buffer → (2 s OR 100 events) → single transaction:
    INSERT INTO events
    INSERT INTO events_fts
    UPDATE projects.last_active_at
    enqueue job: group_activities
```

One writer connection; readers use a pool. Worst-case loss on a hard crash is one batch — under 2
seconds (§96).

---

## 7. Retention (§39, PRIVACY §9)

| Layer                            | Default | Action on expiry                     |
| -------------------------------- | ------- | ------------------------------------ |
| `events`                         | 90 days | Compact → delete                     |
| `activities`                     | 1 year  | Compact → delete                     |
| `sessions`                       | 1 year  | Delete (durations already rolled up) |
| `contexts`                       | Forever | —                                    |
| `context_links`                  | Forever | —                                    |
| `decisions`, `outcomes`, `notes` | Forever | —                                    |
| `ai_sends`                       | Forever | — (this is the user's receipt log)   |
| `jobs` (completed)               | 7 days  | Delete                               |
| logs                             | 14 days | Rotate                               |

The retention sweep runs daily on idle, in bounded chunks (5 000 rows per transaction) so it never
stalls the UI.

---

## 8. Compaction contract (§40, TR-5)

**Compaction may reduce volume. It may never remove a citable identifier.**

Before deleting an expired event, its evidence is folded upward:

```
event → activity:  file paths, URLs, commands, commit SHAs, error signatures, timestamps
activity → context: same, deduplicated, as context_links with occurrence counts and time ranges
```

What is dropped: window-focus churn, intermediate saves, tab noise, duplicate navigations, per-event
metadata that is now summarised.

What is kept forever: every commit SHA, file path, canonical URL, command string, ticket ID, error
signature and first/last-seen timestamp — as `context_links` rows.

**The test** (P12-002): compact a golden session, delete its raw events, then run the §127 causal
queries. They must still answer with correct citations. If they cannot, compaction is broken, and this
is the failure that would otherwise be invisible for six months.

---

## 9. Deletion (§99, PRIVACY §10)

Granularity: event · context · day · project · everything.

```
DELETE base rows
  → cascade to junction and FTS/vector rows (foreign keys ON)
  → recompute affected activities and contexts
  → unlink any files
  → VACUUM
```

No soft-delete column exists anywhere in the schema. The verification test scans the raw `.db` file for
the deleted string and fails if it is present. `VACUUM` runs on idle with progress shown, since it can
take tens of seconds on a large database.

---

## 10. Growth model (§92, TR-13)

Estimated at ~1 800 stored events/day:

| Component                        | Per day     | Per year                 |
| -------------------------------- | ----------- | ------------------------ |
| `events` rows                    | ~510 KB     | ~186 MB                  |
| `events_fts`                     | ~250 KB     | ~91 MB                   |
| Activities + sessions + contexts | ~40 KB      | ~15 MB                   |
| Vectors (activities)             | ~300 KB     | ~110 MB                  |
| Indexes and overhead             | ~200 KB     | ~73 MB                   |
| **Total before compaction**      | **~1.3 MB** | **~475 MB**              |
| **After 90-day compaction**      |             | **~150 MB steady state** |

Measured, not assumed: `rewind-cli simulate --days N` (P0-007) runs weekly in CI and fails if actual
growth exceeds 60 MB/month.

For contrast, screenshots at one per minute at 100 KB would be ~48 MB/day — roughly 30× the entire event
corpus. That comparison is the empirical case for §111.

---

## 11. Backup and portability

The database is one file; copying it is a complete backup. Automatic backups before migrations, retained
for the last three versions. Export (§98) produces JSON and Markdown, so nothing is trapped in a format
only REWIND can read. No cloud backup exists, by design (§152).
