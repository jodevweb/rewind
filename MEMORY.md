# MEMORY — handover

Everything an agent picking this up needs that is **not** obvious from the code, the docs, or the
git history. Written on 2026-08-29.

Read `docs/adr/` first — it is the authoritative record of decisions, and later ADRs amend earlier
ones. This file is the layer above that: the constraints that bite, the traps that cost hours, and
the reasons behind choices that look arbitrary from outside.

---

## What REWIND is

A local-first desktop application (Tauri v2, Rust daemon + React/TypeScript webview) that gives a
computer contextual memory. It groups a day into **contexts** — pieces of work — from window focus,
Git, the filesystem, terminals, and local Claude Code sessions.

Three claims define it, and every design argument comes back to one of them:

- **A context is not an application.** Work crosses tools. This is measured, not asserted: the
  `per-application` baseline scores ARI ≈ 0.06 against ground truth, near chance.
- **It is not a time tracker.** It reports contexts, never per-application durations, and it scores
  nobody.
- **Nothing leaves the machine.** No API, no telemetry, no account, no settings.

REWIND is an internal codename. It resolves through central config and is never hardcoded in product
strings (ADR 0001 A-5).

---

## Hard constraints — do not violate these

These are user decisions, recorded in ADRs, and several are enforced by build gates that fail CI.

1. **No keystrokes, no clipboard, no screen contents, ever.** `scripts/check-forbidden-apis.mjs`
   fails the build on 22 patterns. The only audited exception is
   `apps/desktop/src-tauri/src/platform/macos_ax.rs`, and it may request exactly two Accessibility
   attributes: `AXFocusedWindow` and `AXTitle`. A test scans its own source to enforce that.
2. **Never request Screen Recording permission on macOS.** Accessibility only (ADR 0003 B-1).
3. **No local HTTP server.** Collectors are write-only over named pipes / native messaging.
4. **No API connections, no configuration.** Everything is automatic (ADR 0005 D-13). This is why
   updates go through a public releases repository rather than an authenticated endpoint, and why
   the prediction layer is local and untrained.
5. **Redaction is fail-closed.** A redaction failure drops the event rather than storing it. The
   SQLite schema enforces it: `redaction_version TEXT NOT NULL` with no default, so an unredacted
   row cannot be inserted.
6. **Reading Claude Code sessions uses an explicit field allowlist**, never an object walk. Never
   read `message.content`, `lastPrompt`, `attachment`, `queue-operation`, `compactMetadata`,
   `snapshot`, or any `tool_use.input`.
7. **Tests must never write to the user's real database.** Use `Store::open_at(path)` with a temp
   file. A test suite that writes to real user data is a hazard whatever it asserts.
8. **`REWIND-UPDATER-PRIVATE-KEY.txt` is gitignored and must never be committed.**

---

## The development machine cannot compile this

The primary machine is Windows 11 with **Smart App Control** enabled. It blocks unsigned binaries,
including `rustc` and `rustfmt`, with `os error 4551`. Disabling it is **irreversible**, so it was
deliberately not done.

**CI is the compiler, and CI is also the formatter.** Expect a push-and-read-the-log cycle for every
Rust change, including formatting. `cargo fmt --check` failures print the exact diff — apply it
verbatim rather than guessing.

The user's real work machine is a MacBook. macOS is where the product is used; Windows is a shipped
target too, not a future one (ADR 0004).

---

## Distribution, and why it is shaped this way

`jodevweb/rewind` is **private**. GitHub serves a private repository's release assets only to an
authenticated client, and the application has no token and must not have one. So the updater could
never read a manifest published there — and it failed **silently**, because a missing manifest is
indistinguishable from "no update yet".

So: **`jodevweb/rewind-dist` is public and holds only the built installers.** Signing stays in the
private repository; a write-scoped PAT for the dist repo lives there as the `DIST_TOKEN` secret.
See ADR 0006.

- `.github/workflows/ci.yml` — lint, typecheck, tests, privacy gates. Linux for everything that
  can run there, Windows for Rust, macOS only when macOS-specific files changed.
- `.github/workflows/release.yml` — builds both platforms, assembles `latest.json`, publishes to
  `rewind-dist`. Run it from the Actions tab with a version like `0.3.0`.

There is no separate installer-build workflow. There was one, producing artifacts to download by
hand; once in-app updates worked it was only a second way to spend macOS minutes.

### Minutes are the real constraint

