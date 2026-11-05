# @rewind/mcp

**Your own history, readable by the agent you actually work in.**

REWIND knows what you were doing on Thursday. Claude Code does not — so every session begins with you
explaining the branch, the failing command and the three files. That explaining is the retyping
REWIND exists to remove, and this is what removes it: the agent asks.

## Install

REWIND has to have captured something first — open it once and use your machine normally.

```sh
claude mcp add rewind -- pnpm --dir /path/to/rewind --filter @rewind/mcp start
```

Then, in any session:

> "ask rewind what I was working on yesterday"

## The five tools

| Tool             | Answers                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `rewind_resume`  | Where you left off: context, branch, files, commands, failures, next step |
| `rewind_ask`     | A plain-language question, in French or English, over your own events     |
| `rewind_day`     | Every piece of work of one day, with what came out of it                  |
| `rewind_standup` | The same day, one line per piece of work                                  |
| `rewind_days`    | Which days there is anything to ask about                                 |

## What it does not do

- **It cannot write.** The database is opened read-only. The daemon stays the only writer of its own
  store, and an event written by anything but a collector would have no redaction stamp anyway.
- **It does not listen on anything.** stdio, spoken to by the client that launched it. No port, no
  socket, no network — the rule that removed the localhost HTTP server (ADR 0001 D-5).
- **It does not generate.** Every answer is assembled from stored events. When Ask has too little
  evidence it refuses, and the refusal is passed through as a refusal: the tool description tells the
  model, in as many words, not to complete it with a guess.

It reads events, which are already redacted — it cannot reach anything the collectors kept out.

## Development

```sh
pnpm --filter @rewind/mcp test    # the protocol and the tools, against a real SQLite store
REWIND_DB=/path/to/rewind.db pnpm --filter @rewind/mcp start
```

The protocol is hand-written — one framing rule and five methods, in `src/server.ts`. An SDK for
that would be a dependency tree in a repository with no runtime dependencies, on the one process
that reads your entire history.
