# ADR 0005 — Autonomous capture: no APIs, no configuration

- **Status:** accepted
- **Date:** 2026-08-28
- **Amends:** ADR 0002 **D-13** (Level 2 "rich integrations"), **D-19** (source priority P5), and
  ADR 0003 **D-26** (Cockpit)
- **Leaves intact:** the no-keylogger rule (§8), no screenshots (§111), metadata-first (D-20)

## Context

Level 1 — application, bundle identifier, window title — is too thin, and the user said so with a
concrete example. Opening Slack yields:

```
0-pull-requests (canal) - Acme - Slack
```

We know a channel was on screen. We do not know a message was written, to whom, or why. As a record
of the day that is barely better than a list of applications.

ADR 0002 D-13 answered this with "Level 2 rich integrations" and named Linear as the first. That
answer assumed connecting accounts. **It is rejected:** REWIND must be autonomous — no API
connection, no OAuth, no per-application setup, nothing to configure. It observes the machine and it
works.

That removes an option and forces a better question: what depth can be reached _without_ asking the
user for anything, and without becoming the thing the product promised never to be?

## The three depths, and where the line is

| Depth                           | For the Slack example                                        | Cost                                     |
| ------------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Window title (today)            | `Slack · #0-pull-requests`                                   | None                                     |
| **Semantic action, no content** | `message sent in #0-pull-requests at 14:32`, `thread opened` | Low — same permission, no text ever read |
| Content                         | The message text itself                                      | **Keylogger-equivalent**                 |

The third is technically available. With the Accessibility permission REWIND already requires, any
application's UI tree can be read: text fields, static text, selection. That is how screen readers
work.

**And that is exactly where the line is.** Reading a text field while the user types is functionally
a keylogger even without a keyboard hook. §8 bans the _outcome_, not the API. Crossing it would make
the product's central promise false, and no amount of usefulness buys that back.

## Decisions

### D-33 — No API connections, ever, as a product property

REWIND connects to no external service to obtain data about the user's work. No OAuth, no account
linking, no API keys, no per-application setup. It observes the machine.

This is not merely a default — it is what the product _is_. "Autonomous" is a feature, and it is the
reason REWIND can work for an application nobody has written a connector for.

Consequences: the Linear/Slack/Mail integrations named as P5 in D-19 are **removed** from the plan.
They are not deferred; they are not the product.

### D-34 — Level 1.5: semantic actions without content

The new middle tier, and the one that carries the depth D-13 expected from integrations.

Using the Accessibility permission already required, REWIND observes accessibility _notifications_ to
recognise that an action happened, and records the action and its container — never the content.

| Observed                                         | Recorded                                       |
| ------------------------------------------------ | ---------------------------------------------- |
| A composer field emptied and a list gained a row | `message sent` + channel from the window title |
| Focus moved into a text field                    | `composing` (start of writing)                 |
| A list's row count grew while unfocused          | `messages received`                            |
| A document's title changed                       | `document switched`                            |
| A row was selected in a list                     | `item opened`                                  |

For the example: `message envoyé dans #0-pull-requests à 14:32`, attached to whatever context was
active. That is the signal the Context Engine needs — the _action_, not the prose.

**Generic patterns, not per-application scraping.** The rules above are expressed against accessibility
roles (`AXTextField`, `AXTextArea`, `AXTable`, `AXWebArea`) rather than against Slack's particular
tree. Per-application selectors would break with every update; role-level patterns work for
applications nobody has thought about, which is what D-33 requires.

### D-35 — The safeguard is structural, not a policy

The rule is not "do not store the text". The rule is **never read it**:

- REWIND never calls `AXValue`, `AXSelectedText`, `AXSelectedTextRange` or `AXTitle` on an element
  whose role is a text field, text area or web area.
- It observes that `AXValueChanged` fired. It does not ask what the value became.
- Window titles remain readable — they are `AXTitle` on a window, not on a text element, and they
  are already redacted (PRIVACY §3.3).

Enforced the same way the no-keylogger promise is: **a build gate**. The forbidden-API check gains
these accessors, so a call to them fails CI. A promise enforced only by review is a promise that
erodes.

This is what makes D-34 defensible. The difference between "we choose not to store it" and "the code
that could read it does not exist" is the whole difference.

### D-36 — Cockpit and Claude Code are unaffected

D-33 forbids _external_ API connections. It does not forbid:

- **Claude Code** — local session files on disk (ADR 0003 D-27). No connection, no configuration, no
  account. Already autonomous.
- **Cockpit** — emits `ExternalContextEvent`s to a local socket (ADR 0002 D-17). Nothing to
  configure on the user's side; the application simply speaks the protocol. Any local application may
  do the same.

Both stay. They are the two deepest sources in this workflow and they are already autonomous, which
is precisely why they survive a rule that removes Slack's API.

### D-37 — Revised source priority

Replacing D-19's list:

| Priority | Source                                       | Depth               |
| -------- | -------------------------------------------- | ------------------- |
| P0       | Application and window observation           | Level 1             |
| P1       | **Semantic actions via accessibility**       | Level 1.5           |
| P2       | Claude Code local sessions                   | Deep, autonomous    |
| P3       | Cockpit external events                      | Deep, autonomous    |
| P4       | Browser extension — URLs, titles, navigation | Level 1 for the web |
| P5       | Git and worktrees                            | Deep, autonomous    |

Nothing in this list asks the user to connect anything.

## Consequences

- One Accessibility permission on macOS unlocks both Level 1 and Level 1.5. There is no second ask,
  which is what makes "no configuration" real rather than aspirational.
- Windows needs UI Automation for the equivalent of Level 1.5. It is a different API with the same
  shape and the same safeguard, and it needs no permission at all (ADR 0004 D-31).
- Level 1.5 events are a new event family in EVENT_MODEL, and a new row in the PRIVACY §15 collector
  table before any of it is written (§157).
- Attribution gets weaker without content: we will know a message was sent in `#0-pull-requests` and
  rely on the channel name, the timing and the surrounding anchors to attach it to a context. Often
  enough; sometimes not. That is the price of the line, and it is the right price.

## What would make us revisit

If Level 1.5 turns out not to lift context quality measurably on the golden benchmark, the answer is
**not** to reach for content. It is that the window-title signal was already carrying most of what
accessibility could add, and the effort belongs somewhere else entirely.
