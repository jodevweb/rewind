# REWIND — Product Definition

> STEP 2 deliverable (§150). The authoritative statement of what REWIND is, who it is for, and what it
> refuses to be.

---

## 1. Vision

**REWIND is a context memory for your computer.**

> Your computer remembers what you were doing, not just what you saw.

Your machine already knows which windows you opened, which files you edited, which commands you ran,
which pages you read, which code you committed. Today all of that context evaporates the moment you
close the laptop. REWIND connects those events into a memory — one that understands that a browser
search, a terminal error, a source file and a commit can all belong to the same problem.

The unit of value is not the event. It is the **context**: the thing you were actually working on.

---

## 2. The problem

Knowledge work is constantly interrupted, and the cost of interruption is not the interruption — it is
the reconstruction afterwards. Every developer has built the same coping mechanisms:

- 70 browser tabs kept open as an external memory, because closing one means losing the thread.
- Scratch notes that go stale in a day.
- `git log` archaeology to answer "why is this line here?".
- Slack search to find a decision nobody wrote down.
- Re-finding the same documentation page for the third time this month.

These are all symptoms of one thing: **the computer holds every fact about your work and none of the
structure.** REWIND supplies the structure.

---

## 3. North Star

> **REWIND understands what you are working on, even when your work crosses multiple
> applications.**

and, operationally:

> **What was I doing, and how do I continue?**

If REWIND answers that reliably, quickly and privately, the product works. Every feature is judged
against it (§153, §162). Data volume is not a goal — REWIND is optimised for the _least_ data needed to
answer that question, not the most.

---

## 4. Personas

> **Superseded in part by [ADR 0002](adr/0002-work-context-first-macos.md) D-12.** REWIND is
> work-context-first, not developer-first. The personas below stay accurate as _use cases_; the one
> that now defines the MVP is P0.

### P0 — "The multi-application worker" (MVP persona, primary)

A working day crosses Slack, Linear, Figma, Notes, Finder, Mail, a browser, a terminal running Claude
Code, and an agent-orchestration app. To macOS these are independent applications; to the person they
are often one subject. Almost no traditional IDE work.

The signal available is thin by design — an application, a bundle identifier, a window title, a
timestamp — plus the occasional rich source. The product's job is to turn that into contexts.

### P1 — "The interrupted developer" (a use case, no longer the wedge)

Works across an IDE, a browser, a terminal and Git. Holds two to five parallel threads: a bug, a
feature, a review, an incident. Gets pulled into meetings and Slack. Loses 10–20 minutes rebuilding
context after every interruption, several times a day.

Why they are the MVP persona: their work emits _structured events_. An IDE save, a commit, a test exit
code and a documentation URL are high-signal, machine-readable facts. Event-first memory works for them
without screenshots. This is the wedge.

### P2 — "The returning author" (MVP persona, secondary)

Same person, months later. Opens a file and finds a condition they wrote and no longer understand.
Needs the chain: line → commit → task → research → decision. Served by the same data, with a longer
time horizon and no additional collectors.

### P3 — "The multi-project consultant" (post-MVP)

Three clients, three codebases, context-switching daily. Needs strong project boundaries and per-project
memory. Mostly served by the MVP with better project-scoped UI.

### P4 — "The non-developer knowledge worker" (explicitly post-MVP)

Figma, Notion, Slack, email. Emits almost no structured events — a title change and a URL. Serving this
persona well probably requires a capture modality REWIND deliberately does not ship at MVP. Recorded
here so that it is a _decision_, not an oversight (see INITIAL_ANALYSIS PR-1).

---

## 5. Core loops

### Loop A — Capture (invisible, continuous)

```
User works normally
  → collectors emit events
  → privacy filter + redaction
  → normalisation
  → persistence
  → activities → contexts (background)
```

Success condition: the user never thinks about it. No prompts, no CPU noise, no interruptions.

### Loop B — Resume (the money loop)

```
User returns after an interruption
  → opens REWIND (tray, hotkey, or app)
  → sees "You were working on: …"
  → reads facts + likely next step
  → clicks Open Context
  → back to work in under 30 seconds
```

### Loop C — Ask (the retention loop)

