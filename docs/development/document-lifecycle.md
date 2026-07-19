# Documentation Lifecycle

## Authority

`config/development/document-lifecycle.json` is the machine-readable lifecycle policy for every file under `docs/`. `config/development/document-inventory.generated.json` is its complete projection over the current repository tree. A document is not a current source of truth merely because it is newer or easy to find.

The lifecycle statuses are:

- `current`: maintained facts and operating rules; only these documents may be sources of truth.
- `proposed`: plans that still require an open implementation decision.
- `historical`: issue handoffs, migration evidence, and implementation snapshots retained for audit.
- `generated`: producer-owned output that must not be edited by hand.
- `retired`: content kept only behind an explicit replacement or redirect.

Every inventory entry records an owner, status, source-of-truth flag, verification commit, supersession fields, related issues, and the producer for generated content. The lifecycle verification commit binds the classification pass, not a claim that every paragraph was rewritten at that commit.

## Ownership

Owners are `backend`, `frontend`, `security`, `release`, and `governance`. The first matching path rule owns a document. New domains must extend the central policy instead of inventing document-local owner names.

`docs/index.md` is generated from the inventory and lists every current source of truth grouped by owner. Proposed, historical, generated, and retired material remains visible in separate sections, so searchability does not imply authority.

## Issue Handoffs and History

Issue-prefixed files and handoff records are historical by default. Closing an issue must do one of the following:

1. merge stable facts into an existing current document;
2. create a focused current document and mark the handoff historical;
3. retire the handoff with a `supersededBy` target;
4. keep a genuinely undecided design proposed and linked to its open issue.

Bulk-moving the existing handoff archive would break stable issue and pull-request links. Historical files therefore keep their paths until a reviewed migration adds an exact `from`/`to` redirect entry. A redirect is invalid while the old source still exists or the target is missing.

## Generated Documents

Generated entries declare one repository producer. Verification fails when the producer is missing, the inventory differs from the current `docs/` tree, or the generated index differs from the inventory. Regenerate only with:

```bash
node tools/docs/generate-document-lifecycle.mjs --write
```

Do not hand-edit `config/development/document-inventory.generated.json` or `docs/index.md`.

## Verification

The authoritative development-doc checker validates:

- complete metadata coverage and accepted owner/status values;
- one current document for each registered authority claim;
- historical classification for known closed-issue documents;
- generated producer existence and exact inventory/index projections;
- internal links, fenced-code languages, retired references, and redirect maps;
- a reachable, bounded-age lifecycle verification commit.

Focused tests include duplicate authority, closed-issue handoff, missing producer, retired reference, stale inventory, broken internal link, and redirect positive/negative cases. Markdown formatting, headings, anchors, and code fences remain additionally governed by the repository Markdownlint gate.

Run the lifecycle gate with `node tools/docs/generate-document-lifecycle.mjs --check`, then run `node tools/docs/check-authoritative-development-docs.mjs` for coding-authority and repository-map validation. Existing invalid links that overlap an active feature migration may only be deferred through an exact source/target entry in `brokenLinkExceptions`; unrelated new broken links always fail.
