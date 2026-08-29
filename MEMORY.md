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

**Current: 88.0 % pairwise F1 · 0.2 % false merge · 20.3 % false split · 99.4 % purity ·
91.4 % important recall · ARI 0.449.**

False split is above its 15 % target. That is the open number.

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

- **False split is 20.3 %, target is 15 %.** The open engine number.
- The engine is TypeScript; the Rust port (ADR 0001 D-4) has not started.
- Level 1.5 semantic actions (ADR 0005 D-34), the browser extension, the Cockpit event protocol, and
  the Git/worktree collector are all unstarted.
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
