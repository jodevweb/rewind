# REWIND — Performance

> A memory tool that costs 15 % CPU gets uninstalled no matter how good its answers are.
> These are budgets, not aspirations, and each has a test.

---

## 1. Budgets (§90)

| Metric                                              | Target             | Hard fail    |
| --------------------------------------------------- | ------------------ | ------------ |
| Idle CPU, average over 8 h (collectors on, no jobs) | < 2 %              | > 5 %        |
| Peak CPU during a background job                    | < 25 % of one core | > 50 %       |
| Resident memory, idle                               | < 250 MB           | > 400 MB     |
| Resident memory, UI open with timeline              | < 450 MB           | > 700 MB     |
| Disk writes, idle                                   | < 5 MB/hour        | > 20 MB/hour |
| App cold start to window                            | < 1.5 s            | > 3 s        |
| Daemon start to first event                         | < 500 ms           | > 2 s        |
| Battery impact vs. control                          | < 3 %              | > 8 %        |

UI latency budgets are UX requirements (UX §13): Today < 500 ms, Resume < 300 ms, timeline filter
< 100 ms, search-as-you-type < 50 ms, full search < 200 ms p95.

---

## 2. Why event-first is a performance strategy

The architecture is the main optimisation. Screenshot-based capture at one frame per minute would mean
~48 MB/day of writes, continuous image encoding, and OCR — hundreds of times the cost of this design
(TR-13, STORAGE §10). Choosing structured events over pixels is worth more than every micro-optimisation
in this document combined.

---

## 3. Collection

**Event-driven throughout** (§91). Windows `SetWinEventHook`, filesystem watchers, `.git/HEAD` watches,
browser and IDE extension callbacks. One polling loop exists — `GetLastInputInfo` at 5 s — and it is
documented in ARCHITECTURE §6 because the alternative is a keyboard hook, which is forbidden (§8). Its
measured cost is under 0.01 % CPU.

**Cheap callbacks.** OS callbacks do the minimum: read, apply rules, push to a bounded channel, return.
Redaction, enrichment and persistence all happen off the callback thread. A blocked hook callback can
stall the shell, so this is a correctness rule as much as a performance one.

**Filtering early.** Privacy and noise rules run before an event is constructed. `node_modules` during a
`pnpm install` can generate 50 000 filesystem notifications; the watcher rejects them by glob before
allocating anything.

**Coalescing.** ~6 100 raw signals/day become ~1 800 stored events (EVENT_MODEL §5) — a 3.4× reduction
before anything touches the disk.

---

## 4. Persistence

Batched writes (2 s or 100 events) in one transaction; WAL with `synchronous=NORMAL`; prepared statements
cached; one writer connection plus a read pool. FTS rows are written in the same transaction as the base
row — slightly more work per write, but it removes an entire class of index-drift bug.

Measured cost of a typical batch: under 5 ms.

---

## 5. Background jobs (§94)

All heavy work is queued (ARCHITECTURE §10), never on the capture path or the UI thread.

Scheduling rules that protect the budget:

- A bounded worker pool at below-normal thread priority.
- Heavy jobs (embeddings, summarisation, compaction) require **machine idle OR AC power** (§91).
- On battery below 30 %, only `group_activities` and `infer_context` run.
- Anything the UI is waiting on jumps the queue.
- One write transaction in flight at a time.
- Jobs are chunked so any single unit is under 500 ms and can be pre-empted.

**Embedding cost** (the largest job): ~200 activities/day, batched 32 at a time, `bge-small` on CPU at
roughly 15 ms/item — about 3 seconds of CPU per day total. Spread across idle windows, this is invisible.

---

## 6. Search

| Stage                        | Budget (p95) |
| ---------------------------- | ------------ |
| Intent + temporal resolution | < 5 ms       |
| FTS5 recall                  | < 30 ms      |
| Query embedding (local)      | < 60 ms      |
| Vector k-NN                  | < 40 ms      |
| Fusion, expansion, rerank    | < 50 ms      |
| **Total**                    | **< 200 ms** |

Achieved by keeping vectors at the activity level (~73 000/year, brute force is milliseconds — no ANN
index needed), FTS prefix indexes for incremental search, an LRU cache of recent queries invalidated on
write and on privacy-rule change, and doing all ranking in Rust against a warm page cache.

---

## 7. UI

Virtualised lists everywhere (timeline, contexts, search results); pagination at the query layer, never
"fetch all then filter"; TanStack Query caching over Tauri commands with targeted invalidation; the debug
panel compiled out of release builds; no polling in the UI — updates arrive via bus events.

The riskiest assumption is WebView2 rendering a dense timeline at scale. It is measured in Phase 2
(P2-008) at 100 k rows, deliberately early, because it is the one result that could force revisiting the
Tauri decision (ARCHITECTURE §2).

---

## 8. Memory

| Component               | Budget                               |
| ----------------------- | ------------------------------------ |
| Rust daemon, idle       | < 80 MB                              |
| SQLite page cache       | < 64 MB                              |
| Embedding model, loaded | < 120 MB (unloaded after 5 min idle) |
| WebView2, UI open       | < 200 MB                             |

The embedding model is loaded lazily and unloaded after idle — it is the single largest allocation and it
is needed for seconds a day.

---

## 9. Battery (§91)

Laptop-first. No aggressive polling; jobs deferred on battery; no animation loops when the window is
hidden; the window is fully suspended when hidden (no React renders); no network activity unless a cloud
provider is configured and a request is in flight.

Measured as a delta against a control machine over an 8-hour session.

---

## 10. Database growth (§92)

Simulated and measured from Phase 0 (P0-007), not discovered later:

| Horizon                         | Expected size |
| ------------------------------- | ------------- |
| 1 day                           | ~1.3 MB       |
| 1 week                          | ~9 MB         |
| 1 month                         | ~40 MB        |
| 1 year (no compaction)          | ~475 MB       |
| 1 year (with 90-day compaction) | ~150 MB       |

`rewind-cli simulate --days N` runs weekly in CI at the 1-month scale and fails above 60 MB/month.

---

## 11. Measurement (§89)

Local metrics, never transmitted: event throughput, coalescing ratio, DB size by table, indexing latency,
context inference latency, query latency percentiles, job queue depth and failure rate, collector health,
CPU, memory and disk for the process.

Surfaced in the debug panel (dev) and in a modest Settings → Performance view (release), because a user
who suspects the app is heavy deserves an answer rather than reassurance.

---

## 12. Regression protection

| Test                                      | Frequency       |
| ----------------------------------------- | --------------- |
| 8-hour soak with CPU/memory/disk sampling | Each phase exit |
| Filesystem storm (10 000 files)           | CI              |
| Timeline at 100 k rows                    | CI              |
| Search latency at 1-year data volume      | CI, weekly      |
| DB growth simulation                      | CI, weekly      |
| Cold start timing                         | CI              |

A performance regression beyond 20 % on any budgeted metric blocks the merge, in the same way a failing
test does.

---

## 13. Known risks

| Risk                                            | Mitigation                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Embedding jobs dominating CPU on a laptop       | Batched, low priority, idle/AC-gated, model unloaded when idle     |
| WebView2 timeline performance                   | Virtualisation; measured at 100 k rows in Phase 2                  |
| FTS index growth                                | Measured; external-content tables avoid duplicating text           |
| `VACUUM` stalls after a large deletion          | Runs on idle, with progress shown                                  |
| Filesystem watcher exhaustion on huge trees     | Bounded watch count, degrade to repo roots with a warning          |
| Windows Defender scanning the DB on every write | WAL keeps writes to one file; exclusion documented for power users |
