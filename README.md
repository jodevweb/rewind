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
pnpm dev          # launches REWIND — the application
```

**`pnpm dev` builds and runs the desktop app**, which needs a Rust toolchain the first time:

```bash
# macOS
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
xcode-select --install

# Windows
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools"
```

The first build compiles a few hundred crates and takes several minutes. After that it is seconds.

REWIND then lives in the tray or menu bar. **Capture runs from launch — there is nothing to start.**
The tray shows `● Recording` or `⏸ Paused` at all times, and pausing is how you stop it (§7, §84).

On macOS the first run asks for Accessibility. Without it REWIND sees which application is active but
not its window titles, and the titles are most of the signal — so the window says so rather than
pretending. REWIND takes no screenshots and never requests Screen Recording.

### A real application you can keep

`pnpm dev` runs from a terminal, which is a development loop and not how you use software. To get an
application you drag into Applications and open whenever you like:

```bash
pnpm build
```

It produces, on macOS:

```
apps/desktop/src-tauri/target/release/bundle/macos/REWIND.app     ← drag into /Applications
apps/desktop/src-tauri/target/release/bundle/dmg/REWIND_0.1.0_*.dmg
```

and on Windows an NSIS installer under `bundle/nsis/`.

The release build optimises for size and takes longer than the dev build the first time. Afterwards
REWIND opens like any other application: it lives in the menu bar, capture runs from launch, and you
pause it from there.

**Not signed yet.** macOS will warn on first open — right-click → Open, once. Signing and
notarisation are deliberately not blocking the prototype (ADR 0003 D-23).

### Installers without a local toolchain

If you cannot build locally — Windows Smart App Control blocks an unsigned `rustc`, and disabling it
is irreversible — CI builds both platforms for you:

**Actions → Build installers → Run workflow.** It produces `rewind-macos` (.app and .dmg) and
`rewind-windows` (NSIS installer) as downloadable artifacts.

The privacy gates run in that workflow too. An installer that skipped them would be the one build
where the guarantees did not hold.

### The development harness

```bash
pnpm studio       # replay golden sessions through the engine, at localhost:5273
pnpm eval         # score the context engine against the ten golden sessions
pnpm check        # format + typecheck + tests + the forbidden-API gate
```

`pnpm studio` is a **web page and a development tool**, not the product — a browser cannot control
capture without the localhost HTTP server ADR 0001 D-5 forbids. It exists to develop the context
engine against fixtures, and to see the engine's reasoning next to the ground truth.

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
