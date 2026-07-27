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
lastVerifiedCommit
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
generated-section
rationale
```

- `generated-section` declares `generatedSectionId` only; it does not embed expected values and does not bind prose.
- `rationale` does not participate in fact equality and must not contain unregistered precise quantities, paths, or absolute behavior commitments.
- `failure-mode` uses stable reason/semantic IDs; free prose is not compared as a mode set.
- Unknown `claimType` values fail; they are never defaulted to `scalar`.

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
- `lastVerifiedCommit` or any self-proving baseline field

Updating lifecycle `lastVerifiedCommit` alone cannot create DocClaim pass evidence. Observation comparison and prose verification are later consumers of this protocol; they are not part of the parse gate. Precise tabular facts use generated sections (below).

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

### Determinism and `--check`

- Fixed Unicode NFC, LF newlines, and ordinal sorting for unordered sets; ordered sets preserve observation order.
- Every run re-renders from current receipts; old section bodies are never inputs.
- `--check` compares repository bytes and performs zero writes. Any drift fails.
- Observation `sourceCommit` / `worktreeFingerprint` / build identity must match the current worktree before generate writes.
- Generate replaces only owned marker ranges and never mutates `lastVerifiedCommit` or document-lifecycle metadata.
- No section digest baselines, allowlists, warning-only modes, or feature flags.

```bash
node tools/docs/generate-fact-sections.mjs --check --receipt path/to/receipt.json
node tools/docs/generate-fact-sections.mjs --generate --receipt path/to/receipt.json
node --test tests/tools/generated-fact-sections.test.mjs
```

## Verification

```bash
node tools/docs/check-doc-claim.mjs
node --test tests/tools/doc-claim.test.mjs
node tools/docs/generate-fact-sections.mjs --check
node --test tests/tools/generated-fact-sections.test.mjs
```
