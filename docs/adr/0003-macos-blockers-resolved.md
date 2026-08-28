# ADR 0003 — macOS blockers resolved

- **Status:** accepted
- **Date:** 2026-08-28
- **Resolves:** ADR 0002 blockers B-1 … B-7

## D-22 — Accessibility is a required macOS permission (B-1)

REWIND uses the Accessibility API to read the active window's useful metadata, its title above all.
**Screen Recording is never requested** to work around this — it is the wrong ask for a product that
promises it takes no screenshots.

Onboarding must: explain why Accessibility is needed; state explicitly that REWIND takes no
screenshots; offer an `Enable Accessibility` call to action; detect granted/denied cleanly; and
support a degraded mode without the permission, while saying plainly that context reconstruction will
be far less accurate. The permission itself sits behind the macOS provider abstraction, not scattered
through the collectors.

## D-23 — Bundle identifier and signing (B-2)

Bundle id fixed now and never changed during development: **`com.danim.rewind`**. Bundle identifiers
routinely outlive product names, so encoding the codename is normal and costs nothing at rename time
— whereas changing the id later forfeits every TCC grant. Say so now if you want a different one;
after the first Accessibility grant it is expensive.

A stable development signing identity on the Mac as soon as practical. Notarisation and public
distribution are **not** blocking for the prototype; the Apple Developer Program is needed before real
distribution and before a production Safari integration. Golden sessions and the Context Engine are
never gated on notarisation.

## D-24 — Shared private Git remote (B-3) — done

`https://github.com/jodevweb/rewind` (private) is the shared source of truth. Windows and macOS both
push and pull branches; no custom synchronisation of any kind. The Mac becomes the primary validation
machine.

`.gitattributes` normalises to LF, so a file never appears modified purely because of the platform it
was checked out on — and so the golden fixture JSON stays byte-identical across machines, which the
`build:check` staleness gate depends on.

## D-25 — Chrome/Chromium first (B-4)

The browser collector is a Web Extension plus Native Messaging. Safari is deferred until after the MVP
is validated; the Xcode/Safari App Extension complexity is not taken on now.

`BrowserCollector` stays generic, so a `SafariCollector` can be added later without the Context Engine
changing at all.

## D-26 — Cockpit emits, REWIND does not scrape (B-6)

Cockpit emits `ExternalContextEvent`s itself, over the generic protocol from ADR 0002 D-17:
`mission.started`, `mission.updated`, `run.started`, `run.finished`, `agent.started`,
`agent.finished`, `worktree.created`, `worktree.changed`. No scraping where a clean integration is
possible.

## D-27 — Claude Code local sessions are the primary source (B-7)

`ClaudeCodeSessionProvider`, reading `~/.claude/projects/…`. The shell wrapper stays a possible
complementary source, not the main one.

```
ClaudeCodeSessionProvider → parser / version adapter → normalised ExternalContextEvents → Context Engine
```

The domain layer is never coupled to the exact JSONL format. The provider must tolerate new
properties, unknown properties, events it does not understand, and minor format changes. **An
unexpected JSONL line must never crash REWIND.**

### What the format actually looks like

Measured on this machine — 25 files, 45 911 lines, zero unparseable — rather than assumed:

**16 record types exist, and only about five matter:** `user`, `assistant`, `system`,
`file-history-delta`, `cost-state`. The other eleven (`atis-latch`, `bridge-session`, `mode`,
`ai-title`, `queue-operation`, `frame-link`, …) are internal bookkeeping. Two thirds of the format is
already stuff to ignore, and more will appear — which is precisely why tolerance is a requirement and
not a nicety.

**The metadata tier is far richer than expected.** Available without reading one line of prompt text:

| Field                                              | Value to REWIND                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                                              | Project path, on ~32 000 lines                                                                                                |
| `gitBranch`                                        | **The branch, on every event** — an anchor for free                                                                           |
| `sessionId`, `uuid`, `parentUuid`, `timestamp`     | Session identity and ordering                                                                                                 |
| `version`                                          | Claude Code version — what the version adapter keys on                                                                        |
| `isSidechain`                                      | Subagent versus main thread                                                                                                   |
| `aiTitle`                                          | Claude's own generated title for the session — a ready-made context label                                                     |
| `file-history-delta.trackingPath`                  | **Files touched, as a first-class record type** — "which files did Claude modify" answered without parsing a single tool call |
| `cost-state`                                       | `totalLinesAdded`, `totalLinesRemoved`, `totalToolDuration`, `modelUsage`                                                     |
| `toolUseResult`, `message.content[].tool_use.name` | Which tools ran, and how they ended                                                                                           |
| `system.durationMs`, `messageCount`                | Session shape                                                                                                                 |

That is nearly everything ADR 0002 D-18 asks for — what was Claude working on, what did it try, which
files did it touch, where did it stop — with no prompt text at all.

### The privacy consequence: allowlist, never blocklist

The same files carry `lastPrompt`, `message.content`, `attachment` (~5 800 records of pasted content
and images), `queue-operation.content` and `compactMetadata`. These hold raw user prompts and file
contents.

**So the provider extracts an explicit allowlist of fields and never walks the object.** A blocklist
would leak the first time a new content-bearing field appears — and given that eleven of sixteen
record types are already ones we ignore, new fields appearing is the normal case, not the exception.

## D-28 — MDM is not a blocker (B-5)

Not treated as a blocker until the machine is confirmed managed. A clear diagnostic when Accessibility
cannot be granted is enough.

## Immediate order

1. ✅ Shared private Git remote.
2. Clone and validate on macOS.
3. Stabilise bundle id and development identity.
4. macOS Accessibility prototype: active app, bundle id, window title, timestamps.
5. Replay those events into the existing timeline.
6. Confirm golden sessions can be fed with real macOS events.
7. Then Chrome Native Messaging.
8. Then the Claude Code session provider.
9. Then Cockpit external events.

The next real milestone is **macOS real activity → normalised events → contexts**. Not Safari, not
public distribution, not full notarisation.
