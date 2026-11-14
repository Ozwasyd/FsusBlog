# DocClaim protocol

## Authority

Executable document claims live in current Markdown as a single HTML comment marker and are owned by:

- Schema: [`config/schemas/doc-claim.schema.json`](../../config/schemas/doc-claim.schema.json) (`fsusblog.doc-claim.v1`)
- Parser / serializer / stable error codes: [`tools/docs/doc-claim.mjs`](../../tools/docs/doc-claim.mjs)
- Repository gate: [`tools/docs/check-doc-claim.mjs`](../../tools/docs/check-doc-claim.mjs)

Behavior identity remains in [`config/contracts/behavior-contracts.json`](../../config/contracts/behavior-contracts.json). Document path, owner, and current/historical status remain in [`config/development/document-lifecycle.json`](../../config/development/document-lifecycle.json). Neither lifecycle metadata nor Markdown lint re-hosts the claim schema.

## Syntax

Only this marker form is valid. YAML front matter, fenced JSON, and alternate HTML markers are rejected.

```md
<!-- fsus-doc-claim
claimId: document-lifecycle-governance.rationale.scope
behaviorId: document-lifecycle-governance
claimType: rationale
factPath: documentationScope
render: rationale-prose
-->

Lifecycle classification records path authority; it does not prove every paragraph matches the implementation.
```

Required fields: `claimId`, `behaviorId`, `claimType`, `render`, and exactly one of `factPath` or `generatedSectionId` according to `claimType`.

Optional fields only: `anchor`, `projection`, `orderPolicy`, `emptyPolicy`.

Forbidden fields (unknown keys also fail closed):

```text
verified
approved
self-certification metadata
expectedValue
baselineValue
ignoreDifference
waiver
allowStaleUntil
```

## claimType

Strict set:

```text
scalar
boolean
enum-set
ordered-set
map
transition-set
failure-mode
binary-relation
implication
preservation-rule
generated-section
rationale
```

- `generated-section` declares `generatedSectionId` only; it does not embed expected values and does not bind prose.
- `rationale` does not participate in fact equality and must not contain unregistered precise quantities, paths, or absolute behavior commitments without a neighboring executable claim.
- `failure-mode` uses stable reason/semantic IDs; free prose is not compared as a mode set.
- `binary-relation`, `implication`, and `preservation-rule` are prose-verifiable subject/predicate/object or scope claims; large sets still require generated sections.
- `enum-set`, `ordered-set`, `map`, and `transition-set` must use `generated-section` for exact tabular facts; free-prose fuzzy comparison is rejected.
- Unknown `claimType` values fail; they are never defaulted to `scalar`.

DocClaim `claimType` describes the semantic render. Exactness ownership is a closed split between `generated-section` and `prose-claim`: only a generator receipt can prove the former, while the latter covers every executable claim other than `generated-section` and only `ProseClaimVerifier` may count it in `verifiedClaimCount`. A generated section's count, presence, or pass status must never be counted as a prose-verified claim.

## Location rules

- Each non-generated claim binds the next non-empty Markdown paragraph, list, or table.
- A claim block may not cross a heading or another claim before its body.
- `claimId` is repository-unique. Multiple claims may segment one `behaviorId`.
- One body block may not be shared by two different `behaviorId` values.
- Optional `anchor` must match a unique heading slug in the same document.
- Active behaviors may be claimed only from lifecycle `current` documents. Historical documents may reference only `migration-only` or `retired` behaviors and never produce qualification evidence.

## Parse output boundary

The parser emits declarations and source locations only. Parse receipts use `fsusblog.doc-claim-parse-receipt.v1` and must not include:

- implementation observations
- test results
- pass/fail or qualification flags
- self-certifying lifecycle metadata or any self-proving baseline field

Lifecycle metadata cannot create DocClaim pass evidence. Observation comparison and prose verification are separate consumers of this protocol; they are not part of the parse gate. Precise tabular facts use generated sections (below).

## Prose claim verification

Explanatory prose that still carries scalar, boolean, failure-policy, relation, implication, or preservation facts is verified by a single `ProseClaimVerifier`. It consumes only DocClaim located claims and sealed `FactObservationReceipt` values (via the public receipt reader). It does not read business source, tests, network, embeddings, LLM judges, human `reviewed` flags, or baseline allowlists.

### Authority

- Verifier / bound-block parser / unique render registry: [`tools/docs/prose-claim-verifier/`](../../tools/docs/prose-claim-verifier/)
- CLI gate: [`tools/docs/check-prose-claims.mjs`](../../tools/docs/check-prose-claims.mjs)
- Focused tests: [`tests/tools/prose-claim-verifier.test.mjs`](../../tests/tools/prose-claim-verifier.test.mjs)

### Admitted prose renders

```text
integer-minutes
integer-bytes
integer-layers
integer-count
integer-scalar
boolean-affirmed
boolean-negated
boolean-extends
failure-mode-code
failure-policy
relation-subject-predicate-object
implication-if-then
preserves-fields
revokes-only-scope
rationale-prose
```

Each render builds a deterministic plan from the typed observation: required token groups, forbidden conflicting tokens, unit/boundary semantics, and relation direction IDs. The parser checks only the claim-bound body block.

### Scalar / boolean / failure rules

- Exact rendered value and unit must appear; same-dimension conflicting numbers in the body fail unless an interval projection is explicit on the claim.
- Unit equivalence (for example `5` minutes vs `300` seconds) is fixed by the renderer policy and is never converted by the parser.
- Inclusive/exclusive and default/max/min roles must be explicitly rendered when present on the observation.
- Boolean and failure-policy phrases come from a single controlled phrase registry; simultaneous affirmative and negative phrases fail.

