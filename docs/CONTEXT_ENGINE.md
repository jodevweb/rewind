# REWIND — Context Engine

> STEP 6 deliverable (§150). The algorithm that turns events into "what you were working on".
> This is the hardest and most valuable part of the product. Everything here is deterministic and
> testable unless explicitly marked as Layer 3.

---

## 1. What it must produce

```
TimelineEvents → Activities → Sessions → Contexts → Decisions / Outcomes
```

Two orthogonal notions, deliberately kept separate:

- **Session** bounds _time_: a continuous stretch of work, ended by idle, lock, sleep, or a day cutoff.
- **Context** bounds _meaning_: one thing you were working on, which may span weeks and many sessions.

A session can hold several contexts (you switched tasks over lunch). A context spans many sessions (the
Stripe bug took three days). Conflating them is the most common way products like this get it wrong.

---

## 2. Stage A — Activity grouping

Cheap, deterministic, runs within seconds of events arriving.

### Algorithm

```
for each new event e, in timestamp order:
    a = current open activity
    if a is null: open new activity with e; continue

    if hard_boundary(e):                 # lock, sleep, idle.start, capture.paused
        close a; open new activity; continue

    if e.timestamp - a.endTimestamp > GAP_MAX:     # 90 s
        close a; open new activity with e; continue

    # NOT a project/repository boundary (ADR 0002 D-12, D-15): most work has no project at all,
    # and Slack → Linear → Figma is frequently one activity. A conflicting *anchor* is the boundary.
    if e.anchors and a.anchors and disjoint_and_confident(e.anchors, a.anchors):
        close a; open new activity with e; continue

    if coherent(e, a): extend a with e
    else:              close a; open new activity with e
```

`coherent(e, a)` is true when any holds: a shared anchor (§4.0); same app; same file or same directory; same repository; the
event's URL host already appears in `a`; the event is a terminal command whose `cwd` is inside `a`'s
repository. Otherwise the event starts a new activity — activities are cheap, and over-splitting here is
corrected at Stage C.

### Constants (tunable, all in `config.contextEngine`)

| Constant                | Default | Rationale                                                        |
| ----------------------- | ------- | ---------------------------------------------------------------- |
| `GAP_MAX`               | 90 s    | Longer than reading a paragraph, shorter than a real task switch |
| `ACTIVITY_MAX_DURATION` | 20 min  | Forces a boundary so long sessions get labelled granularly       |
| `ACTIVITY_MIN_EVENTS`   | 1       | A single commit is a legitimate activity                         |

### Labelling

Deterministic template, chosen by the dominant source in the activity:

| Dominant source | Label                                               |
| --------------- | --------------------------------------------------- |
| `ide`           | `Editing {basename}` / `Editing {n} files in {dir}` |
| `terminal`      | `Running {commandHead}` (`pnpm test stripe`)        |
| `git`           | `Committed to {branch}`                             |
| `browser`       | `Reading {host}{firstPathSegment}`                  |
| `system`        | `Using {appDisplay}`                                |

No LLM. Labels are shown in the timeline and must be instant, stable and boring.

---

## 3. Stage B — Sessionisation

```
close the current session when any of:
    idle duration          > IDLE_THRESHOLD          (15 min)
    system.session.lock
    system.power.sleep
    local clock crosses    DAY_CUTOFF                (04:00 local)
    sustained anchor switch: a disjoint, confident anchor set held for > ANCHOR_SWITCH_HOLD (10 min)
```

Idle time is subtracted from every duration the product ever shows (§69). A session's
`totalActiveMs` excludes idle by construction, so no duration in the UI can ever be inflated by a
lunch break.

The `ANCHOR_SWITCH_HOLD` rule is what stops a two-minute glance at another subject from shattering the
session (§27). It replaces the earlier project-switch rule, which assumed every piece of work has a
repository — false for most of the day (ADR 0002 D-12).

---

## 4. Stage C — Context assignment

The core of the product. For each newly closed activity, decide: does this belong to an existing
context, or start a new one?

### 4.1 Candidate set

