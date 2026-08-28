# Contributing to REWIND

## Prerequisites

### TypeScript side (works today)

- Node 22+
- pnpm 10+

```bash
pnpm install
pnpm check
```

### Rust side — required for the desktop app

Both macOS and Windows are shipped targets (ADR 0004 D-29).

**macOS**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
xcode-select --install     # Command Line Tools, if not already present
pnpm dev                   # builds and launches REWIND
```

**Windows**

```powershell
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools"
# WebView2 ships with Windows 11.
pnpm dev
```

**Known blocker — Windows Smart App Control.** If `rustc` fails with
`os error 4551` ("a policy has blocked this file"), Smart App Control is enforcing and refuses the
unsigned `rustc.exe`. Turning it off is **irreversible** — Windows will not let you re-enable it
without reinstalling. Options, in order of preference:

1. Build on macOS and let CI produce the Windows binary (CI compiles both on every push).
2. Sign the toolchain, or use a machine without Smart App Control.
3. Turn it off, knowing it cannot be turned back on.

This affects the _toolchain_, not the product: the shipped installer is signed, so Smart App Control
accepts REWIND itself.

---

## The rules that are not negotiable

These come from the design documents and are enforced in CI. A change that violates one is not a
trade-off discussion; it is a defect.

1. **No keystroke capture, no clipboard reading, no screen capture.** `pnpm check:forbidden-apis`
   fails the build if the APIs appear anywhere (PRIVACY.md §2).
2. **Nothing is persisted without passing redaction.** The redactor fails closed: on error the event
   is dropped, never stored (PRIVACY.md §4.2).
3. **Collectors never write to the database or the UI.** They emit to the normaliser only
   (ARCHITECTURE.md §18).
4. **Every collector ships its privacy record before it merges** — what, why, where stored, how
   deleted, can it contain secrets (COLLECTORS.md §9).
5. **New collectors ship disabled by default** and are announced in release notes (PRIVACY.md §13).
6. **No LLM in the deterministic path.** Resume facts, privacy decisions and deletion are never
   model-driven (AI.md §8).
7. **Every answer carries evidence.** A summary with an empty evidence list is invalid (EVENT_MODEL.md
   §8).
8. **The event schema is defined once**, in `packages/protocol`. Hand-written duplicates of generated
   types are review-blocking.

---

## Before opening a PR

```bash
pnpm check
```

And, if the change touches:

| Area                    | Also required                                                                |
| ----------------------- | ---------------------------------------------------------------------------- |
| A collector             | Privacy record filled in; fixtures extended; ships disabled                  |
| Redaction patterns      | Positive **and** negative fixtures; the negative ones matter as much         |
| The context engine      | Golden sessions still pass; a weight change is validated against all of them |
| Search ranking          | `eval search` run; a regression beyond 3 points blocks the merge             |
| Anything calling an LLM | Prompt versioned in `packages/protocol/prompts`, output schema-validated     |
| Data lifecycle          | Retention, deletion and export behaviour defined and tested                  |

---

## Decisions

A change that deviates from the design documents needs an ADR in `docs/adr/`, using
`0000-template.md`. Documents are the design; code that silently disagrees with them is a bug in one
or the other, and the ADR is how we decide which.

---

## Testing philosophy

Three areas are release-blocking because a failure in them is unrecoverable (TESTING.md §11):

- **Privacy** — a leaked secret cannot be un-leaked.
- **Context quality** — wrong grouping degrades the product invisibly; nothing errors.
- **Answer honesty** — a confident wrong answer costs more than no answer.

Everything else gets proportionate coverage. Notably, the redaction suite asserts that _the raw
secret string is absent from the output_, not that a field "looks masked" — the second assertion can
be satisfied by a partially-correct implementation, and the first cannot.