Private repository, free tier: 2000 minutes a month, billed by a multiplier — Linux ×1, Windows ×2,
**macOS ×10**. A six-minute macOS job costs sixty minutes of the allowance.

A release builds both platforms and costs roughly **75 billed minutes**, so the month holds about
twenty-five of them. Ordinary CI is now about 3. Before this was noticed, a single push cost about
84 and the month was 90 % gone in a few days.

**So: batch changes into one release rather than releasing each fix.**

**macOS first install always needs this**, and it is in the release notes:

```
xattr -dr com.apple.quarantine /Applications/REWIND.app
```

The app is ad-hoc signed (`signingIdentity: "-"`) but not notarised — that needs a paid Apple
Developer account, which is a decision nobody has taken. Without removing quarantine, macOS moves the
app to the Trash **on launch**, reporting it as "damaged". Updates through the app do not
re-quarantine, so this is a first-install step only.

Never ship a `.app` through `actions/upload-artifact`: the zip drops the executable bit and the app
genuinely will not run. Ship the `.dmg`.

---

## The engine, and the traps in it

`packages/engine-v0` is the deterministic context engine (TypeScript reference implementation; a
Rust port is planned). Scored by `pnpm eval` against 11 hand-authored golden sessions.

**Current: 99.2 % pairwise F1 · 0.3 % false merge · 1.2 % false split · 99.4 % purity ·
99.7 % important recall · ARI 0.906.** All eleven fixtures produce exactly the expected number of
contexts. Every target in PRODUCT.md §10.2 is met with room.

It read 88.0 % F1 and 20.3 % false split until the conflict rule was fixed — see below. Do not read
these numbers as a ceiling reached by tuning: no weight or threshold was touched. One wrong question,
asked in three places, was costing eight points.

### The distinction the whole engine turns on

**Absence of evidence is not evidence of difference.** An activity carrying _no_ anchors cannot
contradict anything, so it joins what surrounds it. An activity carrying anchors and sharing _none_
of them starts something new. Conflating the two made real Level 1 capture unusable — window titles
carry no paths or branches, so nearly everything landed outside any context.

### Naming and grouping are different jobs

