# ADR 0001 — Validated product and architecture decisions

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** INITIAL_ANALYSIS §5 (ambiguities A-1 … A-10), ARCHITECTURE §3–4, PRIVACY §9, ROADMAP

## Context

INITIAL_ANALYSIS recorded ten open questions rather than resolving them silently. All have now been
decided. This ADR is the record; the affected documents have been updated to match, and this file is
the authority if any of them lags.

## Decisions

### D-1 — MVP platform is Windows 11

Windows first. Every OS dependency sits behind an abstraction so macOS is a new implementation rather
than a refactor. Seven abstractions are required, named explicitly:

| Abstraction                                          | Windows implementation                      |
| ---------------------------------------------------- | ------------------------------------------- |
| `WindowWatcher` — active window, focus changes       | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`  |
| `ProcessInfo` — process identity for a window        | `QueryFullProcessImageName`, cached by PID  |
| `IdleWatcher`                                        | `GetLastInputInfo`, 5 s poll                |
| `SessionWatcher` — lock / unlock                     | `WTSRegisterSessionNotification`            |
| `ShellIntegration` — install / remove hooks          | PowerShell profile; bash and zsh for parity |
| `SecureStorage` — tokens and provider keys           | Windows Credential Manager                  |
| `Launcher` — open a URI, file, workspace or terminal | `ShellExecuteEx`, IDE CLIs                  |

**The domain layer knows nothing about Windows.** Context engine, search, privacy, persistence and
the domain models contain no platform-conditional code and no platform types. Enforced by review:
a `#[cfg(windows)]` outside `rewind-collect::os` or `rewind-daemon::platform` is a defect.

### D-2 — REWIND is an internal codename only

No branding work against this name. Every user-visible occurrence of the product name resolves
through one central constant (`config.productName`, surfaced to the UI through i18n) — never a
hardcoded literal in a component, a window title, an installer string or an extension manifest.
Renaming must be a one-line change plus asset replacement.

### D-3 — No automatic backfill

Capture begins only after explicit consent at first run. An onboarding step is added later:

```
Import previous context?
  ☐ Import local Git history
  ☐ Import browser history
```

Both default off, independent. **Git history backfill is the priority**; browser history can wait.
Git history is defensible: it is already a durable local record the user authored, it carries no
third-party browsing data, and it is exactly the evidence the "why does this exist?" question needs.

### D-4 — Rust owns the domain; TypeScript owns presentation

Rust: core, database, privacy and redaction, context engine, search and indexing, AI orchestration
belonging to the daemon, collector orchestration.

TypeScript: UI, presentation, extension clients, shared protocol types.

**No critical business logic is duplicated across the two.** Where a schema must be shared, it is
generated from one source in `packages/protocol` rather than maintained twice. The one deliberate
exception is the secret redactor, which needs an extension-side implementation to strip secrets
before they leave the producing process; both are driven by the same `patterns.json` and the same
fixture corpus, and a conformance test fails the build if they ever disagree on a single case.

### D-5 — No local HTTP server

Windows named pipes for local IPC; Chrome native messaging for the browser. No TCP port is ever
opened. Collectors are write-only: a compromised collector can inject noise but cannot query the
memory. A documented threat model is required per channel (SECURITY.md §2).

### D-6 — Raw and derived memory have separate retention policies

Raw events: 90 days, configurable. Derived memory — contexts, summaries, decisions, outcomes,
relevant URLs, file paths, Git SHAs, cleaned commands, citations and provenance — is kept long term.
**Any compaction must preserve provenance**, so "why does this code exist?" stays answerable months
later without retaining every raw event forever.

### D-7 — The MVP is developer-first

No longer an ambiguity. Long-term vision stays general — _a context memory for your computer_ — but
the initial market is _a context memory for software developers_. The MVP is optimised to understand
repositories, branches, workspaces, source files, documentation, terminal commands, tests, errors,
commits and AI coding agents.

Corollary, binding: **no Figma, Notion, Office, Calendar or Slack integration** is added to chase the
long-term vision early.

### D-8 — AI coding agents are a first-class context source, architecturally

An agent session must be able to attach to a context alongside files, URLs, commands and Git:

```
Context
 ├ Files
 ├ URLs
 ├ Commands
 ├ Git
 └ Agent Sessions
```

The target questions are _what did the agent already try?_, _which approach failed?_, _which files
did it touch while investigating this?_ Not in the first vertical slice, but nothing may foreclose
it: the `agent.*` event types stay in the schema, `ContextLink.targetType` keeps `agent_session`, and
no provider-specific assumption enters the model. Content capture remains separately opt-in
(PRIVACY PVR-6).

### D-9 — The first milestone is not "Tauri starts"

It is **golden session → events → contexts → Resume**, rendered with citations, and with no LLM
involved. Only once that chain is convincing on synthetic data do real collectors replace the
synthetic events. The Fake Collector built for this stays in the product permanently, for tests,
demos, debugging, regression testing and reproducing user issues.

### D-10 — Remaining resolutions

| Ref  | Decision                                                              |
| ---- | --------------------------------------------------------------------- |
| A-3  | Cloud AI off by default; no provider configured at first run          |
| A-7  | Ask is single-turn                                                    |
| A-8  | Full terminal stdout off by default; error tail only on non-zero exit |
| A-10 | No screenshots in the MVP                                             |

## Consequences

- ROADMAP is reordered: P0-005 first, Tauri third. See ROADMAP §"Immediate work order".
- The Fake Collector becomes a permanent component, not scaffolding — it needs the same review
  standard as shipped code.
- Windows-only for longer than a portable-from-day-one approach, in exchange for depth on one
  platform. Reversible at the cost of implementing seven traits.
- Deferring the name means the Chrome Web Store submission is gated on that decision.

## What would make us revisit

- D-1 if the primary development machine changes, or if a Windows-specific limitation blocks a core
  collector.
- D-7 if the developer wedge proves too narrow commercially — but not before the §112 and §114
  success moments are demonstrably working for developers.
- D-6 if the sizing harness (P0-007) shows 90 days of raw events costing materially more than the
  ~0.5 GB/year estimated in STORAGE §10.
