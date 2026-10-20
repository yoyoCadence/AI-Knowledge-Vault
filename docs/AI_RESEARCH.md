# AI Research & Knowledge Intelligence (Phase 2–3 design)

Status: **design only. Nothing in this document is implemented yet.** The core library works
without any AI provider (P-2).

## 1. Provider abstraction (`src/modules/ai`, Phase 2)

```ts
interface AIProvider {
  id: string; // 'anthropic' | 'openai' | 'google' | 'openai-compatible:<name>'
  capabilities(model: string): ModelCapabilities; // { text, structuredOutput, embeddings, maxContextTokens, maxOutputTokens, toolUse }
  generateText(req: GenerateTextRequest): Promise<GenerateTextResult>; // includes usage
  structuredOutput<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>; // JSON-schema validated (Zod) + repair-once
  embeddings?(req: EmbeddingsRequest): Promise<EmbeddingsResult>; // optional capability
  estimateCost(usage: TokenUsage, model: string): CostEstimate; // table-driven, versioned price list
}
```

Rules:

- The `knowledge` module depends on `AIProvider`, never on a vendor SDK.
- A missing capability is a typed error, `CapabilityNotSupported`. Callers pick a fallback
  (for example, structured output emulated by JSON mode plus validation) or disable the
  feature in the UI.
- API keys come from server env or a secret manager only. The `ai_providers` table stores
  configuration and enabled state, never keys.
- With no provider configured, the AI pages show "not configured". No fake output is ever
  produced.

## 2. RAG question answering

1. Receive the question and resolve the `Actor`.
2. **Permission filter:** the workspace scope, excluding `deleted_at` rows. Apply the
   sensitivity policy: `restricted` is never sent externally unless the user explicitly opts
   in per request; `sensitive` requires a workspace setting.
3. **Retrieval:** hybrid search (SEARCH_DESIGN §8) over `content_chunks`. Take the top-k, then
   diversify by artifact (maximal marginal relevance).
4. **Evidence assembly:** chunks are wrapped in delimited, labelled blocks:
   ```
   <evidence id="E3" artifact="…" version="3" section="§2.1 …" source_type="ai_generated_report" trust="untrusted">
   …chunk text…
   </evidence>
   ```
   The context budget is `min(model.maxContext × 0.6, AI_MAX_CONTEXT_TOKENS)`. Lowest-ranked
   chunks are dropped first.
5. **Generation:** the system prompt states that evidence blocks are data, not instructions,
   and that the answer must cite evidence IDs and must say "insufficient evidence" when the
   evidence does not support an answer.
6. **Citation verification** (deterministic, after generation):
   - Every cited `E#` must exist.
   - Every quoted span must be found verbatim (after normalization) in the cited chunk.
   - Unsupported citations are stripped and the answer is flagged `partially_verified`.
   - If no verified citation remains, the system returns "insufficient evidence" instead of
     the model's text.
7. **Response:**
   - the answer
   - citations (`artifact`, `version`, `section`, `char range`, `quote`)
   - a confidence band (`high`/`medium`/`low`) derived from the evidence count, source-type
     mix and verification outcome, not from the model's self-report
   - limitations
8. **Logging:** `ai_analysis_runs` (input hash, model, prompt template version) and
   `ai_usage_records` (tokens and cost).

## 3. Source trust model

Every evidence item carries a `source_type`:

| source_type           | Meaning                                                    | Counts as independent evidence?                         |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| `original_source`     | A primary document the user imported (paper PDF, dataset)  | Yes, one per distinct upstream source                   |
| `ai_generated_report` | AI-written report (most Claude Design artifacts)           | **No.** It is a secondary summary of its own references |
| `ai_interpretation`   | Output of this system's AI analysis                        | No                                                      |
| `human_note`          | The user's notes                                           | It is the user's judgment, not evidence of facts        |
| `external_verified`   | A reference the user marked as verified against the source | Yes                                                     |

**Independence.** Two AI reports citing the same DOI are one upstream source.
`claim_evidence.independence_group` holds a normalized DOI, URL or title hash, so
corroboration counts **distinct groups**, never documents. Repeated conclusions across AI
artifacts are never treated as independent validation.

## 4. Prompt injection defense

- Imported content is untrusted. It is only ever placed inside evidence blocks.
- It is never concatenated into system or developer instructions.
- Delimiters are randomized per request (`<evidence-7f3a…>`) so content cannot close a block.
- Output is checked for actions. Phase 2 RAG has **no tools**, so injected instructions can
  at most distort text, and they are caught by citation verification.
- The prompt-injection test fixture is a document containing "ignore previous instructions…".
  Its expected outcome: the answer does not follow it, and the document is cited as evidence
  only.

## 5. Knowledge model (Phase 3)

### 5.1 Topics and edges

- `knowledge_topics` form a hierarchy through `parent_topic_id`. Cross-links are
  `knowledge_edges` (`related_to`).
