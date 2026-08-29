# ADR 0002 — Work-context-first, macOS-first

- **Status:** accepted
- **Date:** 2026-08-28
- **Supersedes:** ADR 0001 **D-1** (Windows-first) and **D-7** (developer-first)
- **Leaves intact:** every other decision in ADR 0001, and all of PRIVACY, SECURITY, STORAGE, SEARCH,
  AI and TESTING

## Context

The primary professional machine is a **Mac**, and the daily workflow barely touches a traditional
IDE. Real work crosses Claude Code in the Terminal, Cockpit (a personal agent-orchestration app), the
browser, Linear, Figma, Slack, Mail, Notes, Finder and Git worktrees. Windows remains the personal
machine and a future platform, but it is not where the product's daily value can be validated.

Two MVP assumptions were therefore wrong: the platform, and the wedge.

## Decisions

### D-11 — macOS-first (supersedes D-1)

The MVP targets macOS. Windows becomes an important future platform, not the first one.

This does **not** weaken the cross-platform architecture — it strengthens the reason for it. Every OS
interaction stays behind a provider interface, and the domain layer stays platform-agnostic:

| Provider                   | macOS                                                           | Windows (retained, future)       |
| -------------------------- | --------------------------------------------------------------- | -------------------------------- |
| `ActiveWindowProvider`     | `NSWorkspace` activation notifications + AX observer for titles | `SetWinEventHook`                |
| `ProcessProvider`          | `NSRunningApplication`, bundle identifier                       | `QueryFullProcessImageName`      |
| `IdleProvider`             | `CGEventSourceSecondsSinceLastEventType`                        | `GetLastInputInfo`               |
| `LockStateProvider`        | `NSDistributedNotificationCenter` screen lock/unlock            | `WTSRegisterSessionNotification` |
| `PowerProvider`            | `NSWorkspace` sleep/wake                                        | `WM_POWERBROADCAST`              |
| `ApplicationLauncher`      | `NSWorkspace.open`, URL schemes, CLI                            | `ShellExecuteEx`                 |
| `SecureStorageProvider`    | Keychain                                                        | Credential Manager               |
| `ShellIntegrationProvider` | zsh `preexec`/`precmd`                                          | PowerShell profile               |

No Windows work is destroyed. The Windows implementations already specified stay in the plan behind
these interfaces; they simply stop being first.

**Bundle identifier replaces executable name** as the stable application identity. It is the better
primitive on both platforms and it is what Level 1 observation keys on.

### D-12 — Work-context-first (supersedes D-7)

REWIND is **not** developer-first.

> **North Star:** REWIND understands what you are working on, even when your work crosses multiple
> applications.

Software development is an excellent use case and one context type among several. Claude Code and
Cockpit are extremely rich sources, but they do not define the product. Administrative work,
communication-heavy work and design work are first-class.

The unit of the product is the **context**, never the application.

### D-13 — Two-level collection architecture

**Level 1 — generic application observation.** Useful with no per-application connector at all. For
any macOS application: active application, bundle identifier, window title, activation and
deactivation timestamps, and window or document metadata where it is cleanly available.

```
app:    Figma
window: Checkout Redesign V3
```

That is already exploitable by the Context Engine, and it is the foundation.

**Level 2 — rich integrations.** Specific applications later provide structured detail: Linear an
issue id, project and status; Claude Code a session, tools, files, commands, errors and unfinished
work; Cockpit a mission, agent, run and worktree.

**The MVP must prove that Level 1 plus temporal and semantic reasoning already reconstructs a
meaningful share of contexts.** Rich integrations then raise precision. Explicitly **not** building
now: full Slack, Mail, Figma, Notes or Linear integrations.

### D-14 — Context Anchors, first-class

The Context Engine's grouping features were 76 % developer-specific (ticket 0.28 + branch 0.18 +
files 0.16 + repo 0.14). For GS-09 — pure administrative work — **none of them fire.** That is a
structural defect under D-12, not a tuning problem.

They are replaced by a generic concept:

```
Anchor
  type            issue | project | repository | branch | worktree | document | url | keyword
  value           "ACM-4218"
  normalizedValue "acm-4218"
  confidence      0..1
  source          window_title | url | branch | agent | external | note
```

Anchors are extracted from window titles, browser titles, URLs, terminal commands, Git branches,
worktrees, Claude sessions and Cockpit events. The same anchor appearing across applications is the
strongest available grouping signal:

```
Linear:       ACM-4218
Git branch:   fix/ACM-4218-generation
Cockpit:      ACM-4218
Browser:      linear.app/.../ACM-4218
→ very probably one context
```

Anchors **influence** grouping strongly; they are never absolute rules.

### D-15 — Application switching is not context switching

```
Slack → Linear → Figma → Terminal      may be ONE context
Chrome → Chrome                        may be TWO
```

The application is never the primary segmentation primitive. This is now measured: a
`per-application` baseline scores **ARI −0.003** across the golden set — worse than chance.

### D-16 — REWIND is not a time tracker

Forbidden as a primary surface:

```
Slack: 43 min   Chrome: 1h12   Terminal: 2h03   Figma: 27 min
```

Per-application durations may exist internally. The interface presents contexts and the applications
they crossed:

```
Checkout Redesign V3    1h47   Slack → Linear → Figma → Cockpit → Claude
Sideproject           52m   Browser → Finder → Cockpit → Terminal
Team organisation    31m   Slack → Linear → Notes
```

This extends ADR 0001 D-5 (no productivity scores) rather than replacing it.

