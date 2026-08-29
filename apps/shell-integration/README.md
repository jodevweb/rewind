# @rewind/shell-integration

Opt-in zsh / bash / PowerShell hooks. They record **which command you ran, whether it worked, how
long it took and where** — and nothing else.

```sh
sh apps/shell-integration/install.sh          # zsh or bash, detected from $SHELL
pwsh -File apps/shell-integration/install.ps1 # PowerShell
```

Both add one line to your profile and are safe to run twice. Uninstalling is deleting that line.

## Why this is worth a hook in your prompt

Window titles say a terminal was focused. They cannot say that `pnpm check` failed at 18:40, and
that is the single most useful thing REWIND can tell you the next morning — it is the one thing you
never write down, and the thing you spend the first ten minutes of the day rediscovering.

With this installed, `fix_failing_command` — the next step REWIND suggests — starts firing on work
you did outside an agent.

## What is recorded

| Recorded              | Never recorded                              |
| --------------------- | ------------------------------------------- |
| The command line      | Its output, on success or on failure        |
| The exit code         | Anything you typed that was not a command   |
| How long it ran       | Environment variables                       |
| The working directory | Keystrokes — there is no keyboard hook here |

Secrets in a command line are masked by REWIND's redaction registry before storage, fail-closed: a
command whose secrets cannot be masked is **dropped**, not stored.

## How it reaches REWIND

One small file per command, written into REWIND's own data directory, which REWIND deletes as it
reads it — usually within two seconds. No port, no socket, no network, and nothing is ever read back
into your shell. This is the same rule as every other collector: write-only, one direction (ADR 0001
D-5).

The hook writes nothing unless REWIND is running. The daemon stamps a heartbeat file every two
seconds, and the hook checks it with a shell builtin — no subprocess, so your prompt does not get
slower. Close REWIND and the collection stops here, at the source, rather than piling up command
lines in a directory nothing is reading.

## Known limitation in bash

zsh and PowerShell both hand the hook the whole command line. bash has no equivalent, so the hook
uses the `DEBUG` trap, which fires once per simple command: `a | b` is recorded as `a`. It is an
approximation, and it is written down rather than hidden. zsh is the accurate one.