```
User has a question about their own past
  → types it in plain language
  → REWIND classifies, searches, expands over the context graph
  → answers with evidence and citations
  → user clicks a citation and lands on the moment
```

### Loop D — Correct (the quality loop)

```
REWIND gets a context boundary wrong
  → user merges or splits it in one gesture
  → local rules improve
  → next inference is better
```

Loop D is what keeps A honest. If correcting is tedious, users stop, and the memory silently rots.

---

## 6. The five experiences (§3)

| Experience         | The question                         | Primary evidence                                               |
| ------------------ | ------------------------------------ | -------------------------------------------------------------- |
| **Resume Context** | "What was I doing?"                  | Last activities, open files, failed command, branch, next step |
| **Ask My Memory**  | "How did I solve X?"                 | Cross-session retrieval with citations                         |
| **Why?**           | "Why does this code exist?"          | line → commit → context → research → decision                  |
| **What did I do?** | "What happened yesterday afternoon?" | Structured day summary                                         |
| **Find**           | "Where was that doc?"                | Hybrid search over URLs, titles, semantics                     |

---

## 7. Non-goals

REWIND is **not**:

- a screen recorder or a screenshot database (§9, §111);
- an improved browser history (§2);
- a keylogger — raw keystrokes are never captured, under any setting (§8);
- employee monitoring or bossware (§141);
- a productivity scorer — no percentages, streaks, targets or focus scores exist (§140);
- a time tracker for billing — and more sharply, **not a per-application time report** (ADR 0002
  D-16). `Slack: 43 min · Chrome: 1h12 · Terminal: 2h03` is a different product that already exists.
  Durations attach to contexts and to the applications they crossed, never to applications alone;
- a note-taking app;
- a team knowledge base (a possible future, not this product) (§135);
- a cloud service. There is no account, no server, no sync at MVP (§152).

Explicitly out of scope for MVP (§152): cloud sync, team accounts, billing, permanent screenshots,
mobile, calendar, Slack, Gmail, more than one IDE family, OCR, graph visualisation, browser automation.

---

## 8. Product principles

1. **Event first.** Never compensate for weak context modelling with more screenshots, more OCR or more
   LLM (§154).
2. **Local first.** Every feature must be asked: can this work locally? (§156)
3. **Privacy first.** Every collector must document what it captures, why, where it is stored, how it is
   deleted, and whether it can contain secrets — _before_ it is written (§157).
4. **AI last.** Before reaching for an LLM, ask whether a deterministic rule or an embedding suffices
   (§155).
5. **Source over confidence.** A partial answer with evidence beats a brilliant invented one (§159).
6. **No silent capture.** Every capture is visible, disableable, documented (§158).
7. **Invisible until useful.** The product earns attention; it does not demand it (§28).

---

## 9. MVP definition

### 9.1 The one question the MVP must answer

> **Can REWIND actually put me back in my context after an interruption?** (§101)

Everything not serving that question is deferred.

### 9.2 In scope

**Platform:** Windows 11 first (see ambiguity A-1), architected for macOS and Linux.

**Collectors** (§103):

| Collector                                   | Captures                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| System                                      | Active app, window title, focus changes, idle, lock/unlock, sleep/wake |
| Browser (Chrome/Chromium extension)         | Active tab URL + title, navigation, tab open/close                     |
| IDE (VS Code / Cursor / Windsurf extension) | Workspace, active file, language, file save                            |
| Git                                         | Repository, branch, HEAD, commits, checkout/merge                      |
| Terminal (explicit shell integration)       | Command, cwd, exit code, duration, error tail on failure               |

**Engine:** activity grouping, session detection, context inference (deterministic + embeddings; LLM
only for ambiguity).

**Search:** FTS5 first, hybrid ranking with embeddings second, temporal resolution.

**Surfaces:** Today, Timeline, Contexts, Search, Ask, Settings; tray app; global hotkey.

**Resume:** context card with facts, evidence and next step; Open Context for workspace, files, URLs,
terminal cwd.

**Privacy (non-negotiable at V1, §110):** excluded apps, excluded domains, excluded paths, Pause with
durations, real deletion, secret redaction, recording indicator.

### 9.3 Out of scope for MVP