### D-17 — Generic external event protocol

Cockpit is the first consumer, not the coupling. REWIND defines an `ExternalContextEvent` protocol
that any authorised local application can emit:

```
mission.started   mission.updated
agent.started     agent.finished
run.started       run.finished
worktree.created  worktree.changed
context.metadata
```

Transport obeys ADR 0001 D-5 unchanged: **no localhost HTTP**, Unix domain socket on macOS with a
paired token, write-only. REWIND never links against Cockpit's internals.

### D-18 — Claude Code stays a first-class integration

Even though REWIND is no longer developer-first. In this workflow most code is delegated rather than
written, so the target questions are about the agent:

> What was Claude working on? · What did Claude already try? · Where did this session stop? · Which
> approach failed? · Which files did Claude modify? · Which context was this session related to? ·
> Resume the work Claude was doing yesterday.

This raises the ceiling on what an agent collector may capture compared with ADR 0001 D-8's
metadata-only stance — but any content capture remains separately opt-in with its own disclosure
(PRIVACY PVR-6).

### D-19 — Revised source priority

| Priority | Source                                        | Note                         |
| -------- | --------------------------------------------- | ---------------------------- |
| P0       | macOS application and window observation      | The indispensable foundation |
| P1       | Browser — URLs, titles, meaningful navigation |                              |
| P2       | Claude Code / Terminal                        | Very rich in this workflow   |
| P3       | Cockpit, over the D-17 protocol               | Rich and workflow-specific   |
| P4       | Git and worktrees                             | Enriches technical contexts  |
| P5       | Rich integrations — Linear first              | Precision, not foundation    |

The IDE collector drops out of the MVP critical path. It is not deleted — it is reprioritised.

### D-20 — Metadata first, everywhere sensitive

Mail, Notes, Slack and Finder can contain extremely sensitive material. Level 1 captures window and
document _metadata_ only:

- **Notes** — the note title, never its content.
- **Mail** — subject or window metadata where safely available, never the body or the mailbox.
- **Slack** — channel or window metadata, never message content.
- **Finder** — window title, active directory when cleanly available, selected-file metadata only
  within the privacy model. **Never an arbitrary filesystem scan.**

Deeper reading of any of these is a separately consented integration. The governing principle:
**collect less, understand better.**

### D-21 — The MVP test changes

No longer _can REWIND reconstruct a coding session?_ but:

> **Can REWIND reconstruct my actual workday?**

Use the Mac normally for several hours, open REWIND, and see something resembling the real perception
of the day — contexts, not applications. Names, groupings and durations will not be right at first;
they must be _recognisable_.

The ultimate test is unchanged: after an interruption, can REWIND restore enough context to resume
immediately?

## What does not change

Local-first · privacy-first · event-first · no keylogger · screenshots not central · SQLite ·
Context Engine · Context Graph · hybrid search · provenance · Resume · Ask · retention and compaction
· secret redaction · no localhost HTTP · the collector architecture · golden sessions · the
evaluation harness · the Fake Collector · a Rust core · cross-platform abstractions · eventual
Windows support.

The six developer golden sessions are **kept** — they remain valid scenarios. Four cross-application
fixtures are added alongside them.

## Consequences

- The Context Engine feature vector is rebuilt around anchors. Stage A's hard boundary on
  `projectId`, and sessionisation's "sustained project switch", are both wrong under D-12 and are
  replaced (CONTEXT_ENGINE §2–4).
- The golden set grows from 6 fixtures / 288 events to 10 / 383, and from 10 ground-truth contexts to 15.
- `EventSource` gains `external`. `TimelineEvent` and `Activity` gain `anchors`.
- Phase 4 (IDE) leaves the critical path; a macOS Level 1 collector takes P0.
- Windows implementation work is deferred, not discarded.

## Open blockers — these need answers before Phase 1 on macOS

| #   | Blocker                            | Why it blocks                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | **Accessibility (TCC) permission** | Window titles on macOS require either the Accessibility API or Screen Recording. Without titles, Level 1 is worthless — "Figma" alone carries no context, "Figma — Checkout Redesign V3" carries all of it. Screen Recording is the wrong ask for a product that promises no screenshots, so Accessibility it is: a TCC prompt in onboarding, and a hard dependency of the whole pivot |
| B-2 | **Code signing identity**          | TCC grants bind to bundle id + signature. An ad-hoc signed dev build loses its Accessibility grant on rebuild and re-prompts, which makes the daily dev loop painful. Needs a stable signing identity early, and an Apple Developer account for notarisation                                                                                                                           |
| B-3 | **Where development happens**      | The Mac is the only machine where this can be validated, and the repository currently lives on the Windows machine. A shared remote is needed before Phase 1                                                                                                                                                                                                                           |
| B-4 | **Which browser**                  | Chrome and Safari are entirely different collector projects — Safari needs a signed app extension bundled in the host app. This changes P1 substantially                                                                                                                                                                                                                               |
| B-5 | **Is the Mac MDM-managed?**        | A managed device can pre-deny TCC prompts, which would block B-1 outright                                                                                                                                                                                                                                                                                                              |
| B-6 | **Cockpit emitter ownership**      | REWIND can define the D-17 protocol, but Cockpit has to emit it. Confirmation needed that Cockpit will add the emitter                                                                                                                                                                                                                                                                 |
| B-7 | **Claude Code session access**     | Two routes: parse local session files (rich, undocumented, fragile across versions) or wrap via shell integration (stable, much poorer). D-18 raises the stakes on getting this right                                                                                                                                                                                                  |