Contexts that are `active` or `dormant`, touched within `CANDIDATE_WINDOW` (default 14 days), capped at
50 by recency. A manually started context (§29) is always a candidate and gets a fixed bonus.

### 4.0 Context Anchors — the primary signal (ADR 0002 D-14)

An anchor is a distinctive identifier that recurs across applications:

```ts
interface ContextAnchor {
  type: 'issue' | 'project' | 'repository' | 'branch' | 'worktree' | 'document' | 'url' | 'keyword';
  value: string; // "ACM-4218"
  normalizedValue: string; // "acm-4218"
  confidence: number; // 0..1
  source: 'window_title' | 'url' | 'branch' | 'agent' | 'external' | 'note' | 'path';
}
```

Extracted from window titles, browser titles, URLs, terminal commands, Git branches, worktrees, Claude
Code sessions and external events. Structured identifiers score highest — `ACM-4218` appearing in a
Linear window, a Git branch, a Cockpit mission and a URL is close to proof of one context. Project and
document names are next. Repeated distinctive keywords are weakest and need corroboration.

Anchors influence grouping strongly; they are never absolute rules.

**Why this replaced the old feature set.** The previous vector was 76 % developer-specific — ticket
0.28, branch 0.18, files 0.16, repository 0.14. On GS-09, pure administrative work, _none_ of those
fire. Anchors generalise the ticket feature that was already the strongest one, and subsume branch,
repository, files and project as anchor _types_ rather than separate dimensions.

### 4.2 Feature vector

Each feature is normalised to `0..1`:

| Feature        | Computation                                                                                | Weight   |
| -------------- | ------------------------------------------------------------------------------------------ | -------- |
| `anchorStrong` | A high-confidence anchor is shared — issue id, worktree, branch, repository, document name | **0.34** |
| `anchorWeak`   | Weighted overlap of the remaining anchors — project names, URL hosts, recurring keywords   | **0.16** |
| `semantic`     | Cosine similarity, activity embedding vs. context centroid embedding                       | **0.20** |
| `resources`    | Jaccard similarity of touched resources — files, URLs, documents, directories              | **0.16** |
| `temporal`     | Interleaving density with the context’s existing activities                                | **0.08** |
| `app`          | Application-sequence affinity — a weak prior, never a boundary (D-15)                      | **0.06** |

```
raw     = Σ (weight_i × feature_i)
recency = exp(-Δt / τ)                     # τ = 3 days; Δt = now - context.lastActiveAt
score   = raw × (0.4 + 0.6 × recency)      # an old but perfectly matching context still competes
```

Note the shape of these weights (ADR 0002 D-14, D-15). No single feature exceeds a third, and the
application contributes **6 %** — deliberately far too little to segment on. Anchors carry the most
because a distinctive identifier recurring across applications is the closest thing to a human
statement of "this is one piece of work", and unlike a ticket ID it exists for administrative and
design work too. `semantic` stays modest at 0.20: embeddings of short strings — window titles,
file names, commands — are noisy, and over-trusting them is how unrelated work gets merged.

The fixture that enforces this balance is GS-08: two projects interleaved in short slices, sharing
every application, where only anchors separate them. Every naive baseline scores under 66 % pairwise
F1 there, with an Adjusted Rand Index near zero.

### 4.3 Decision rule

```
best, second = top two candidates by score

if best.score >= ASSIGN_THRESHOLD (0.55) and (best.score - second.score) >= MARGIN (0.10):
    assign to best                          # confidence: high
elif best.score < NEW_THRESHOLD (0.35):
    create a new context                    # confidence: high (clearly unrelated)
else:
    AMBIGUOUS →
        if Layer 3 enabled:  ask the LLM to adjudicate (§4.5)
        else:                assign to best, confidence: low, flag for review
```

Ambiguous cases are surfaced quietly in the Contexts view as "Is this the same work?" — never as an
interrupting prompt (§28).

### 4.4 Layer 2 — semantic detail

Embeddings are computed on **activities and contexts only**, never raw events (TR-6). The text embedded
for an activity is a compact, structured string rather than a prose blob:

