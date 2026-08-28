# REWIND — AI Layer

> Where models are used, where they are deliberately not, and the rules that keep answers honest.

---

## 1. The governing rule (§155)

> Before using an LLM, ask: does a deterministic rule or an embedding suffice?

Applied concretely across the product:

| Task                  | Deterministic             | Embedding             | LLM                                 |
| --------------------- | ------------------------- | --------------------- | ----------------------------------- |
| Activity grouping     | ✅ always                 | —                     | never                               |
| Session boundaries    | ✅ always                 | —                     | never                               |
| Activity labels       | ✅ always                 | —                     | never                               |
| Context assignment    | ✅ primary                | ✅ one feature of six | only in the ambiguous band          |
| Context naming        | ✅ primary                | —                     | optional improvement, user-accepted |
| Importance scoring    | ✅ always                 | —                     | never                               |
| Search recall         | ✅ FTS                    | ✅ vectors            | never                               |
| Search ranking        | ✅ always                 | ✅ one feature        | never                               |
| Intent classification | ✅ primary                | —                     | optional fallback                   |
| Resume facts          | ✅ always                 | —                     | **never**                           |
| Resume prose          | —                         | —                     | optional, on top of facts           |
| Context summaries     | ✅ template               | —                     | optional improvement                |
| Decision extraction   | ✅ from notes and commits | —                     | optional, as unconfirmed proposals  |
| Ask answers           | ✅ structured results     | ✅ recall             | optional prose with citations       |

Every row where an LLM appears is optional. **The product is fully functional with no model configured**
— that is the acceptance criterion for PR-2, not an aspiration.

---

## 2. Provider abstraction (§33, §34)

```rust
pub trait EmbeddingProvider: Send + Sync {
    fn id(&self) -> &str;
    fn dims(&self) -> usize;
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    fn is_local(&self) -> bool;
}

pub trait LlmProvider: Send + Sync {
    fn id(&self) -> &str;
    fn complete(&self, req: PromptRequest) -> Result<StructuredResponse>;
    fn is_local(&self) -> bool;
    fn describe_payload(&self, req: &PromptRequest) -> PayloadDisclosure;
}
```

`describe_payload` is part of the trait, not a UI convenience: a provider cannot be added without also
being able to state exactly what it will transmit (PRIVACY §8.3).

### Embeddings

| Provider                                      | Default | Notes                                         |
| --------------------------------------------- | ------- | --------------------------------------------- |
| **Local ONNX** (`bge-small-en-v1.5`, 384-dim) | ✅      | Downloaded on first use, never bundled (TR-6) |
| OpenAI `text-embedding-3-small`               | opt-in  | Requires the full disclosure flow             |
| Any OpenAI-compatible local server            | opt-in  | Ollama, LM Studio                             |

Changing the embedding provider changes vector dimensionality, so it triggers a full re-embed job with a
warning about the cost. Provider id and dimensions are stored alongside every vector so mixed-dimension
data can never be compared.

### LLMs

| Provider                                                      | Default                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| **None**                                                      | ✅ (PRIVACY §8.1)                                         |
| Anthropic                                                     | opt-in                                                    |
| OpenAI                                                        | opt-in                                                    |
| OpenAI-compatible local (Ollama, LM Studio, llama.cpp server) | opt-in, no disclosure needed — nothing leaves the machine |

---

## 3. Prompts as versioned artefacts (§131)

No prompt string appears inline in Rust or TypeScript. All prompts live in
`packages/protocol/prompts/<name>/v<N>.yaml`:

```yaml
id: context.summarise
version: 3
description: Summarise a context into prose plus a likely next step.
output_schema: schemas/context_summary.json
max_input_items: 40
max_input_tokens: 6000
allowed_privacy_levels: [normal] # 'sensitive' requires per-request confirmation
system: |
  You summarise a developer's work session from structured facts.
  Use only the facts provided. Never infer a cause that is not evidenced.
  If the facts are insufficient, say so and set insufficientEvidence.
user: |
  {{#each facts}}- [{{id}}] {{timestamp}} {{kind}}: {{text}}
  {{/each}}
```

Properties this buys: prompts are diffable and reviewable; `promptVersion` is stored on every generated
summary, so a bad prompt version can be found and regenerated; prompts are testable offline via
`rewind-cli eval prompts`; and `allowed_privacy_levels` is enforced by the code that loads the prompt,
not by the prompt's own wording.

---

## 4. Structured output only (§132)

Every LLM call declares an output schema and every response is validated before use.

```json
{
  "answer": "string",
  "confidence": "high|medium|low",
  "citations": [{ "evidenceId": "string", "label": "string", "timestamp": 0 }],
  "insufficientEvidence": false
}
```

Validation rules, enforced in code:

