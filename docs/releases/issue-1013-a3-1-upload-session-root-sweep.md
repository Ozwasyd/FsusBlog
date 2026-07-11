# A3-1 Upload session root-sweep retirement

Status: code landed; release-cycle milestone verification deferred.

## Change

`FileService.CleanupExpiredSessionsAsync` now follows only the expiration-bucket
index. The historical `CleanupLegacySessionRootSweepAsync` method and its call site
are absent, so cleanup cost is bounded by expired index entries rather than every
directory below the upload-session root. Stale per-session locks remain a separate
bounded cleanup concern.

## Release gate

Before this retirement is reported complete for a production release, retain
evidence that the indexed upload pipeline has served at least one full release cycle
and that a read-only scan of the old root shape finds zero newly deletable files. The
current implementation phase did not execute that scan; its evidence fields remain
null in `tests/backend/issue-1013-runtime-fallback-milestones.json`.

## Operational fallback

Do not restore a per-startup directory sweep. If an old orphan is found, quarantine
or remove that exact path through an operator-reviewed maintenance action and repair
the missing expiration index producer. Pausing the cleanup worker is a no-restart
degradation path while upload writes continue to use indexed sessions.

## Test ownership

- `FileServiceTests.UploadSessionCleanup_SourceUsesExpirationBucketIndex`
- `RuntimeFallbackRetirementAcceptanceTests.A3_1_UploadCleanupHasNoLegacySessionRootSweep`