```
repo:myapp branch:feature/auth files:auth.ts,session.ts
cmd:pnpm test auth urls:better-auth.com/docs/session
title:auth.ts - myapp - Visual Studio Code
```

A context's centroid is the importance-weighted mean of its activity embeddings, recomputed
incrementally on each assignment and fully every 50 assignments to avoid drift.

### 4.5 Layer 3 — LLM adjudication (rare, optional, off by default)

Invoked **only** in the ambiguous band, at most once per activity, batched, and only if a provider is
configured. Input: the activity summary and the top three candidate contexts, as structured facts —
never raw events. Output is schema-validated (§132):

```json
{ "decision": "existing" | "new", "contextId": "…|null",
  "confidence": "high" | "medium" | "low", "reason": "…" }
```

Behind `trait ContextAdjudicator` with a deterministic mock, so golden-session tests never depend on it
(TR-12). If it is unavailable, times out, or returns an invalid response, the engine falls back to the
Layer-2 result — it never blocks and never retries in the foreground.

---

## 5. Context naming

Deterministic first, in priority order:

1. Ticket ID + its title if we ever saw one: `ACM-3921 — Stripe renewal`
2. Branch name, humanised: `feature/stripe-renewal` → `Stripe renewal`
3. Dominant directory or file cluster: `Auth — session handling`
4. Dominant external host + repo: `Stripe docs — myapp`
5. Fallback: `Work in {repo} — {date}`

An LLM, if configured, may _propose_ a better name once a context has ≥5 activities. The proposal
replaces the deterministic name only if the user accepts it, or silently if the deterministic name was
the level-5 fallback. Users can always rename; a user-set name is never overwritten.

---

## 6. Context splitting and interruptions (§27)

### Short excursions are absorbed

An excursion is a run of activities with a different project/repo, lasting under
`EXCURSION_MAX` (5 min), followed by a return to the same context. It is recorded as an
`interruption` span _inside_ the context (useful for §139 later) and does not break it. Slack, email and
a quick browser detour all fall here.

### Sustained switches split

Different repository, held longer than `PROJECT_SWITCH_HOLD` (10 min) → new context.

### Retroactive split proposals

A nightly job examines each context with ≥8 activities and proposes a split when **all** hold:

- activity embeddings form two clusters with centroid cosine distance > 0.45 (2-means, k=2);
- the clusters' file sets are disjoint (Jaccard < 0.1);
- the clusters are separated in time by more than 4 hours of active work;
- neither cluster shares a ticket ID with the other.

All four conditions are required because any one alone produces false splits. Proposals are shown in the
Contexts view, never applied automatically.

### Merge proposals

Two dormant contexts are proposed for merge when they share a ticket ID, **or** share a branch and have
file Jaccard > 0.4. Also never automatic.

---

## 7. Manual control (§29, §30, §31)

| Action                                                    | Effect                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start Context** ("I'm working on Checkout Redesign V2") | Creates a context with `origin: manual`; it receives a +0.15 score bonus for `MANUAL_PRIORITY_WINDOW` (2 h) and absorbs new activities by default |
| **Merge**                                                 | Union of activities, links, sessions; keeps the older `createdAt` and the preferred name; records a feedback rule                                 |
| **Split**                                                 | User picks a boundary activity or selects activities; two contexts result, links redistributed by evidence; records a feedback rule               |
| **Rename**                                                | Sets `nameLocked`; nothing overwrites it                                                                                                          |
| **Move activity**                                         | Reassigns one activity; records a feedback rule                                                                                                   |

Manual assignments are **immutable by the engine**. An activity the user moved is never moved back.

---

## 8. Feedback loop (§32) — rules, not training

No ML training in the MVP. Corrections become rows in `context_rules`:

```ts
interface ContextRule {
  id: string;
  kind: 'affinity' | 'repulsion';
  keyA: string; // "repo:myapp", "file:src/auth.ts", "host:stripe.com", "branch:feature/auth"
  keyB: string;
  delta: number; // ±0.05 per correction, saturating at ±0.20
  createdFrom: 'merge' | 'split' | 'move';
  occurrences: number;
}
```

