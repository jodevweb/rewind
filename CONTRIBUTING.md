# Contributing to REWIND

## Prerequisites

### TypeScript side (works today)

- Node 22+
- pnpm 10+

```bash
pnpm install
pnpm check
```

### Rust side (ticket P1-000 — required before Phase 1)

Not yet installed on the primary development machine. Needed for the Tauri daemon:

**Windows**

1. **Rust (MSVC toolchain)** — https://rustup.rs
   ```
   rustup default stable-x86_64-pc-windows-msvc
   ```
2. **Visual Studio C++ Build Tools** — the "Desktop development with C++" workload. Multi-gigabyte
   download; budget the time.
3. **WebView2** — already present on Windows 11. Verify before assuming.

Verify:

```bash
cargo --version
rustc --version
```

**macOS** (Phase 13, when the OS traits get a second implementation): Rust stable + Xcode Command
Line Tools.

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