Contexts used to be named after a repository or a filename ("Importer.Ts", "Travail dans
rewind-desktop") because `namedFrom` reached for a `project` anchor — derived from a working
directory — before anything else.

Subjects now name contexts, extracted from window titles by distinctiveness (TF-IDF-ish), with
phrases that name a **place** excluded outright. Location moved to a `place` field shown beneath the
name.

**Subjects are deliberately kept out of grouping.** Using them as grouping anchors was tried and cost
eight points of F1: titles are full of repository and organisation names, so the "subject" quietly
became the location again, promoted from weak to medium evidence, and false merges on the
chaotic-day fixture went from 2.6 % to 17.5 %. A vague label costs a reader a moment; a wrong
grouping key silently rewrites the history of a day.

### The conflict rule, and the eight points it was costing

`issue` and `worktree` are both STRONG, so a context carrying one and a context carrying the other
could never share an anchor. Three separate places — the activity boundary, the assignment score and
the merge pass — tested "both sides carry a strong anchor and none of them match" and read that as
positive evidence of **different** work. It is evidence of nothing: the two are not comparable. An
issue id and a worktree path are two ways of saying which task this is, and every day they named the
same task, the rule cut it in half.

Comparison is now **within a type** (`identityConflict`). Two different issue ids still disagree,
which is what keeps GS-04's two tasks in one repository apart. This is the same principle the engine
already applied to weak evidence, applied where it was being ignored.

`branch` was added to that comparison even though it is only medium evidence elsewhere, and the
asymmetry is the point: a branch is weak evidence that two things belong _together_ — plenty of
unrelated work happens on `main` — and strong evidence that they do not. GS-06 turns on it. Reviewing
a colleague's pagination PR and building an empty state share a repository, a checkout and an
afternoon; the branch is the only thing that separates them.

### Unlabelled islands

An anchorless activity past the drift window opens a context of its own, and every anchorless
activity after it joins that one — so when the identified work resumes, the day carries a nameless
island between two halves of one subject. A context is now absorbed when it sits **entirely** inside
another's span and carries no anchor above weak. Weak anchors are hostnames and repository names:
they say where something happened, never what it was. GS-08 is the guard rail (a project anchor is
medium, so two interleaved projects cannot swallow each other) and so is GS-11 (nothing follows the
evening, so nothing can bracket it).

### Things that were tried and were wrong

Recorded here so nobody spends the afternoon again:

- **Treating a non-matching subject as evidence of different work.** Reasonable, wrong: two shades of
  one task produce different phrases, and the day fragmented.
- **Penalising a phrase for appearing in several contexts.** Reasonable, wrong: it preferred rarer,
  emptier words, turning "Pricing (MKT-118)" into "Update (MKT-118)". Softening to a square root
  changed nothing.
- **`document` as a STRONG anchor.** A shared file merged two unrelated tasks in one repo (GS-04).
  It is MEDIUM.
- **`cwd` emitting a `document` anchor.** A workspace name became medium evidence shared by every
  task in the repository. It is repository-class, and weak.
- **Coherence tested against a context's accumulated anchors.** Made every context a magnet; GS-04
  collapsed into one. It compares against the last three events.
- **Drift measured from a context's end.** A ratchet: each anchorless activity attached, pushed the
  end forward, and made the next one "nearby" too, so an evening of gaming accreted onto an
  afternoon of work. Drift is measured from the last activity that carried identity. GS-11 covers it.

### The golden sessions

`packages/fixtures/src/sessions/gs-*.ts`, one event per line with its ground-truth tag inline,
compiled to JSON by `pnpm --filter @rewind/fixtures build`. **Run that build after editing a
fixture** or `pnpm eval` scores the old JSON — that has wasted time more than once.

`defaultRepo` in a session spec stamps a repository anchor onto **every** step. GS-11's first draft
asserted nothing because of it. Use `repo: null` per step to opt out.

`packages/fixtures/golden/` is generated and is in `.prettierignore`.

---

## Days, and who reads what

The daemon exposes three event queries and they are not interchangeable:

- `events_for_day(day)` — one work day, **whole**. What the engine sees. Handing it a fortnight lets
  last Tuesday's anchors compete with this morning's; handing it half a day produces contexts that
  end where the page did.
- `recent_events(limit)` — the recent stream across days. What the prediction layer sees, because a
  habit is invisible inside a single day. Also what Ask searches: a question about last week that
  only looks at today is not a memory.
- `event_days()` — every work day that has anything in it, counted in SQL. The navigator lists six
  months without the interface having read six months.

Three silent bugs came out of building this, and they are the kind that look like nothing:

1. `recent_events` clamped to **500** while the window asked for 5000. The interface reconstructed
   the last couple of hours and called it the day, and prediction counted habits inside a fraction
   of one. Nothing looked wrong.
2. The view stamped every event with **this machine's current** timezone offset, discarding the one
   it was captured at. A day read from another timezone showed the wrong hours — the exact thing
   TR-8 exists to prevent.
3. The engine and the prediction layer were sharing one input while wanting opposite things.

The live day polls every 3 s; a finished day does not poll at all; history reloads every 60 s.

## Prediction

`packages/predict` — four models, all counted rather than trained: `rhythm`, `interruption`,
`resume` (Markov transitions × hour-of-day), `drift`.

The rule they share is **withholding**. Each returns nothing without enough history, and the UI
panels disappear rather than showing a hedge. A confident wrong answer at the top of the window is
worse than an empty one: it teaches the reader that the panel is noise, and that is not un-taught.
Most of the 21 tests are about the refusals.

Nothing scores anyone. No productivity number, no target, no green or red.

---

## Working with this user

- **They write French, and the product is French-first** with an EN toggle. Every user-facing string
  goes through `packages/ui/src/i18n.ts` — both dictionaries, or typecheck fails.
- **They keep all data deliberately**: "ça va nous permettre de faire des stats, d'être déterministe,
  de pouvoir faire des KPI". Never delete events to reduce noise. Noise reduction is a display
  concern — short spans are kept and scored low, never dropped.
- **They notice when something is quietly missing.** Reducing unassigned events to a count read as
  deletion. Anything captured must be reachable in the interface.
- **They test on real usage immediately**, and real usage breaks things fixtures do not. Two of the
  best fixes in this repo came from them playing League of Legends and from an evening of gaming
  being filed as work.
- **Verify before telling them to click something.** Telling them to run a release that had not been
  fixed, twice, wasted their evening. Check the actual state via the API first.
- **They will not run long manual sequences.** Automate it or it will not happen.

### Their environment

- Windows 11 (this machine) + MacBook (their real one). Both are shipped targets.
- No `gh` CLI installed. Use the GitHub REST API with the credential from
  `git credential fill`.
- Bash heredocs mangle backslash escapes here. `\r` and `\n` inside a quoted heredoc arrive as real
  control characters and corrupt files. **Write a `.cjs` script to a scratchpad file and run it**
  for anything with escapes — this cost several corrupted files.
- `String.replace` with a replacement containing `` $` `` or `$&` substitutes surrounding text. Pass
  a **function** replacement (`() => to`) always.

---

## Commands

```
pnpm check     # lint, typecheck, all tests, privacy gates — run before every push
pnpm eval      # score the engine against the golden set
pnpm build     # .app / .dmg / NSIS installer (needs a working rustc — not this machine)
pnpm --filter @rewind/fixtures build    # recompile fixtures after editing a session
```

---

## What is not done

- The engine meets every benchmark target, so the open question is no longer a number on the golden
  set — it is that eleven hand-authored days are a small benchmark, and the fixtures were written by
  the same people who tuned against them.
- The engine is TypeScript; the Rust port (ADR 0001 D-4) has not started.
- Level 1.5 semantic actions (ADR 0005 D-34), the browser extension and the Cockpit event protocol
  are unstarted. The Git and terminal collectors now exist — see below.
- No notarisation, so every fresh macOS install needs the `xattr` step.
- Prediction reads whatever events the window has loaded (currently up to 5000). Multi-week history
  would want a dedicated query rather than pulling everything into the webview.

---

## Ask

`packages/ask` — a question in plain language, answered from the stored events, locally and
deterministically. It is the promise the README is named for, and it did not exist in the interface
until now: the application reconstructed your day and left you to scroll it.

Four stages, all rules, no model: intent classification (SEARCH §2), temporal resolution (§3),
lexical recall over **rows** rather than events, and a deterministic answer with citations (§7.1).
`⌘K` anywhere opens it.

### What differs from SEARCH.md, and why

- **No vector stage and no `ContextLink` graph** — neither exists on this machine yet. The document
  says weights renormalise; the obvious reading, spreading the missing 0.30 across everything left,
  is wrong here. Lexical is then the only signal that reads the question at all, so spreading it
  lets a recent, important, unrelated row outrank an exact match from last week. The semantic weight
  goes to lexical (0.55) and the graph weight to context affinity (0.20).
- **Scores stay absolute, never normalised against the best result.** Normalising makes the top row
  1.0 even when nothing matched, and the refusal threshold — the thing that stops this inventing
  answers — would never fire.

### The traps

- **A question that names a category has no content to match.** "Quelle commande a échoué" is all
  question words and one category, so a purely lexical search refuses it — correctly and uselessly,
  since it is a canonical query in §10. `kinds.ts` lifts category words out of the terms and turns
  them into a filter over row kinds, abandoned if it empties the result set.
- **Conjugated verbs are part of the question, not of what is asked about.** Leaving `travaillais`
  in the terms turned "sur quoi je travaillais ?" into a search for a word that appears nowhere.
- **Cut phrases by token, never by substring index.** The classifier works on folded text, so
  searching for its folded "ou etait" inside a raw "où était" silently never matches.
- **French and English are both first-class in every pattern.** Nobody switches the interface
  language before typing a question.

### Rows, not events

A documentation page read twenty times is twenty events and one memory. Events fold into rows keyed
by `(context, kind, target)`, carrying an occurrence count and a span. One event yields several rows
— a commit is a message _and_ a branch — so "the auth file" and "the commit about auth" are both
findable without either query guessing which the other meant.

Rows are built from an explicit field allowlist, never an object walk. Search must not become the
route by which something reaches the screen that the capture rules kept off it.

---

## Handoff, and why the Resume card grew buttons

`buildResume` computed `openResources` and `nextStep` from the start, and the interface rendered
neither as an action: the only way to open anything was the event detail panel, one target at a time.
So "resume" meant reading a card and then getting back to work by hand.

Two things were wrong underneath, and both were invisible:

1. **`openResources` was filled by three event types the real collectors do not emit** — a browser
   navigation, an IDE workspace and a terminal `cwd`. On a real day it was always empty.
2. **`agent.session` was not handled by `buildResume` at all.** The three synthetic agent types
   were (`agent.session.started`, `agent.activity`, the Cockpit ones); the type the collector
   actually writes was not. A day spent in Claude Code produced an empty Resume card.

Both are fixed, and `packages/ui/src/handoff.test.ts` guards the shape. The one to keep is the last
test: a context built only from window focus must produce **no** open targets. A button that opens
nothing teaches the reader the feature is decorative, and that is not un-taught.

`packages/ui/src/handoff.ts` assembles the three exports (agent brief, standup, worklog). It lives in
the UI package and not in the engine because the engine must not emit prose — it returns which rule
fired and with what values, and the dictionary is here (§147).

**Clipboard:** `navigator.clipboard.writeText` with a `textarea` + `execCommand` fallback, because a
Tauri webview is not a secure context on every platform. Note the asymmetry: **writing** is fine,
**reading** is a build-gate violation (`navigator.clipboard.read` is one of the 22 forbidden
patterns).

## The morning brief

`packages/ui/src/brief.tsx`. A banner, deliberately, not an OS notification — that decision is
reversible but it was made on purpose: a notification that fires every morning whether or not it has
something to say gets muted in a week, and a muted channel cannot be un-muted by being right later.
It also would have meant a new Tauri plugin, which is a Cargo dependency this machine cannot compile.

It withholds like the prediction layer does: nothing when today already has more than
`BRIEF_MAX_EVENTS_TODAY` (40) events, nothing when there is no previous day, nothing when the
previous days hold no context. It reaches **past** an empty day, so a Monday still knows about Friday.

## The Git collector

`apps/desktop/src-tauri/src/git.rs`. Reads files, does not run git:

- `.git/HEAD` → branch. `.git/logs/HEAD` → commits and checkouts, parsed from the reflog.
- The **only** subprocess is `git status --porcelain`, for the uncommitted count, every five minutes
  per repository and **only emitted when the count changes**. A summary per tick would be three
  hundred events a day per repository saying the same thing.
- A reflog line carries the author's name and email. The timestamp is read **from the end of the
  line** precisely so the parser never indexes into the middle where they sit.
- Repositories are discovered by walking the home directory (depth 4, 20 000 directories max,
  dependency trees skipped) and capped at the 24 most recently touched, ranked by reflog mtime.
- **First sight of a repository backfills at most 7 days and 50 entries.** Without that, meeting a
  repository for the first time pours ten years of commits into today.
- A shrinking reflog (`git gc`, rebase, re-clone) jumps the offset to the new end rather than
  replaying: a few lost entries beat a duplicated history.

## The terminal collector, and the pause rule it forced

`apps/desktop/src-tauri/src/shell.rs` plus `apps/shell-integration/`. One file per command in
`<data_dir>/spool`, deleted as it is read — not one growing log per session, because reading a log at
an offset while a shell appends to it tears lines, and a torn line is a command attributed to the
wrong exit code.

**The format is not JSON on purpose.** `cmd=` comes last and takes the rest of the file, so a command
containing quotes, newlines or `=` needs no escaping in three different shells.

The hooks write **only while REWIND is running**: the daemon stamps `spool/.alive` every two seconds
and the hook reads it with a shell builtin — `$(<file)` in zsh and bash, `[IO.File]` in PowerShell —
so there is no subprocess in your prompt. Close REWIND and collection stops at the source rather than
piling command lines into a directory nothing reads.

### Pause, for file-derived sources

This is the subtle one. Pause means nothing is captured, **not** captured-and-hidden (§7). A source
that reads a file breaks that promise by accident: skip a paused hour and the next pass finds the
file longer and stores everything that happened during it.

So a paused pass **still advances the read offsets and writes nothing** — in `git.rs`, in `shell.rs`
(the spool file is deleted unread) and in `claude.rs`, which had the bug and now takes a
`recording` flag for exactly this reason.

## MCP — REWIND inside the agent

`packages/mcp`. stdio JSON-RPC, hand-written (one framing rule, five methods), reading the store
**read-only** through `node:sqlite`. No port, so ADR 0001 D-5 holds.

Two traps worth knowing:

- **`node:sqlite` is a real builtin that is deliberately absent from `module.builtinModules`**, like
  `node:test`. Every bundler that decides what to externalise from that list tries to resolve it as a
  file and fails, so vitest could not load the module at all. It is `createRequire`d, with a
  type-only `import type` for the types.
- `serve()` is separated from `respond()`, and `main.ts` is the only module with a side effect at
  import time. A server that can only be observed by spawning it and reading its stdout gets tested
  once.

The tools return assembled text, never generated prose, and every answer ends with the line saying
where it came from. `rewind_ask` passes a refusal through **as a refusal**, and the tool description
tells the model in as many words not to complete it with a guess.

`toSession` — daemon rows to the event model — moved to `packages/shared/src/session.ts` when the
MCP server became its second reader. Two copies would not have disagreed loudly: they would have
disagreed about `repositoryId`, and contexts would have grouped differently depending on which
program asked.
