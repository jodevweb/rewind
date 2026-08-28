# REWIND — Test Strategy

> §123–128. What we test, why, and which failures block a release.

---

## 1. What is worth testing here

This product has an unusual test profile. There is very little conventional CRUD, and three areas where a
bug is severe:

1. **Privacy.** A leaked secret cannot be un-leaked. Tested exhaustively, blocking.
2. **Context quality.** Wrong grouping destroys the core value invisibly — nothing errors, the product
   just quietly stops being useful. Tested with golden fixtures.
3. **Answer honesty.** A confident wrong answer is worse than no answer (PR-2, §159). Tested
   adversarially.

Everything else gets ordinary, proportionate coverage.

---

## 2. Test pyramid

| Level       | Scope                                                                        | Tooling                             |
| ----------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| Unit        | Pure functions: redaction, normalisation, scoring, temporal parsing, ranking | `cargo test`, `vitest`              |
| Golden      | Fixture event sequences → expected contexts                                  | `rewind-cli replay`                 |
| Integration | Collector → pipeline → DB → query, on mocks                                  | `cargo test` with the mock OS layer |
| Evaluation  | Retrieval and answer quality, scored not asserted                            | `rewind-cli eval`                   |
| E2E         | The app, driven                                                              | WebDriver / `tauri-driver`          |
| Manual      | Real use by the team, daily                                                  | The most valuable test we have      |

---

## 3. Unit tests (§123)

**Event normalisation.** Each of the nine steps in EVENT_MODEL §4 independently: canonicalisation of
paths and URLs, coalescing windows, enrichment by longest-prefix match, importance from the §2.2 table,
`searchableText` assembly, schema validation rejecting malformed input.

**Privacy filters.** Rule precedence (`ignore` beats `redact`, user beats default, most-specific wins),
glob matching including edge cases (UNC paths, trailing separators, case-insensitivity on Windows),
domain suffix matching (`bank.com` must not match `notabank.com`).

**Secret redaction.** See §5 — its own section, because it is the highest-stakes suite.

**Context grouping.** The coherence predicate, `GAP_MAX` boundaries, hard boundaries, the six-feature
scorer per feature and combined, the recency factor, the assign/new/ambiguous decision rule, confidence.

**Search ranking.** RRF fusion, each scoring feature, the modifiers, dedup by `(contextId, targetKey)`.

**Temporal parsing.** Every expression class in SEARCH §3, with a frozen clock, across a DST transition
in both directions, across a timezone change between capture and query, and across the 04:00 work-day
cutoff. This suite is larger than it sounds and catches real bugs.

---

## 4. Golden session tests (§125)

The primary defence for context quality. Each fixture is a realistic multi-source event sequence with a
declared expected outcome.

| Fixture                  | Events | Expectation                                                 |
| ------------------------ | ------ | ----------------------------------------------------------- |
| `stripe-debug-session`   | 50     | **1** context — not 7                                       |
| `interrupted-by-slack`   | 38     | 1 context + 1 interruption span (the excursion is absorbed) |
| `two-projects-same-hour` | 64     | 2 contexts, correctly separated                             |
| `long-running-3-days`    | 210    | 1 context, 3 sessions                                       |
| `meeting-then-resume`    | 44     | 1 context, session boundary at lock                         |
| `rabbit-hole`            | 71     | 1 context, 2 sub-clusters, **no** split                     |

Assertions: context count, activity→context mapping, session boundaries, name matching a pattern, and no
duration exceeding wall-clock time.

**Determinism is a requirement.** These run Layers 1–2 only, with the Layer-3 adjudicator mocked
(TR-12). A flaky context test gets deleted, and then nothing protects the core value.

The fixtures are also a development tool: Phase 7 can be built against them before the collector phases
finish (INITIAL_ANALYSIS §6).

---

## 5. Privacy tests (§126) — blocking

### 5.1 Must never reach persistence

Every one of these, embedded in window titles, terminal commands, commit messages, URLs and file paths:

```
sk_live_51H8xVdKj2mNpQrStUvWxYz
ghp_16C7e42F292c6912E7710c838347Ae178B4a
github_pat_11ABCDEFG0abcdefghijklm_...
AKIAIOSFODNN7EXAMPLE
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
-----BEGIN RSA PRIVATE KEY-----
postgres://admin:hunter2@prod-db.internal:5432/main
STRIPE_SECRET_KEY=sk_test_4eC39HqLyjWDarjtT1zdp7dc
xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx
```

The assertion is not "the field is masked" — it is **"the raw string does not appear anywhere in the
database file"**, checked by scanning the `.db` bytes. That is the only assertion that cannot be
satisfied by a partially-correct implementation.

### 5.2 Must survive intact (TR-10)

