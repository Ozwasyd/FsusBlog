# Release storage backup and restore

## Backup classes

Back up durable shared state as one recoverable release boundary:

- PostgreSQL data and schema migration history;
- Redis only when it contains authoritative coordination/session state; cache-only keys may be rebuilt;
- uploads, including file metadata needed to reconcile database references;
- DataProtection key ring with permissions and application name contract;
- runtime secret versions and external secret-manager references.

Do not treat release-derived AOT/search/SSR/precompressed output as authoritative backup data. Rebuild it into a new generation under the same retained release. The immutable release asset store may be reconstructed from digest-pinned images, but retaining it shortens rollback and supports old service workers during an incident.

## Restore order

1. Stop traffic mutation and preserve active/previous/draining identity evidence.
2. Restore PostgreSQL and authoritative Redis state to a mutually consistent point.
3. Restore uploads without overwriting an existing different hash.
4. Restore the DataProtection ring before starting either slot; verify `ApplicationName=FsusBlog` and bidirectional payload conformance.
5. Restore secrets by version/reference; never write secret values into release evidence.
6. Materialize active and previous static assets from their digest-pinned images.
7. Rebuild release-derived generations into their own release roots and atomically advance only that release's pointer.
8. Write retention state protecting active, previous, draining and incident-referenced releases.
9. Run retained-asset and compatibility gates, then restore traffic.

## Drill evidence

A restore drill records source backup identity, restored database/schema identity, upload sample hashes, redacted DataProtection probe state, active/previous asset manifest hashes, derived generation IDs, compatibility matrix, start/end time, and operator/change ID. It must demonstrate an old protected payload decrypting in the new slot and a newly protected payload decrypting in the old slot. It must also fetch an old page's JS/CSS/Wasm URLs after candidate materialization.

Rollback is pointer/traffic based: preserve shared durable state, route to the previous slot, and retain both asset/derived trees. Never copy candidate-derived output over the previous release as a rollback action.
