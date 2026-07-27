# Documentation Lifecycle

## Authority

`config/development/document-lifecycle.json` is the machine-readable lifecycle policy for every file under `docs/`. Its v2 `documents` registry explicitly records every path's status, owner, related issues, supersession edges, and producer. `config/development/document-inventory.generated.json` is the complete projection over the current repository tree. A document is not a current source of truth merely because it is newer, has an open issue, or is easy to find.

The lifecycle statuses are:

- `current`: maintained facts and operating rules; only these documents may be sources of truth.
- `proposed`: plans that still require an open implementation decision.
- `historical`: migration, protocol-retirement, incident, and audit records retained for a durable reason.
- `generated`: producer-owned output that must not be edited by hand.
- `retired`: content kept only behind an explicit replacement or redirect.

Every inventory entry records an owner, status, source-of-truth flag, verification commit, reciprocal supersession fields, related issues, and the producer for generated content. None of those values is inferred from a filename. The lifecycle verification commit binds the classification pass, not a claim that every paragraph was rewritten at that commit. Executable paragraph-level behavior claims are owned by the [DocClaim protocol](doc-claim-protocol.md); `lastVerifiedCommit` must not enter DocClaim pass/fail inputs or receipt digests.

## Ownership

Owners are `backend`, `frontend`, `security`, `release`, and `governance`. Ownership is explicit per document. New domains must extend the accepted owner contract instead of inventing document-local owner names.

`docs/index.md` is generated from the inventory and lists every current source of truth grouped by owner. Proposed, generated, and retired documents remain visible in separate sections. Historical content is grouped by topic or directory; assets and screenshots are counted rather than listed one by one, so archive volume cannot hide the current entry points.

## Issue Metadata and History

Issue numbers are traceability metadata, not lifecycle inputs or document keys. Closing an issue must do one of the following:

1. merge stable facts into an existing current document;
2. create a focused, semantic current document;
3. retire an older source with reciprocal `supersedes` / `supersededBy` metadata;
4. keep a genuinely undecided design proposed and linked to its open issue.

New long-term paths must describe domain, subject, lifecycle state, and audience. Issue/PR prefixes and implementation-stage identities such as `handoff`, `final`, `completion`, and `landed` are rejected. The finite `legacyNamingCompatibility` registry admits only exact pre-existing paths and names the issue that must remove each entry; it is not a wildcard allowlist and cannot admit new legacy names.

`pathMigrations` records reviewed repository moves. It does not claim that GitHub blob URLs redirect. A migration record is invalid while its source still exists or its target is missing.

## Supersession

Every supersession edge must be reciprocal: if a current document lists an older path in `supersedes`, that older document must name the current path in `supersededBy`. Missing targets, one-sided edges, and cycles fail verification. Authority claim IDs are unique and must point to a current source of truth, preventing two documents from silently claiming the same registered authority.

## Generated Documents

Generated entries declare one repository producer. Verification fails when the producer is missing, the inventory differs from the current `docs/` tree, or the generated index differs from the inventory. Regenerate only with:

```bash
node tools/docs/generate-document-lifecycle.mjs --write
```

Do not hand-edit `config/development/document-inventory.generated.json` or `docs/index.md`.

## Verification

The authoritative development-doc checker validates entirely from local repository state:

- complete explicit metadata coverage and accepted owner/status values;
- one current document for each registered authority claim;
- exact legacy-name compatibility and semantic naming for every new path;
- live, reciprocal, acyclic supersession relationships;
- generated producer existence and exact inventory/index projections;
- internal links, fenced-code languages, retired references, and path migration records;
- a reachable, bounded-age lifecycle verification commit.

Focused tests include duplicate authority, explicit issue metadata, missing producer, semantic-name positive/negative fixtures, supersession target/reciprocity/cycle failures, historical asset aggregation, retired references, broken internal links, and path-migration positive/negative cases. The checker requires neither GitHub API nor network access. Markdown formatting, headings, anchors, and code fences remain additionally governed by the repository Markdownlint gate.

Run the lifecycle gate with `node tools/docs/generate-document-lifecycle.mjs --check`, then run `node tools/docs/check-authoritative-development-docs.mjs` for coding-authority and repository-map validation. Existing invalid links that overlap an active feature migration may only be deferred through an exact source/target entry in `brokenLinkExceptions`; unrelated new broken links always fail.