Screenshots (§111 / A-10), cloud sync, calendar, agent collectors beyond metadata stubs, JetBrains and
Zed, team features, graph visualisation, weekly memory, multi-turn Ask.

### 9.4 The vertical slice (§151)

The first end-to-end proof. After 20–30 minutes of ordinary work across Chrome, VS Code, terminal and
Git, REWIND shows:

```
You were working on: Authentication

Files      src/auth.ts · src/session.ts
Research   BetterAuth session documentation
Commands   pnpm test auth  →  1 test failed
Git        branch feature/auth

[ Open workspace ]  [ Open files ]  [ Open URLs ]  [ Open terminal ]
```

and Resume reopens those resources.

---

## 10. Success metrics

### 10.1 The three success moments (§112–114)

| #   | Moment                                                                 | Measured by                                                        |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| S1  | Work 30 min, leave, return, click Resume, be working again in <30 s    | Timed self-test, then instrumented `resume → first edit` latency   |
| S2  | "Find the documentation I used for X last week" returns the right page | Top-1 / top-3 accuracy on the §127 query dataset                   |
| S3  | "Why did I change this file?" links code → commit → context → research | Manual rubric over 20 real cases; % with correct, evidenced answer |

### 10.2 Quality metrics (tracked from Phase 7)

| Metric                   | Target at MVP        | Why                                      |
| ------------------------ | -------------------- | ---------------------------------------- |
| Context false-merge rate | < 10 % of contexts   | Merged unrelated work destroys Resume    |
| Context false-split rate | < 15 % of contexts   | Fragmentation makes the timeline useless |
| Manual corrections       | < 1/day after week 1 | Above this, users abandon (Loop D)       |
| Resume card correctness  | > 80 %               | Below this, trust breaks (PR-2)          |
| Search top-3 relevance   | > 70 %               | S2                                       |

### 10.3 System metrics

| Metric                            | Target                         |
| --------------------------------- | ------------------------------ |
| Idle CPU (average, no jobs)       | < 2 % (§90)                    |
| Resident memory, idle             | < 250 MB                       |
| Ask query latency (local, no LLM) | < 500 ms p95                   |
| Resume card render                | < 300 ms p95                   |
| DB growth                         | < 2 MB/day typical (see TR-13) |
| Event loss on crash               | < 5 s of events (§96)          |

### 10.4 The qualitative test (§160)

After a few weeks the user should be able to say, truthfully:

> I no longer keep 70 tabs open just because I'm afraid of forgetting why they're there.
> I can interrupt a task without fear of losing my context.
> I can find out why I did something months later.

---

## 11. Positioning

|                 | Screenshot recorders (Rewind.ai, Limitless) | Browser history / notes       | **REWIND**                                      |
| --------------- | ------------------------------------------- | ----------------------------- | ----------------------------------------------- |
| Captures        | Pixels + OCR                                | URLs / manual text            | Structured events                               |
| Understands     | What you saw                                | What you visited / wrote down | **What you were doing**                         |
| Storage         | GB/day                                      | Tiny                          | ~1.5 MB/day                                     |
| Privacy posture | Records everything, filters after           | Narrow scope                  | Captures less by design, redacts before storage |
| Resume          | Visual scrubbing                            | None                          | Context card + reopen resources                 |
| Weakness        | Volume, cost, privacy anxiety               | No structure                  | Weak signal outside developer tools             |

REWIND's bet: **less data, more structure**.

---

## 12. Settled decisions

All ten open questions are resolved in
[ADR 0001](adr/0001-validated-product-decisions.md), which is authoritative over this document.
The ones that shape scope:

- **Developer-first is settled** (D-7). The long-term vision stays general — _a context memory for
  your computer_ — but the initial market is _a context memory for software developers_. Binding
  corollary: no Figma, Notion, Office, Calendar or Slack integration is added to chase the long-term
  vision early.
- **AI coding agents are a first-class context source architecturally** (D-8). Not in the first
  vertical slice, but an agent session must be able to attach to a context alongside files, URLs,
  commands and Git — so REWIND can eventually answer _what did the agent already try?_, _which
  approach failed?_, _which files did it touch while investigating this?_
- **The first milestone is golden session → events → contexts → Resume** (D-9), with citations and no
  LLM. Real collectors replace synthetic events only once that chain is convincing.
