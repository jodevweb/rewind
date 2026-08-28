# REWIND — UX & Design

> The interface is the product's argument. If the timeline is not pleasant to read, none of the
> engineering matters.

---

## 1. Design principles

1. **The timeline and the contexts are the product.** Not a chatbot, not a dashboard (§142).
2. **Invisible until useful** (§28). REWIND earns attention; it never demands it.
3. **Calm and dense.** Information-rich but quiet. No gradients, no AI-purple, no confetti (§142).
4. **Descriptive, never evaluative.** Durations describe; they never judge (§140, PR-5).
5. **Evidence is always one click away** (§54).
6. **Nothing happens without the user asking**, except capture — and capture is always visible (§84).

Tone: a colleague who took notes, not an assistant who is excited to help.

---

## 2. Navigation (§48)

| Route        | Purpose                                            |
| ------------ | -------------------------------------------------- |
| **Today**    | Home. Yesterday's contexts, open threads, Resume   |
| **Timeline** | Chronological detail with source filters           |
| **Contexts** | The library of what you have worked on             |
| **Search**   | Fast lookup, results not prose                     |
| **Ask**      | Questions in plain language, answers with evidence |
| **Settings** | Privacy, collectors, retention, inspector          |

Every route is keyboard-reachable; the global palette (`Ctrl+Shift+Space`) reaches all of them plus Ask,
Resume, Remember this, and Pause (§86).

---

## 3. Today (§49, §71)

```
Good morning.

  Yesterday

  ● Stripe renewal bug                     1h 42m        Resume →
    12 files · 4 pages · 8 commands · 1 commit
    Left off: pnpm test stripe — 2 tests failing

  ● Home Staging V2                        2h 16m        Resume →
    6 files · 1 commit · PR #481 opened

  ● Code review                               48m

  Open threads
  · Stripe test still failing            since yesterday 17:43
  · 3 uncommitted files in myapp
```

Notes on what is deliberately absent: no total-hours figure, no comparison to other days, no percentage,
no goal, no streak. "Open threads" is the highest-value block on the page and comes from deterministic
signals (failing commands, uncommitted changes, unresolved diagnostics) — never from a model.

---

## 4. Timeline (§50, §108)

Vertical, grouped by activity rather than one row per event — otherwise it is a log, and logs are not
memory.

```
  14:02 ─┬─ ● Editing stripe.webhook.ts                        VS Code   6m
         │    stripe.webhook.ts · billing.service.ts
         │
  14:08 ─┼─ ○ Reading Stripe invoice documentation             Chrome    4m
         │    stripe.com/docs/api/invoices
         │
  14:13 ─┼─ ▲ pnpm test stripe                               Terminal   12s
         │    exit 1 · 2 tests failed
         │    ● AssertionError: expected 'active' to be 'trialing'
         │
  14:26 ─┴─ ◆ Commit a72c91                                       Git
              "handle invoice.created before subscription.updated"
```

Filters: all · browser · code · terminal · git. Failures are the one thing that draws the eye — a
subdued red marker, because "what failed" is the most-sought fact when returning to work.

Performance: virtualised; 100 k rows scroll at 60 fps; filters apply in under 100 ms.

---

## 5. Context card (§51)

```
┌────────────────────────────────────────────────┐
│ Stripe Renewal Bug                    ● active │
│ Yesterday · 1h 42m                             │
│                                                │
│ 12 files   4 pages   8 commands   1 commit     │
│                                                │
│ Outcome  Fix implemented                       │
│                                     Resume →   │
└────────────────────────────────────────────────┘
```

Confidence appears only when it is low, as a quiet "Low confidence — is this one piece of work?" with
merge and split affordances. High confidence says nothing: correct is the expected state and does not
need announcing (§74).

---

## 6. Context detail (§52)

Sections in this order — **Summary first, but facts immediately beneath it**, so a wrong summary is
corrected by what follows rather than believed:

`Summary · Timeline · Files · URLs · Commands · Commits · Decisions · Next steps · Open context`

Every row is clickable to its moment. Every LLM-generated element carries a small marker and its
evidence. Decisions extracted by a model appear as proposals with **Confirm** / **Dismiss**, never as
established facts (EVENT_MODEL §10).

---

## 7. Resume (§106)

The single most important screen in the product.

```
┌──────────────────────────────────────────────────────────┐
│ You were working on                                      │
│ Authentication bug                                       │
│ Last activity 17:43 · 1h 12m total                       │
│                                                          │
│ Files          src/auth.ts, src/session.ts               │
│ Reading        BetterAuth session documentation          │
│ Last command   pnpm test auth   → 1 test failed          │
│ Branch         feature/auth                              │
│                                                          │
│ Next           Fix the failing session test              │
│                                                          │
│ [Open workspace] [Open files] [Open URLs] [Open terminal]│
└──────────────────────────────────────────────────────────┘
```

