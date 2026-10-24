# API Stability

FsusBlog is in Public Preview. Stability is granted per contract classification, never inferred from a product version, roadmap stage, route visibility, or the fact that an implementation is documented for maintainers.

## Internal / Experimental

The following remain internal or experimental unless a dedicated stability document explicitly reclassifies a named surface:

- Internal AEDS frame contracts are experimental.
- Undocumented internal APIs may change without compatibility guarantees.
- Database schema may change.
- Admin API routes may change.
- Deployment configuration may change.
- Third-party client compatibility is not guaranteed.
- Performance profiles must identify whether they use the Kestrel-only baseline or optional deployment layers such as reverse proxy or CDN.

These rules apply even when the current implementation is documented for maintainers.

## Documented Stable Extension Point

A surface is stable only when a dedicated document:

- names the exact routes, messages, files, or plugin boundary covered;
- defines compatibility and breaking-change rules;
- identifies the owning maintainer area and test fixtures;
- states migration, deprecation, and rollback behavior.

No roadmap stage automatically grants this classification. Anything outside the explicitly registered boundary stays internal or experimental.

## Standard External Protocol

The following outputs are standard external protocols or operational probes, not internal AEDS APIs:

- RSS
- Atom
- JSON Feed
- Sitemap
- `robots.txt`
- health probes

They remain compatible with their respective standards independently of FsusBlog release identity. That compatibility is not evidence that undocumented binary, admin, or internal routes are stable.

## Maintainer-Facing Deployment / Operations Contract

Health probes and explicitly documented release, rollback, backup, and operations inputs are maintainer-facing contracts. Their authority comes from their operations documentation, schemas, and local checks. Undocumented configuration, release-evidence internals, database schema, and administration endpoints remain experimental.

## Internal Binary API

The `/api/binary/**` runtime surface is the main application transport. It is optimized for FsusBlog clients and shared contracts inside this repository. Do not build third-party clients against undocumented AEDS frames unless you accept breaking changes.

## Admin And Deployment APIs

Admin routes and undocumented deployment internals may change. Treat them as maintainer-facing implementation details unless a dedicated stability document says otherwise.

## Current contract observation identity

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.observation-digest
behaviorId: binary-api-aeds-contract
claimType: generated-section
generatedSectionId: api.observation-digest
render: scalar
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.observation-digest -->
9658fbe023811259f4719418a91036ac7f55870f4559dab26e524d1bb49c268b
<!-- FSUSBLOG-GENERATED:END api.observation-digest -->
