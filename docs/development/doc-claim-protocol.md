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

Updating lifecycle `lastVerifiedCommit` alone cannot create DocClaim pass evidence. Observation comparison, prose verification, and generated sections are later consumers of this protocol; they are not part of the parse gate.

## Verification

```bash
node tools/docs/check-doc-claim.mjs
node --test tests/tools/doc-claim.test.mjs
```
