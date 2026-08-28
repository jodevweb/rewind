# REWIND — Initial Analysis

> STEP 1 deliverable (§150). This document critiques the specification before any product decision is
> frozen. It records risks, contradictions, and the choices I am making — none of them silently.
>
> Status: draft 1 · Date: 2026-08-28

---

## 0. Summary

The specification is unusually coherent for a product of this size. Its strongest ideas are the ones
most projects in this space get wrong:

1. **Event-first, not screenshot-first** (§9, §111, §154). This is the real differentiator.
2. **Privacy as a product surface, not a policy page** (§6, §7, §110, §157).
3. **Context as the unit of value, not the event** (§4, §24).
4. **Evidence over eloquence** (§54, §79, §159).

The weaknesses are not in the vision but in the places where the spec asks for two things that cannot
both be true at once. Those are listed in section 3 and each has a proposed resolution. None are
fatal. All get more expensive the later they are decided.

The single highest-risk assumption is **PR-1**: that structured events alone carry enough signal to
reconstruct context. That is _very likely true for developers_ and _probably false for everyone else_.
The MVP should be honest about this.

---

## 1. Product risks

### PR-1 — The event-first bet only pays off for developer work (HIGH)

§2 states REWIND is "pas un outil uniquement destiné aux développeurs". §103 then lists the MVP
collectors: IDE, Git, terminal, browser. Those are developer tools. Every worked example in the spec
(Stripe webhook, `pnpm test`, PR #2182) is a developer example.

This is not an accident of the writing, it is structural. Event-first memory works when the user's
work _emits structured events_. A developer emits a commit, a branch, a file save, a test exit code.
A product manager working in Figma, Notion and Slack emits: window title changed, URL changed. That is
roughly the same signal as browser history, which §2 explicitly says REWIND is not.

Competitors (Rewind.ai, Limitless) went screenshot + OCR precisely because it is the only modality that
generalises across professions. Choosing event-first is choosing depth over breadth.

**Recommendation.** Make it explicit rather than accidental: _the MVP persona is the developer_. Say so
in PRODUCT.md. Non-developer support is a v2 question that likely needs a different capture modality
(possibly the screenshots the spec defers). Do not let "for everyone" quietly justify adding
screenshots back at MVP — that would erase the differentiation §111 is protecting.

### PR-2 — A wrong Resume card is worse than no Resume card (HIGH)

The product's value rests entirely on trust. §112 defines success as "resume in under 30 seconds". But
a Resume card that confidently states the wrong last hypothesis costs _more_ than 30 seconds — it costs
the time, plus the correction, plus the user's confidence in the tool. Memory products die from one bad
recall, not from missing recall.

**Recommendation.** Resume must degrade visibly, in three tiers:

- **Facts** (files, commands, exit codes, commits, URLs) — never generated, always true, always shown.
- **Inference** (these events are one context; the likely next step) — shown with confidence and
  attached evidence.
- **Narrative** (LLM prose) — optional, last, clearly marked as derived.

The MVP Resume card must be _useful with the LLM turned off entirely_. If the deterministic tier alone
does not get the user back to work, the product does not work, and no amount of LLM fixes it (§154–155).

### PR-3 — Cold start (MEDIUM)

Context inference needs days of history before it is good. On day 1 the app shows a timeline that is a
worse version of the user's own memory. First real value lands around day 3; the "Why does this exist?"
moment (§114) is _months_ away.

**Recommendation.** Onboarding sets a horizon expectation ("REWIND gets useful after about a week"),
and day-1 value comes from the timeline being pleasant to read on its own (§144). A one-time consented
backfill (git log of detected repos, browser history) would populate day 1 — but it is a privacy
tradeoff, so it is ambiguity **A-9**, not an assumption.

### PR-4 — The name is taken (MEDIUM, non-technical, cheap now)

`rewind.ai` is an established product in _exactly this category_. The spec calls the name provisional.
Building brand, domain and a Chrome Web Store listing under it creates rework and a plausible trademark
conflict.

**Recommendation.** Treat REWIND as the internal codename. Internal namespaces (`@rewind/*`) are fine.
Defer public naming until just before Chrome Web Store submission — the first irreversible public use.

### PR-5 — Duration tracking is one product decision away from bossware (MEDIUM)

§140 and §141 forbid productivity scores and employee surveillance. §71 shows a daily summary with
per-context durations. That is the same data. The guardrail is framing and the absence of aggregation.

**Recommendation.** Bake it into the design system: durations are _descriptive_ ("1h 42m on Stripe
renewal"), never _evaluative_ — no targets, comparisons to yesterday, streaks, percentages of a day, or
focus scores. And no cross-user aggregation exists in the schema at all: there is no `userId` column to
group by. That is the strongest available guarantee, free today and expensive later.

### PR-6 — "Open Context" is a promise the OS may not keep (MEDIUM)

§61/§107 promise reopening workspace, files, terminal, URLs. Each is a per-app, per-OS integration with
failure modes: IDE not installed, URL now 404, repo moved, branch deleted. A Resume button that
half-works reads as broken.

**Recommendation.** Every restore target carries a _liveness check_ before being offered. Show what can
be restored, grey out what cannot, never fail silently. Restore is per-resource with a checkbox — §63
already says this for URLs; generalise it to all four target types.

---

## 2. Technical risks

### TR-1 — Toolchain prerequisites are missing (LOW severity, BLOCKING today)

Verified on this machine: `node v24.13.0` OK, `pnpm 10.29.2` OK, `cargo`/`rustc` **absent**, MSVC Build
Tools **absent**. Tauri v2 on Windows needs the Rust MSVC toolchain, the VS C++ Build Tools, and
WebView2 (already present on Windows 11). This is ticket **P1-000**, before any Rust is written.

### TR-2 — Target OS: the spec says macOS, the machine is Windows 11 (HIGH — needs your decision)

§102 says "commencer par macOS **ou OS principal de développement si différent**". The primary dev OS
here is Windows 11 (10.0.26200). I am proceeding **Windows-first** on that clause, flagged as **A-1**.

| Concern       | Windows                                                                               | macOS                                                                         |
| ------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Active window | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` — truly event-driven, no permission prompt | `NSWorkspace` notifications; window _titles_ require Accessibility permission |
| Idle          | `GetLastInputInfo` (cheap poll)                                                       | `CGEventSourceSecondsSinceLastEventType` (also poll)                          |
| Lock / unlock | `WTSRegisterSessionNotification`                                                      | `NSDistributedNotificationCenter`                                             |
| Sleep / wake  | `WM_POWERBROADCAST`                                                                   | `NSWorkspace` sleep notifications                                             |
| Prior art     | thin                                                                                  | most local-first / Tauri examples are mac-centric                             |
| Permission UX | none needed for titles                                                                | Accessibility prompt — a real onboarding drop-off                             |

Windows is _technically easier_ (no accessibility wall) and _ecosystically harder_ (less prior art).
Both viable; cost of flipping later is roughly two weeks.

**Recommendation.** Windows-first, with every OS touchpoint behind a Rust trait (`WindowWatcher`,
`IdleWatcher`, `SessionWatcher`, `PowerWatcher`) so macOS is a new module rather than a refactor.

### TR-3 — Window titles are the highest-volume PII channel in the product (HIGH)

The spec treats titles as benign metadata (§8, §11, §21). They are not. Real titles from ordinary work:

```
Reset your password — 1Password
Invoice #4471 — Marie Dubois — Stripe Dashboard
Re: layoffs — confidential — Gmail
psql — postgres://user:hunter2@prod-db:5432
```

Titles routinely carry customer names, document names, ticket subjects, occasionally credentials. A
product that says "we never keylog" (§8) while storing every window title forever has drawn a
distinction the user does not feel.

**Recommendation.** Titles pass through the same redaction pipeline as terminal commands, _before_
persistence. Exclusion rules match on title (§81 allows this). Titles default to
`privacyLevel: sensitive` for any app not on a known-safe developer-tool allowlist.

### TR-4 — The local ingest endpoint is an unauthenticated attack surface (HIGH, security)

The Chrome and VS Code extensions must deliver events to the desktop app; the obvious route is HTTP on
`127.0.0.1:PORT`. Unauthenticated, **any web page the user visits can POST forged events into their
memory — or read it back out**. `localhost` is not a security boundary in a browser, and DNS rebinding
defeats naive origin checks.

**Recommendation** (detailed in SECURITY.md): bind `127.0.0.1` only; per-install token held in the OS
keychain and handed to extensions through an explicit pairing flow; require the token on every request;
validate `Origin` and reject unexpected `Host` values (anti-rebinding); CORS limited to the extension
origin. Critically, **the ingest API is write-only** — no read endpoint exists, so even a leaked token
cannot exfiltrate memory.

### TR-5 — Retention (§39) contradicts the six-month "Why?" use case (§114, §137) (HIGH)

Raw events are deleted after 30 days; "why does this code exist?" is asked six months later. After
compaction (§40) the answer can only come from derived records. If compaction is lossy in the wrong
way, the flagship long-horizon feature degrades silently.

**Recommendation.** Compaction is **evidence-preserving**. When raw events are dropped, the _citable
identifiers_ survive indefinitely on the context record: commit SHAs, file paths, URLs, ticket IDs,
command strings, timestamps. Those are bytes, not kilobytes, and they are exactly what §54 needs to
cite sources. What is dropped is high-cardinality chaff: focus churn, intermediate saves. Contract in
STORAGE.md.

### TR-6 — Local embeddings conflict with the CPU and size budget (MEDIUM)

§33 wants local embeddings by default; §90 wants <2 % average CPU; §43 chose Tauri for a light
footprint. A local model (e.g. `bge-small-en-v1.5`, 384-dim) plus an ONNX runtime adds ~120 MB and real
CPU during indexing.

**Recommendation.** Embed **activities and contexts only, never raw events** (~200/day instead of
~5 000/day), in the background job queue (§94), batched, at low thread priority, suspended on low
battery (§91). The model downloads on first use rather than shipping in the bundle. FTS5 works from day
one with no model at all.

### TR-7 — Vector search adds operational risk for uncertain MVP gain (MEDIUM)

§38 lists sqlite-vec / LanceDB / libSQL. Loading a SQLite extension inside a rusqlite/Tauri build on
Windows is a real (solvable) packaging exercise.

**Recommendation.** `sqlite-vec`, statically linked into the rusqlite build — one file, one database,
no service, which is precisely the "simplicité opérationnelle" §38 asks for. But architect
`SearchIndex` so the vector stage is _optional_: if unavailable, search degrades to FTS5 + heuristics
and logs the degradation. Ship Phase 8 with FTS5 first, add vectors second, and measure against the
§127 metrics before treating them as essential.

### TR-8 — Time is harder than it looks (MEDIUM)

"Last Friday", "before lunch", "yesterday afternoon" (§59) break under timezone changes while
travelling, DST transitions, and sessions crossing midnight — a 01:30 commit belongs to _Tuesday's_
work, not Wednesday's.

**Recommendation.** Store `timestampUtc` (epoch ms) **and** `tzOffsetMinutes` captured at write time.
Resolve natural-language time in the user's local calendar _at the time of the events_, not at query
time. Introduce a "work day" with a configurable cutoff (default 04:00 local). Unit-test heavily (§123).

### TR-9 — Secret redaction on the hot path must fail closed (HIGH, security)

The redactor sits between collection and persistence. If it throws, the naive behaviour is log-and-
continue, which persists the _unredacted_ event — the exact failure the design exists to prevent.

**Recommendation.** `redact()` is total and cannot throw. Persistence refuses any event lacking a
redaction-pass stamp. On redactor error the event is **dropped**, not stored. Explicitly tested (§126).

### TR-10 — Generic high-entropy detection will eat the data we want (MEDIUM)

§80 asks for "generic high entropy strings". Git SHAs, content hashes, UUIDs and base64 blobs are all
high-entropy — and commit SHAs are _primary evidence_ we must keep (§54).

**Recommendation.** Entropy detection runs last, only on tokens unmatched by named patterns, with an
explicit allow-shape list (40-hex git SHA, UUID, ISO timestamps, semver) and a length window. Measured
for false-positive rate against a fixture corpus before it is enabled.

### TR-11 — MV3 service workers are evicted (LOW, causes silent data loss)

Chrome MV3 background workers terminate after ~30 s idle; an extension holding a connection to the
desktop app loses it constantly.

**Recommendation.** Buffer in `chrome.storage.session`, flush on a `chrome.alarms` heartbeat and on
every tab event, and make ingest idempotent via a client-generated event `id`. Never assume the worker
is alive.

### TR-12 — LLM-in-the-loop breaks the golden-session tests (MEDIUM)

§125 requires deterministic expectations ("1 context, not 7"); §26 Layer 3 puts an LLM in the
clustering path. Non-determinism makes those tests flaky, and flaky tests get deleted.

**Recommendation.** Layer 3 sits behind an interface with a deterministic mock. Golden-session tests run
Layers 1–2 and assert on those. A separate, non-blocking eval suite exercises Layer 3 against recorded
fixtures.

### TR-13 — Event volume and database growth (LOW, but measure early per §92)

Back-of-envelope, one active developer day:

| Source           | Raw/day    | After coalescing | Bytes/event | Bytes/day   |
| ---------------- | ---------- | ---------------- | ----------- | ----------- |
| Window focus     | ~1 500     | ~600             | ~250        | 150 KB      |
| Browser nav/tabs | ~800       | ~400             | ~400        | 160 KB      |
| Filesystem       | ~3 000     | ~250             | ~200        | 50 KB       |
| IDE              | ~600       | ~300             | ~250        | 75 KB       |
| Terminal         | ~200       | ~200             | ~300        | 60 KB       |
| Git              | ~40        | ~40              | ~400        | 16 KB       |
| **Total**        | **~6 100** | **~1 800**       |             | **~510 KB** |

With the FTS index (~1.5×) and activity-level embeddings (~200/day × 384 × 4 B ≈ 300 KB), estimate
**~1.5 MB/day → ~40 MB/month → ~0.5 GB/year** before compaction. Comfortable.

For contrast: screenshots at even one per minute at 100 KB would be **48 MB/day** — about 30× the
entire event corpus. That number alone justifies §111.

These are estimates; ticket **P0-008** builds the measurement harness so we track reality.

---

## 3. Contradictions in the specification

| #   | Tension                                                                                    | Proposed resolution                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | "Not only for developers" (§2) vs. an all-developer MVP collector set (§103)               | MVP is explicitly developer-first, stated as a scope boundary rather than a silent narrowing                                                                                                                                                |
| C-2 | Raw events deleted at 30 days (§39) vs. "why does this exist?" months later (§114)         | Evidence-preserving compaction (TR-5); citable identifiers are never removed by retention, only by explicit deletion (§99)                                                                                                                  |
| C-3 | Local embeddings by default (§33) vs. <2 % CPU and light footprint (§43, §90)              | Embed activities/contexts only, throttled background queue, model fetched on demand; FTS-only is a supported mode                                                                                                                           |
| C-4 | Encryption at rest (§42) vs. FTS5 + vector extensions                                      | v1 encrypts _secrets_ (OS keychain) and the screenshot store if ever enabled, and relies on OS full-disk encryption for the DB. PRIVACY.md says this plainly instead of implying the DB is encrypted. SQLCipher is a tracked later decision |
| C-5 | No productivity metrics (§140) vs. duration-centric summaries (§71)                        | Durations descriptive only; no scores, targets, comparisons or streaks; no cross-user schema                                                                                                                                                |
| C-6 | "Never capture keystrokes" (§8) vs. capturing every window title (§11)                     | Titles are sensitive by default, redacted and excludable (TR-3)                                                                                                                                                                             |
| C-7 | Tray + hotkey + always-visible recording state (§84–86) vs. "invisible until useful" (§28) | The _indicator_ is always visible; _interruptions_ are near-zero — notifications only for §73 interruption recovery, at most once per resumption                                                                                            |

---

## 4. Privacy risks

### PVR-1 — Derived summaries can resurrect redacted content (HIGH)

Raw events are redacted; summaries are generated _from_ events and kept **forever** (§39). Two leaks
follow: an LLM can paraphrase a sensitive fact into a longer-lived record, and a summary of an
excluded-app session can describe what happened inside it.

**Mitigation.** Redaction runs on LLM _output_ before persistence, not only on input. Events with
`privacyLevel: private` never enter a summarisation prompt, and their existence is not described.

### PVR-2 — Pause must be enforced at more than one point (HIGH)

§7 requires that during Pause **no event is captured**, not masked afterwards. But the Chrome extension
may be asleep (TR-11) or briefly out of sync with pause state.

**Mitigation.** Three enforcement points: collectors stop at the source; the ingest endpoint rejects any
event whose timestamp falls inside a recorded pause interval; pause intervals are persisted so a
late-arriving buffered event is still dropped. The second point is what makes this a guarantee rather
than best effort.

### PVR-3 — Third-party data (MEDIUM)

Titles and URLs necessarily capture information about other people. The user is the controller of their
own machine, which is the defensible position — but only if deletion and export are genuinely complete
(§98, §99).

**Mitigation.** Deletion is physical: `DELETE` + `VACUUM` + FTS/vector index rebuild + file unlink,
never a soft flag. A deletion that leaves rows behind is a lie; it is tested as such.

### PVR-4 — Incognito / private browsing (MEDIUM)

Chrome extensions do not run in incognito unless the user enables it. That is a free, strong guarantee
— provided we never ask them to turn it on.

**Mitigation.** Never request incognito access; state it as a guarantee in PRIVACY.md and onboarding.

### PVR-5 — The §35 AI disclosure is where trust is won or lost (MEDIUM)

"This request will send X items to provider Y" must be exact, or it is worse than nothing.

**Mitigation.** The disclosure is generated from the _actual serialised payload_, shows item and
redaction counts, and offers an expandable exact-payload view. Cloud AI is off by default.

### PVR-6 — Agent collectors read the most sensitive files on the machine (MEDIUM)

§20 proposes collecting from Claude Code / Codex / Gemini CLI sessions. Those transcripts routinely
contain source code, pasted secrets and whole file contents.

**Mitigation.** Agent collectors capture **metadata only** at MVP: session start/end, project path, tool
counts, model name. No prompt text, no completions. Content capture, if ever, is separately opt-in per
tool with its own disclosure.

---

## 5. Ambiguities — all resolved

These were recorded rather than silently assumed (§150: _ne change pas silencieusement le produit_).
All ten have now been decided. **ADR 0001 is the authority**; this table is the index.

| #    | Question             | Decision                                                                                                                                    |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1  | MVP OS               | **Windows 11 first**, with seven named OS abstractions; the domain layer stays platform-agnostic (ADR 0001 D-1)                             |
| A-2  | Developer-only MVP?  | **Yes.** Developer-first is settled, not a boundary under discussion (D-7)                                                                  |
| A-3  | Cloud AI by default? | **No.** No provider configured at first run                                                                                                 |
| A-4  | Raw-event retention  | **90 days**, configurable, with separate long-term policy for derived memory (D-6)                                                          |
| A-5  | Public name          | **Codename only.** No branding work; the name resolves through one central constant (D-2)                                                   |
| A-6  | Multi-machine sync   | **Out of scope**                                                                                                                            |
| A-7  | Ask multi-turn?      | **Single-turn**                                                                                                                             |
| A-8  | Full terminal stdout | **Off by default**; error tail on non-zero exit only                                                                                        |
| A-9  | Backfill at install  | **No automatic backfill.** Later opt-in onboarding step, both options off by default; **Git history first**, browser history deferred (D-3) |
| A-10 | Screenshots at MVP   | **None**                                                                                                                                    |

Two decisions extend beyond the original questions and are recorded in ADR 0001:

- **D-8** — AI coding agents are a first-class context source architecturally. Not in the first
  vertical slice, but the schema, the link types and the model must never foreclose it.
- **D-9** — the first milestone is _golden session → events → contexts → Resume_, not "Tauri starts".
  The Fake Collector built for it is a permanent component.

## 6. One amendment to the phase order

§115's phases are sound. My amendment: **pull a thin vertical slice earlier**. Build Phases 1–2 for
real, then _fake_ Phases 3–6 with a fixture injector, so the Context Engine (Phase 7) and Resume
(Phase 9) can be built and evaluated against realistic data before four extension integrations exist.

Otherwise the hardest, most uncertain question in the product — _does context inference actually work?_
— is answered last, which is backwards. Concretely, the §125 golden-session fixtures become a
development tool, not only a test asset: ticket **P0-007**, built in Phase 0.

Ordering after that follows §115 unchanged.

---

## 7. What would make me say this product does not work

Written down now, while honesty is cheap:

- Resume cards are right less than ~80 % of the time after two weeks of data.
- Context detection needs manual correction more than about once a day (§128).
- The deterministic tier is not useful without an LLM — meaning the product is an LLM wrapper over a
  noisy log, which is §154's explicit failure mode.
- Idle CPU cannot be held near 2 % (§90) without disabling collectors.
- Users pause it and forget to resume, because the value is not felt daily.

Each has a metric in TESTING.md and PERFORMANCE.md, checked at the end of every phase — not at the end
of the project.