1. The response must parse and match the schema. A partial parse is never attempted.
2. Every `evidenceId` must have been present in the input. Fabricated IDs invalidate the entire response.
3. If `insufficientEvidence` is `false`, `citations` must be non-empty.
4. On any failure: log, discard, fall back to the deterministic answer. Never retry more than once, and
   never show an unvalidated response.

Providers that support native structured output (tool use / JSON schema mode) use it; others get a
strict format instruction plus the same validation. Validation is the guarantee — the provider feature is
just an optimisation.

---

## 5. Sanitisation before any external call (§35)

```
candidate items
  → drop privacyLevel: private                       (never sent, never described)
  → drop anything from excluded apps / domains / paths
  → require explicit confirmation for privacyLevel: sensitive
  → secret redaction (independent pass, not trusting upstream)
  → configurable PII filters (emails, phone numbers, personal names in titles)
  → budget selection: max_input_items, max_input_tokens from the prompt manifest
  → disclosure
  → send
  → redact the response before persisting it                     ← PVR-1
```

The last step is the one that is easy to forget and matters most: summaries live forever (PRIVACY §9), so
a model that restates something sensitive would create a _longer-lived_ copy than the event it came from.

---

## 6. Disclosure and receipts

Before the first send to a given provider, and on every send unless the user opts out per provider:

```
This request will send 14 items to Anthropic.
  8 event titles · 3 file paths · 2 commit messages · 1 context summary
  6 values were redacted before sending.
  [ Show exact payload ]   [ Cancel ]   [ Send ]
```

Generated from the serialised bytes, not estimated. Every send is recorded permanently in `ai_sends`
(timestamp, provider, model, prompt id and version, item count, byte count, redaction count) and shown in
the data inspector (PRIVACY §12). The receipt log is what makes the disclosure verifiable after the fact.

---

## 7. Cost and efficiency (§129)

Rules that keep both cost and latency bounded:

- **Never one call per event.** Events are aggregated into activities, activities into contexts; only
  context-level artefacts are ever summarised.
- **Batch.** Summarisation runs on context dormancy, batched across contexts.
- **Cache by content hash.** Re-summarising an unchanged context is a cache hit; a context is only
  re-summarised when its activity set changes materially (>20 % new evidence).
- **Compress input.** Facts are sent as compact structured lines, not raw JSON events. A typical context
  summary is under 2 000 input tokens.
- **Budget caps.** Per-prompt item and token caps in the manifest; a hard daily spend cap in config,
  after which LLM features degrade to deterministic mode with a notice.

Expected steady-state usage with an LLM configured: roughly 5–15 summarisation calls a day, plus one per
Ask query. That is small enough that the cost objection never becomes a reason to abandon local-first.

---

## 8. Where LLMs are forbidden

Not "discouraged" — forbidden, and enforced by code review and architecture:

- **Resume facts.** Files, commands, exit codes, commits and timestamps come from the database only
  (PR-2). A model may add prose _above_ them; it may never produce them.
- **The privacy path.** Redaction and exclusion decisions are never made by a model. A regex that misses
  is a bug; a model that misses is unpredictable.
- **Deletion.** No model is ever in the loop on what to delete.
- **Deciding what to capture.** Capture is governed by explicit rules only.
- **Promoting a guess to a fact.** LLM-extracted decisions stay `userConfirmed: false` until a human
  confirms (EVENT_MODEL §10).

---

## 9. Confidence and hallucination policy (§78, §79, §133)

Confidence is shown in words, never as false precision: **high / medium / low**.

For causal claims ("you changed this because…"), REWIND requires at least two independent evidence
sources. With one, it states the single fact and does not assert causation. With none, it refuses:

```
I couldn't find enough evidence to answer that.
```

REWIND never invents a reason, a decision, a task, or a person. Tested with an adversarial suite asking
about work that never happened; a fabricated answer is a release-blocking bug, not a quality issue.

---

## 10. Evaluation

| Suite              | What it checks                                      | Blocking      |
| ------------------ | --------------------------------------------------- | ------------- |
| `eval prompts`     | Prompt outputs against golden fixtures, per version | No — reported |
| `eval search`      | Retrieval quality (§127)                            | Yes           |
| `eval adversarial` | Refusal behaviour on unanswerable questions         | Yes           |
| `eval citations`   | Every citation resolves to real evidence            | Yes           |
| `eval redaction`   | The §126 corpus, including on model output          | Yes           |

Prompt evaluation is non-blocking because model outputs vary; the _guarantees_ — citations resolve,
refusals happen, secrets never leave — are all deterministic checks, and those block.

---

## 11. Local model future (§130)

The architecture supports it today: both traits already have local implementations, prompts are
provider-agnostic, and validation does not depend on provider features. When a local model is configured,
sections §5 and §6 still run — the sanitisation pipeline protects the _database_, not only the network —
but no disclosure is required, because nothing leaves the machine.

The eventual goal is that the full experience runs with zero network access. Embeddings already do.