- AI-proposed topics and edges have `status = proposed` with `confidence`, an `evidence` list
  of chunk IDs, `source = ai` and `model_version`. Only `confirmed` items feed scores
  shown as facts, and the UI always marks proposed items.

### 5.2 Claims

- Claims are extracted per artifact version: atomic, falsifiable statements with evidence
  spans.
- Claims link to each other with `supports` or `contradicts`, and those edges are **proposed**
  until confirmed. A model's "contradiction" verdict is a hypothesis.

### 5.3 Coverage (per user-defined domain)

The user defines `research_goals`: domain, importance 1–5, and target depth
(`awareness`, `working`, `expert`). Each goal is decomposed into topics, initially
AI-proposed and then user-confirmed.

Per domain:

| Component        | Definition                                                                                                                           | Range |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| Topic coverage   | share of confirmed topics with ≥ 1 artifact that has ≥ 1 claim mapped to the topic, weighted by topic importance                     | 0–1   |
| Depth            | per topic: `min(1, distinct_independent_sources / required_sources(target_depth))`, where required = 1 / 3 / 6                       | 0–1   |
| Evidence quality | share of mapped claims with ≥ 1 `original_source` or `external_verified` evidence                                                    | 0–1   |
| Recency          | share of topics whose newest evidence is within the topic's staleness horizon (set per domain; e.g. AI 12 months, biology 60 months) | 0–1   |
| Diversity        | normalized entropy of `independence_group` across the domain's evidence                                                              | 0–1   |

`Coverage` is shown as a **vector of these five components**, never as a single "you know
62%". Artifact counts appear only as context. The UI states plainly that coverage measures
the _collection_, not the user's understanding.

### 5.4 Knowledge gaps

A gap is a rule-detected condition plus an optional AI explanation. Each rule is
deterministic and explainable:

| Gap type                 | Rule                                                                              |
| ------------------------ | --------------------------------------------------------------------------------- |
| Missing topic            | confirmed topic with importance ≥ 3 and zero mapped claims                        |
| Unverified key claim     | claim referenced by ≥ 2 artifacts but with only `ai_generated_report` evidence    |
| Weak evidence direction  | topic depth < 0.34 while importance ≥ 4                                           |
| Stale                    | topic recency = 0                                                                 |
| Contradiction            | ≥ 1 confirmed or high-confidence proposed `contradicts` edge unresolved           |
| Over-researched          | ≥ 5 artifacts on a topic, with marginal new independent sources ≤ 1 in the last 3 |
| Cross-domain opportunity | AI proposal; always labelled speculative                                          |

Each gap report includes:

1. why it is a gap (the rule)
2. related artifacts
3. what evidence is missing
4. importance (inherited from the topic or goal)
5. a suggested next research step
6. confidence: `rule-based` (certain the rule fired) vs `speculative` (AI-proposed)

### 5.5 Research opportunity scoring

The spec's proposal was `Importance × Expected Information Gain × Uncertainty Reduction ÷
Estimated Cost`. The critique:

- Information gain and uncertainty reduction overlap heavily. Multiplying them
  double-counts.
- Multiplying point estimates of guessed quantities produces false precision; small errors
  compound.
- Opportunity cost belongs to the comparison _between_ candidates, not inside each score.

Adopted model, ordinal and transparent:

```
priority_band = f(Importance[1–5], EvidenceGap[1–5], DecisionRelevance[1–5], Leverage[1–5], Cost[1–5])
score = (Importance × (EvidenceGap + DecisionRelevance + Leverage) / 3) / Cost       // ordinal inputs
```

- **EvidenceGap** is computed from §5.4 rules (rule-derived when possible).
- **DecisionRelevance** is user-set: does a pending decision depend on this?
- **Leverage** captures cross-domain reuse, from topic edges.
- **Cost** is a user or AI estimate of research effort.
- **Novelty** is folded into EvidenceGap: a novel topic is a maximal gap.

Displayed as:

- a **band** (`Do next`, `Soon`, `Later`, `Skip`), with each input visible and editable
- a **sensitivity note**: "would change band if Cost were 2 instead of 4"

Numbers are never shown with decimals.

### 5.6 Research prompt generator

Prompts are rendered from versioned `prompt_templates`. Variants: Claude Research, ChatGPT
Deep Research, Gemini, and generic.

Sections:

- Research Objective
- Existing Knowledge (claims with source types)
- Missing Questions
- Required Evidence (primary sources, data)
- Counterarguments to test
- Expected Deliverables
- Citation Requirements (DOI/URL per claim; distinguish primary vs secondary)

The output is plain text for the user to paste. Nothing is sent automatically.

## 6. Cost control

- Analyses are keyed by `(operation, content_hash, model, template_version)`. The same input
  produces a cache hit, and nothing is re-run on page view.
- Incremental analysis: only versions whose `content_hash` changed are re-analysed.
- `AI_MONTHLY_BUDGET_USD` is a hard cap. Jobs fail with `BUDGET_EXCEEDED` before calling
  the provider.
- The usage dashboard shows tokens and estimated cost by provider and model.