Rules: facts before prose; every field omitted rather than guessed; restore buttons grey out with a
reason when the target is gone (PR-6); "Open URLs" opens a picker, never 30 tabs (§63); the terminal
opens at the recorded `cwd` and _shows_ the last command without running it (§62).

---

## 8. Ask (§55, §109)

Single-turn. One input, suggested questions beneath it:

```
  Ask your memory...

  · What was I doing yesterday?
  · Why did I change this file?
  · Find the Stripe docs I used.
  · What did I leave unfinished?
  · Which projects did I work on this week?
```

Answers are structured results by default; prose only if a provider is configured, and always above its
citations rather than instead of them. Time expressions resolve into an editable chip
(`Fri 22 Aug 00:00 → 23:59 ▾`) so the user can see and correct what "last Friday" was taken to mean.

Refusal is a first-class state, designed rather than an error (§79): what was searched, the closest
matches, and a suggestion.

---

## 9. Empty states (§144)

```
        REWIND is learning your work.

        Use your computer normally.
        Your first context will appear here.

        Typically after a few hours of work.
```

Honest about the cold start (PR-3). Each route has its own: Contexts explains what a context is; Ask
suggests questions that will work with the little data that exists; Timeline shows what _has_ been
captured so the user can see it is alive.

---

## 10. Recording indicator (§84)

Always visible in the tray and in the app header:

```
● Recording          ⏸ Paused · 24 min left          ⚠ Chrome extension disconnected
```

There is no state in which REWIND captures without saying so. The indicator is a control: clicking it
opens pause options.

---

## 11. Notifications (§145)

Almost none. The complete permitted list:

| Notification                        | When                                      | Frequency cap                           |
| ----------------------------------- | ----------------------------------------- | --------------------------------------- |
| "You were working on X. Resume?"    | Return from an absence over the threshold | Once per return                         |
| "Pause expired — recording resumed" | Pause ends                                | Every time (a transparency requirement) |
| "Chrome extension disconnected"     | A collector fails                         | Once per session                        |

No daily summaries, no nudges, no streaks, no re-engagement. A memory tool that pesters gets muted, and a
muted memory tool is a deleted one.

---

## 12. Visual language (§142, §143)

Dark and light, both first-class, following the OS by default.

Restraint: one accent colour used sparingly; red reserved for failures; source identity carried by small
monochrome glyphs rather than colour-coding six sources; type is the primary hierarchy tool; generous
line height in the timeline, since it is read like prose.

The "memory threads" idea (§143) appears as a subtle connecting line in the timeline linking events of
one activity, and in the context detail linking evidence to claims. It is a readability device, not a
constellation visualisation — a pretty graph nobody can read would violate §142.

---

## 13. Interaction rules

- Nothing auto-applies. Merges, splits, restores and deletions are all explicit.
- Every destructive action is undoable, or confirmed with a specific description of what will be lost.
- Every list has a keyboard path; `/` focuses search anywhere; `Esc` always retreats.
- Loading states show what is happening; a spinner with no label is a bug.
- Latency budgets are UX requirements: Today under 500 ms, Resume under 300 ms, search-as-you-type under
  50 ms.

---

## 14. Accessibility (§146)

Full keyboard operation with visible focus; WCAG AA contrast in both themes; semantic landmarks and
labels; screen-reader support on Today, Timeline, Contexts and Ask; respect for `prefers-reduced-motion`;
no colour-only meaning (failure is marked by both an icon and a colour). Checked with axe in CI plus a
manual screen-reader pass each phase.

---

## 15. Internationalisation (§147)

All user-facing strings externalised from day one; English default; ICU message format for plurals and
dates; layouts tested at 1.4× string length; dates and durations formatted per locale. A lint rule fails
the build on a string literal in JSX.

---

## 16. Onboarding (§83)

Six screens, under three minutes:

1. **Your computer can remember your work.** — the value, in one sentence and one example.
2. **What REWIND sees, and what it never sees.** — the §2 never-list, verbatim and plainly.
3. **Choose what REWIND can observe.** — browser, IDE, Git, terminal; all off until chosen.
4. **Choose what to exclude.** — the shipped defaults, editable, with an explanation of why each exists.
5. **Install extensions.** — deep links, with a skip option and a way back.
6. **Start recording.** — plus the honest expectation: _REWIND gets useful after about a week._

Screen 2 comes before screen 3 deliberately. A user who understands the boundaries opts into more, not
less — and if they do not want it after reading screen 2, they should not be here.