```
a72c91f4e8b3d2a1c5e9f7b6d4a8c2e1f9b3d7a5      git SHA
550e8400-e29b-41d4-a716-446655440000          UUID
2026-08-28T14:32:11.482Z                      ISO timestamp
v2.14.3-rc.1                                  semver
```

Over-redaction destroys the evidence the product depends on, so this suite is as important as §5.1.

### 5.3 Behavioural privacy tests

| Test                 | Assertion                                                                            |
| -------------------- | ------------------------------------------------------------------------------------ |
| Excluded app         | Zero rows in `events` for that app, not "hidden" rows                                |
| Excluded domain      | Zero rows; and no partial URL in `searchable_text`                                   |
| Pause                | An event backdated into a pause interval is **rejected at ingest**                   |
| Pause across restart | Still rejected after the daemon restarts                                             |
| Fail-closed          | With redaction fault-injected, the event is **absent** from the DB                   |
| Missing stamp        | A direct insert without `redaction_version` fails                                    |
| Deletion             | The target string is absent from the raw file after delete + vacuum                  |
| AI payload           | No `private` items, no excluded sources, redaction applied, disclosure matches bytes |
| LLM output           | A model response containing a secret is redacted before persistence (PVR-1)          |
| Incognito            | An event with `incognito: true` is rejected                                          |
| No keylogger         | CI grep for hook APIs fails the build (P0-008)                                       |
| Conformance          | Rust and TS redactors produce identical output on the whole corpus                   |

### 5.4 ReDoS

Every pattern is run against pathological inputs under a 10 ms budget. The redactor is on the hot path;
a catastrophic backtrack would stall collection.

---

## 6. Integration tests (§124)

A simulated full session: fixture events from Chrome, VS Code, terminal and Git flow through the real
pipeline (mock OS layer, real privacy filter, real normaliser, real store, real context engine), then
assertions on the resulting contexts, timeline and Resume payload.

Also covered: crash injection during writes (loses ≤2 s, DB consistent, FTS intact); migration from every
prior schema version with realistic data; the ingest path over a real named pipe including duplicate ids,
oversized frames, bad tokens and rate limits; and compaction followed by causal queries — the test that
proves TR-5's contract holds.

---

## 7. Search evaluation (§127) — scored, and blocking on regression

`rewind-cli eval search` over the frozen query set (P0-006):

| Metric         | MVP target |
| -------------- | ---------- |
| Top-1 accuracy | > 50 %     |
| Top-3 accuracy | > 70 %     |
| MRR            | > 0.6      |
| p95 latency    | < 200 ms   |

Reported per intent, because an average hides that causal queries are much harder than retrieval ones. A
ranking change that regresses more than 3 points blocks the merge. The query set grows with every real
failure we hit in daily use — that is how it stays honest rather than becoming a benchmark we overfit.

---

## 8. Context quality metrics (§128)

Measured on golden fixtures in CI, and on real usage in the local metrics panel:

| Metric                   | Target           | Meaning                                      |
| ------------------------ | ---------------- | -------------------------------------------- |
| False-merge rate         | < 10 %           | Unrelated work pulled into one context       |
| False-split rate         | < 15 %           | One task fragmented                          |
| Manual corrections / day | < 1 after week 1 | The tolerance threshold before users give up |
| Ambiguous-band rate      | < 15 %           | How often the engine is unsure               |
| Mean confidence          | > 0.7            |                                              |

Real-usage numbers come from the user's own corrections, computed locally, never transmitted.

---

## 9. Adversarial answer tests — blocking

Questions about work that never happened:

```
"Why did I add Redis caching?"           (never used Redis)
"What did I do on 3 January?"            (before install)
"Find the Kubernetes docs I read."       (never read any)
"Who did I pair with on the auth bug?"   (no person data exists at all)
```

Required behaviour: refusal with closest matches (SEARCH §7.3), never an invented answer. Also asserted:
every citation resolves to real evidence that was in the input; a response with fabricated evidence IDs is
rejected before display.

A fabricated answer is a release-blocking bug, not a quality issue.

---

## 10. E2E and manual

**E2E:** onboarding through to first context; pause and resume reflected in the tray; Resume opening real
resources; delete-everything leaving a clean state.

**Manual, daily:** the team uses REWIND to build REWIND. That surfaces what no fixture can — whether the
timeline is _pleasant_, whether Resume is _actually enough_, whether corrections are _tolerable_. The
§112 test is run with a stopwatch at each phase exit from Phase 9 on.

---

## 11. Release gates

A release is blocked by any of:

- Any privacy test failing (§5).
- Any golden session test failing (§4).
- Search evaluation regressing more than 3 points (§7).
- Any adversarial answer test failing (§9).
- The forbidden-API check failing (P0-008).
- A budgeted performance metric regressing more than 20 % (PERFORMANCE §12).
- A migration test failing from any prior version.

Everything else can ship with a known issue. These cannot, because each one damages something the product
cannot recover: the user's secrets, the user's trust, or the user's memory.