Applied as an additive adjustment to `raw` before the recency factor. Effects:

- Merging two contexts creates affinity rules between their distinctive keys — next time those keys
  co-occur, they group.
- Splitting creates repulsion rules — the engine stops merging that pair.

Bounded, inspectable and reversible: Settings shows every learned rule with a "forget" button. A user
can see exactly why the engine grouped something, which is the same transparency standard §54 demands
of answers.

---

## 9. Confidence (§74, §78)

```
confidence = clamp01( 0.5 × normalise(score)
                    + 0.3 × normalise(evidenceCount, cap 10)
                    + 0.2 × sourceDiversity )        # distinct sources / 5
```

then `× 0.7` if the assignment came from the ambiguous band, and forced to `1.0` for manual origin.

Surfaced as words, not decimals: **high** ≥0.75, **medium** 0.5–0.75, **low** <0.5. The raw number
appears only in the debug panel (§74 — no artificial precision in the product UI).

---

## 10. Current-context detection (§28, §73)

The active context is the context of the most recent activity, provided the last event is under
`ACTIVE_RECENCY` (10 min) old and confidence is at least medium. Otherwise there is no active context,
and the UI says nothing rather than guessing.

**Interruption recovery** (§73): on return from idle/lock/sleep longer than `RESUME_PROMPT_THRESHOLD`
(25 min), the tray offers one unobtrusive resume affordance for the last active context. At most once
per return. Never a modal, never a sound.

---

## 11. Resume payload (§60, §106)

Assembled deterministically from stored facts, in this order — every field optional, every field cited:

```
What you were doing     context name, last active time, total active time
What you were editing    top files by link weight, most recent first
What you were reading    top URLs by dwell and importance
What you ran             last commands, with exit codes
What failed              most recent non-zero exit and its error tail
What you produced        commits, branches, PR URLs seen
Where you left off       last activity label + timestamp
Likely next step         see below
Open resources           workspace, files, URLs, terminal cwd (with liveness checks)
```

**Likely next step** is deterministic first, and honest about it:

| Trigger                                  | Suggestion                          |
| ---------------------------------------- | ----------------------------------- |
| Last command failed                      | `Fix the failing test: {command}`   |
| Uncommitted changes in a tracked repo    | `Commit or stash {n} changed files` |
| IDE diagnostics present at close         | `Resolve {n} errors in {file}`      |
| Branch ahead of remote                   | `Push {branch}`                     |
| A manual note ends in a question or TODO | Quote the note                      |
| None of the above                        | Omit the field entirely             |

An LLM, when configured, may add a prose paragraph _above_ these facts. The facts never come from the
LLM (PR-2).

---

## 12. Scheduling

| Job                   | Trigger                                             | Latency target  |
| --------------------- | --------------------------------------------------- | --------------- |
| `group_activities`    | 5 s after the last event in a burst                 | < 1 s           |
| `close_session`       | On boundary event or idle timer                     | immediate       |
| `infer_context`       | On activity close                                   | < 2 s           |
| `embed_batch`         | Every 60 s, or 20 pending activities                | background      |
| `summarise_context`   | On context dormancy (30 min inactive), or on demand | background      |
| `propose_split_merge` | Nightly, machine idle                               | background      |
| `daily_summary`       | First app open of a new work day                    | < 500 ms cached |

Everything except `infer_context` may be deferred under battery or load pressure (§91).

---

## 13. Failure modes and how each is handled

| Failure                                        | Symptom                               | Mitigation                                                                      |
| ---------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| **False merge** — two tasks in one context     | Resume mixes unrelated files          | High `ASSIGN_THRESHOLD` + margin rule; nightly split proposals; one-click split |
| **False split** — one task in five contexts    | Timeline fragments; Resume incomplete | Recency-boosted candidate scoring; merge proposals; the excursion rule          |
| **Context sprawl** — hundreds of tiny contexts | Contexts view unusable                | Contexts with <3 activities and no manual origin are auto-archived after 7 days |
| **Wrong name**                                 | Loss of trust in one glance           | Deterministic naming ladder; rename is always one click                         |
| **Cold start**                                 | Nothing to group                      | Contexts appear only after 3 activities; empty state explains (§144)            |
| **Embedding unavailable**                      | `semantic` feature missing            | Weights renormalise over the remaining features; engine still works             |

