# Release storage operations

## Retention state

The host writes `/var/lib/fsusblog/release-assets/retention-state.json` atomically after a successful switch:

```json
{
  "schema": "fsusblog.release-assets.gc-state.v1",
  "activeReleaseId": "20260711010101-0123456789ab",
  "previousReleaseId": "20260710010101-fedcba987654",
  "drainingReleaseIds": [],
  "retentionReleaseIds": ["20260709010101-111111111111"],
  "referencedReleaseIds": ["20260708010101-222222222222"],
  "minimumRetainedReleaseCount": 2
}
```

The state must include every release still referenced by a cached page, service worker, rollback record, evidence bundle, or operator hold. Never remove a draining release before its drain deadline and connection count reach zero.

## Pre-switch retained asset gate

```bash
node tools/storage/verify-retained-assets.mjs \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  --slot green \
  --store /var/lib/fsusblog/release-assets \
  --state /var/lib/fsusblog/release-assets/retention-state.json \
  --dry-run \
  --out .tmp/release-assets-retention.json
```

Schema `fsusblog.release-assets.retention-verification.v1` verifies both the release copy and content-addressed object for every protected asset. It requires at least active and previous protection, verifies the candidate is protected, emits all hash failures in `errors`, and exits non-zero on any failure.

Run the protocol/static compatibility gate after retention verification:

```bash
node tools/storage/check-release-compatibility.mjs \
  --candidate <candidate-release-id> \
  --active <active-release-id> \
  --previous <previous-release-id> \
  --store /var/lib/fsusblog/release-assets \
  --state /var/lib/fsusblog/release-assets/retention-state.json \
  --out .tmp/release-compatibility-matrix.json
```

Only `status=pass` from schema `fsusblog.release-compatibility-matrix.v1` may advance the rollout.

## Garbage collection

Review the plan first:

```bash
node tools/storage/gc-release-assets.mjs \
  --store /var/lib/fsusblog/release-assets \
  --state /var/lib/fsusblog/release-assets/retention-state.json \
  --dry-run \
  --out .tmp/release-assets-gc-dry-run.json
```

The dry-run evidence is the only manifest-binding authority for apply: it seals the protected `asset-manifest.json` digests and the exact release/object delete set that review approved.

Apply only after review:

```bash
node tools/storage/gc-release-assets.mjs \
  --store /var/lib/fsusblog/release-assets \
  --state /var/lib/fsusblog/release-assets/retention-state.json \
  --slot-state /var/lib/fsusblog/slots/slot-state.json \
  --rollout-state build/releases/<release-id>/rollout-state.json \
  --reviewed-dry-run .tmp/release-assets-gc-dry-run.json \
  --apply \
  --out /var/lib/fsusblog/release-assets/evidence/gc-<change-id>.json
```

`--apply` re-reads the current protected manifests and rejects any digest drift, protected-release drift, or delete-plan drift before it removes a release or object. The `.gc.lock` create-new lock makes concurrent collectors fail closed. Operators do not delete a lock blindly: first establish that no collector owns it, preserve the lock record as incident evidence, and then use the approved stale-lock procedure. The GC evidence schema is `fsusblog.release-assets.gc-evidence.v1` and records the sealed plan, every release/object action, and before/after inventory.

## Upload crash cleanup

Only the `UploadCommitTempCleanupLease` owner removes `.incoming/<other-instance>/*.tmp` older than the configured retention threshold. The current instance directory and fresh files are protected. Final upload files are never cleanup candidates. A retry validates an existing deterministic final file; it never overwrites it.

## Observability and incident triage

Retain materialization, compatibility, retention-verification and GC JSON with the rollout evidence. Alert on non-empty `errors`, hash conflicts, missing active/previous manifests, lock contention lasting beyond one collection interval, DataProtection probe failure, and growth of expired upload temp candidates. Logs and runtime snapshots must include slot, release and instance identity and must not share a writable directory across instances.
