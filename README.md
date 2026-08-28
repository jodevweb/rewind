# REWIND

**A context memory for your computer.**

> REWIND understands what you are working on, even when your work crosses multiple applications.

In a single morning your work can cross Slack, Linear, Figma, Notes, Finder, Mail, a browser and a
terminal running an agent. To the operating system those are nine independent applications. To you
they are often one subject. REWIND connects them into contexts.

So when you come back tomorrow, next week, or six months later, you don't have to reconstruct your own
thinking. Ask _what was I working on?_, _what did I leave unfinished?_, _where was that Figma?_, _what
was Claude doing before I stopped?_ — and REWIND shows you the answer, with the evidence behind it.

`REWIND` is an internal codename. Public naming is deliberately deferred (INITIAL_ANALYSIS PR-4).

---

## What it is not

- Not a screen recorder or a screenshot database.
- Not an improved browser history.
- **Not a keylogger.** Raw keystrokes are never captured, under any setting — and that is enforced by
  a build gate, not a policy statement.
- Not employee monitoring, and not a productivity scorer. There is no score, and no schema that could
  aggregate across people.
- **Not a time tracker.** `Slack: 43 min · Chrome: 1h12` is a different product. Durations attach to
  contexts and the applications they crossed, never to applications alone.
- Not a cloud service. No account, no server, no sync.

---

## Status

**Phase 0 — Foundations.** Design documents complete; decisions settled in
[ADR 0001](docs/adr/0001-validated-product-decisions.md) and revised by
[ADR 0002](docs/adr/0002-work-context-first-macos.md) (work-context-first, macOS-first). The monorepo,
the shared protocol package, the secret redactor, **ten golden sessions** and the context engine
benchmark all exist and run. No collectors and no desktop app yet — by design: the first milestone is
_golden session → events → contexts → Resume_, not "Tauri starts".

```
pnpm eval        # score the context engine benchmark
pnpm test        # redaction corpus + harness integrity — both release-blocking
```

Start here:

| Document                                                                                       | What it covers                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`docs/INITIAL_ANALYSIS.md`](docs/INITIAL_ANALYSIS.md)                                         | Risks, contradictions in the spec, and the ten open decisions     |
| [`docs/PRODUCT.md`](docs/PRODUCT.md)                                                           | Vision, personas, MVP scope, success metrics                      |
| [`docs/PRIVACY.md`](docs/PRIVACY.md)                                                           | What is captured, what never is, and how each promise is enforced |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                                                 | Tauri, Rust/TS split, transport, storage                          |
| [`docs/EVENT_MODEL.md`](docs/EVENT_MODEL.md)                                                   | The schema, from raw event to decision                            |
| [`docs/CONTEXT_ENGINE.md`](docs/CONTEXT_ENGINE.md)                                             | The algorithm that decides what you were working on               |
| [`docs/SEARCH.md`](docs/SEARCH.md)                                                             | Retrieval, temporal reasoning, citations                          |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                                                           | Every ticket, phase 0 through 12                                  |
| [`docs/adr/0001-validated-product-decisions.md`](docs/adr/0001-validated-product-decisions.md) | The settled decisions — authoritative over every other document   |

Supporting: [COLLECTORS](docs/COLLECTORS.md) · [STORAGE](docs/STORAGE.md) ·
[SECURITY](docs/SECURITY.md) · [AI](docs/AI.md) · [UX](docs/UX.md) ·
[PERFORMANCE](docs/PERFORMANCE.md) · [TESTING](docs/TESTING.md)

---

## Repository layout

```
apps/
  desktop/              Tauri v2 app — React frontend + Rust daemon        (Phase 1)
  browser-extension/    Chrome MV3                                        (Phase 3)
  vscode-extension/     VS Code / Cursor / Windsurf                       (Phase 4)
  native-host/          Chrome native messaging bridge                    (Phase 3)
  shell-integration/    Opt-in pwsh / bash / zsh hooks                    (Phase 6)
packages/
  protocol/             Event schemas, redaction registry, prompts        ← implemented
  fixtures/             Golden sessions, redaction corpus, search eval    ← implemented
  eval/                 Context engine benchmark harness                  ← implemented
  ui/                   Design system                                     (Phase 1)
  shared/               Utilities shared by UI and extensions
  config/               Shared tsconfig and tooling presets
docs/                   The documents above
scripts/                Build gates, including the forbidden-API check
```

---

## Development

```bash
pnpm install

pnpm dev        # REWIND Studio on http://localhost:5273
pnpm capture    # capture this machine's real window activity (Ctrl-C to stop)
pnpm eval       # score the context engine against the ten golden sessions

pnpm check      # format + typecheck + tests + the forbidden-API gate
```

**Seeing it work.** `pnpm dev` replays a golden session end to end — events become contexts,
contexts become a Resume card with click-through citations. `pnpm capture` then feeds the same
pipeline your _real_ window activity: it appears at the top of the session picker, marked `●`, and
refreshes while you work. Titles are redacted before they are written, password managers and banking
windows never become events at all, and `pnpm capture:clear` deletes the file.

On macOS the capture probe reads window titles through the Accessibility API, so the first run also
tells you whether that permission is granted — which is the product's hard dependency (ADR 0003 D-22).
No Xcode, no Rust, no signing needed for any of this.

Rust work needs the toolchain from [`CONTRIBUTING.md`](CONTRIBUTING.md) (ticket P1-000).

---

## The bet

Screenshot-based memory records everything and understands little; it costs gigabytes a day and asks
the user to trust a video of their life. REWIND records structured events — roughly 1.5 MB a day, about
1/30th of even a modest screenshot stream — and spends the effort on _structure_ instead.

The unit is the **context**, never the application. Measured on the golden set, grouping by application
scores an Adjusted Rand Index of **−0.003** — worse than chance. That number is the whole thesis.

Optimise for the least data needed to answer one question:

> **What was I working on, and how do I continue?**