---

## 14. Evaluation

**Golden sessions** are the primary test (ticket P0-005). Six fixtures, 288 events, 10 ground-truth
contexts. The readable source is TypeScript — one event per line with its ground-truth context tag
written on the event itself, so events and ground truth cannot desynchronise — compiled to
`packages/fixtures/golden/*.json`, which is what the Rust engine reads.

| Fixture                        | Events         | Expected              | The failure mode it catches                                                                    |
| ------------------------------ | -------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `gs-01-focused-debugging`      | 40             | 1 context             | Over-splitting on window switches: twelve app changes in 45 minutes, all one task              |
| `gs-02-temporary-interruption` | 27 + 4 noise   | 1 context             | False split from a 4-minute Slack excursion, returning to the same files                       |
| `gs-03-real-context-switch`    | 39             | 2 contexts            | False merge across a sustained 40-minute switch to another repository                          |
| `gs-04-two-tasks-same-repo`    | 36             | 2 contexts            | `repoId` as a shortcut: same repository, one shared file, two tasks                            |
| `gs-05-failed-investigation`   | 33             | 1 context, unresolved | Resume for work that was never finished — no commit, two failed attempts, three dirty files    |
| `gs-06-chaotic-day`            | 113 + 16 noise | 3 contexts            | The benchmark: three tasks fragmented into six blocks across a whole day, either side of lunch |

GS-06 is the primary benchmark. Separating three contexts is the easy half; reassembling each one
from blocks hours apart — the checkout bug spans 09:02 to 16:34 in three pieces — is the hard half.

### The harness

`pnpm eval` scores a _prediction_ (event ref → predicted context id), so it is engine-agnostic: the
same metrics score the TypeScript baselines today and the Rust engine later via `--predictions`.

| Metric                           | Question it answers                                                            |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Pairwise precision / recall / F1 | For two events that belong together, are they together?                        |
| False merge rate                 | Of the pairs we grouped, what share should not have been?                      |
| False split rate                 | Of the pairs that belong together, what share did we separate?                 |
| Purity                           | What share of a predicted context really belongs to its dominant true context? |
| Coverage                         | What share of a true context did its best-matching predicted context recover?  |
| Merged / split context counts    | How many groups have a dominant component below 90 %?                          |
| Important-event recall           | Did the Resume-critical events land in the right context?                      |
| Noise absorption                 | How many unrelated events were pulled into real work?                          |
| Adjusted Rand Index              | One chance-corrected agreement number                                          |

Merge and split are detected by a **dominance tolerance** (90 %) rather than by asking whether some
other piece was "material". The materiality test misses total shattering: forty singletons contain no
piece of two or more events, yet the context is obviously fragmented.

### Baselines

`oracle` scores 1.0 on everything — it validates the harness rather than any engine. `per-repository`
reaches 89.6 % aggregate F1 and collapses on GS-04 (50.8 % false merge, ARI 0.000). `time-gap-15m`
produces exactly three contexts on GS-06 — the right number and the wrong three (ARI 0.020), which is
why context count is reported but never used as a quality metric alone. `repo-and-gap-15m` is the
plausible V0 at 84.9 % F1; a heuristic that cannot beat it is not earning its complexity.

### Discipline

Layers 1–2 only, with the Layer-3 adjudicator mocked (TR-12) — a flaky context test gets deleted, and
then nothing protects the core value. Weights and thresholds are config, not constants, and every
change is validated against the whole golden set: a change that improves one fixture and regresses
another is not an improvement.

**Every future context-engine bug should add a fixture, or extend one.** That is how the benchmark
stays honest instead of becoming something we overfit.