### Relation / preservation rules

- Subject-predicate-object triples must map with direction: object-before-subject wording fails even when all three tokens appear.
- `revokes-only-scope` requires controlled “only revokes” phrasing and rejects “revokes all” conflicts.
- Large preserve/permission/transition sets must use generated sections, not free prose.

### Rationale boundary

- Precise numbers, paths, and absolute commitments in `rationale` require a neighboring executable claim (same heading or same `behaviorId`).
- Unbound absolute language fails closed; there is no LLM judgment path.

### Non-goals / forbidden surfaces

- Claim marker presence alone is never pass evidence.
- No fuzzy whole-document keyword scan, `reviewed=true`, baseline allowlist, compat/loose parser, warning-only mode, or feature flag.
- No second `ProseRenderRegistry` or alternate verifier entrypoint.

```bash
node tools/docs/check-prose-claims.mjs --governance-only
node tools/docs/check-prose-claims.mjs --receipt path/to/receipt.json
node --test tests/tools/prose-claim-verifier.test.mjs
```

## Generated fact sections

`claimType: generated-section` binds a `generatedSectionId` to a deterministic Markdown region owned by the FactObservation renderer. Exact lists, tables, enums, routes, and transitions must not be hand-maintained as a second authority.

### Marker protocol

```md
<!-- FSUSBLOG-GENERATED:BEGIN auth.permissions.all -->
...generated Markdown...
<!-- FSUSBLOG-GENERATED:END auth.permissions.all -->
```

- `sectionId` maps one catalog entry (and therefore one DocClaim/Behavior/fact path).
- begin/end markers are paired, repository-unique per document, and non-nested.
- Marker interiors are generator-owned; hand edits fail the next `--check`.
- Exterior prose is never rewritten. Compatibility markers and dual registries are forbidden.

### Catalog and RendererRegistry

- Catalog: [`config/contracts/generated-fact-sections.json`](../../config/contracts/generated-fact-sections.json) (`fsusblog.generated-fact-section-catalog.v1`)
- Schema: [`config/schemas/generated-fact-section-catalog.schema.json`](../../config/schemas/generated-fact-section-catalog.schema.json)
- Engine: [`tools/docs/generated-fact-sections/`](../../tools/docs/generated-fact-sections/) and CLI [`tools/docs/generate-fact-sections.mjs`](../../tools/docs/generate-fact-sections.mjs)

Admitted renderers only:

```text
scalar
boolean
enum-set
ordered-set
key-value-table
transition-table
failure-mode-table
route-table
dependency-graph-table
```

Renderers format only. They do not import business source, extractors, or tests. Business facts enter as sealed `FactObservationReceipt` values via the public receipt reader.

With `emptyPolicy: render-empty`, empty enum and ordered sets render the plain paragraph `Empty set.`. The marker remains ordinary Markdown text so the generated section follows the same heading and emphasis rules as authored documentation.

### Determinism and `--check`

- Fixed Unicode NFC, LF newlines, and ordinal sorting for unordered sets; ordered sets preserve observation order.
- Every run re-renders from current receipts; old section bodies are never inputs.
- `--check` compares repository bytes and performs zero writes. Any drift fails.
- Observation `sourceCommit` / `worktreeFingerprint` / build identity must match the current worktree before generate writes.
- Generate replaces only owned marker ranges and never mutates document-lifecycle metadata.
- No section digest baselines, allowlists, warning-only modes, or feature flags.

```bash
node tools/docs/generate-fact-sections.mjs --check --receipt path/to/receipt.json
node tools/docs/generate-fact-sections.mjs --generate --receipt path/to/receipt.json
node --test tests/tools/generated-fact-sections.test.mjs
```

## Verification

[`config/contracts/document-claim-migration-ledger.json`](../../config/contracts/document-claim-migration-ledger.json) covers every `active` behavior in BehaviorCatalog with `documentationPolicy: required`. The checker cross-checks behaviors, current lifecycle documents, claim IDs, and generated section IDs in both directions; omissions, extras, duplicates, historical owners, incorrect marker anchors, or retired copies all fail closed.

The content domain's terminal exactness gate is [`tools/docs/content-doc-exactness.mjs`](../../tools/docs/content-doc-exactness.mjs), which reads current admission's prose/generated/content observations to produce 13 mutation-evidence classes, then binds each claim to its current authority, heading path, source range, document digest, and component digest. Independent `verify` must reread the same component files and recompute the complete terminal receipt; resigning only a self-reported counter, row, or authority digest cannot pass.

```bash
node tools/docs/check-doc-claim.mjs
node --test tests/tools/doc-claim.test.mjs
node tools/docs/generate-fact-sections.mjs --check
node --test tests/tools/generated-fact-sections.test.mjs
node tools/docs/check-prose-claims.mjs --governance-only
node --test tests/tools/prose-claim-verifier.test.mjs
node tools/docs/content-doc-exactness.mjs mutate --observation path/to/content-observation.json --out path/to/mutation.json
node tools/docs/content-doc-exactness.mjs produce --admission path/to/admission.json --prose path/to/prose.json --generated path/to/generated.json --observation path/to/content-observation.json --mutation path/to/mutation.json --out path/to/terminal.json
node tools/docs/content-doc-exactness.mjs verify --receipt path/to/terminal.json --admission path/to/admission.json --prose path/to/prose.json --generated path/to/generated.json --observation path/to/content-observation.json --mutation path/to/mutation.json
node --test tests/tools/content-doc-exactness.test.mjs
```
