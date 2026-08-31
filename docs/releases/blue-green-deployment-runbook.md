# Blue/Green deployment runbook

This runbook is the current authority for slot lifecycle, atomic gateway switching and rollback coordination. It describes required behavior; a completed rollout is proven only by release-bound execution receipts.

## Slot model

Only `blue` and `green` are valid slots. Each slot has a distinct loopback port, Compose project, container name, immutable release identity, runtime generation and instance-local log/cache/temp roots. PostgreSQL, Redis, uploads, DataProtection keys and append-only release storage remain shared according to their own lifecycle contracts.

A slot progresses through `Starting -> Candidate -> Ready -> Active -> Draining -> Stopped`. Readiness requires a positive runtime generation plus startup, dependency, schema compatibility, release identity and storage checks. Repeating the same valid transition is idempotent; an identity or generation mismatch fails closed.

Before candidate start, `slot-preflight.sh` verifies host capacity, ports, shared mounts/network, drain versus stop-grace timing, the exact image digest and runtime labels. Candidate failure never stops the active slot. Stopping an active slot is forbidden.

## Gateway switch

OpenResty reads one controlled loopback upstream from `active-upstream.conf`. The gateway controller:

1. holds the host deployment lock;
2. verifies durable source identity and target Ready Candidate identity;
3. stages and validates a complete gateway configuration;
4. activates the target with release/slot/generation compare-and-swap;
5. atomically installs the include and reloads OpenResty;
6. verifies loopback and public release headers;
7. commits durable traffic state, then begins source drain.

Before durable traffic commit, any reload or verification failure restores and retests the source include and neutralizes the target. After commit, the target remains Active while source drain completes; incomplete drain blocks closeout but is not rewritten as a failed traffic switch.

## Drain contract

Draining immediately rejects new ordinary requests, notification handshakes and global worker claims while preserving in-flight accounting. Health and ops probes are excluded from ordinary request leases. Notification connections and worker claims use their own admission counters.

The drain coordinator executes registered participants in parallel under individual and global deadlines. Evidence reports exact pending counts, errors and replay sources. A timeout remains `drained=false,timedOut=true`; a hard stop or missing process is never proof of drain.

Notification restart uses WebSocket 1012 with cursor preservation. Replay outside the retention window uses 4009 and requires full resynchronization. Binary endpoints retain their AEDS contract throughout slot transitions.

## Active fence and storage gates

Traffic commit does not authorize old-generation singleton writes. The target must acquire the active release fence and the source must be revoked; every irreversible worker boundary rechecks its active ticket. The detailed owner and failure rules are in [active release fencing](../active-release-fencing.md).

Before switching, release assets are materialized append-only and N/N-1 compatibility, retained asset hashes and storage lifecycle checks pass. The storage authority is [release storage lifecycle](../architecture/release-storage-lifecycle.md).

Schema changes follow Expand/Backfill/Contract and the candidate must pass [online database migration](../online-database-migration.md) compatibility before Ready.

## Rollback and recovery

- Before traffic commit: keep source Active, restore its gateway include, revoke/neutralize the candidate and preserve failure receipts.
- After traffic commit: use the retained previous manifest as a fresh Ready Candidate. A Draining process is not reactivated.
- After a non-rollback-compatible Contract migration: block old-image rollback and use write isolation plus backup/forward repair.
- On interrupted state: `gateway-recover.sh` reconciles durable state, the installed include and observed identity. It must not guess from process names or mutable tags.

Rollback always advances generation monotonically. Database downgrade is outside the gateway control plane.

## Receipt boundary

Slot status, preflight output, gateway transition, fence ownership, notification restart, source drain and rollback are execution receipts. They belong to the run-scoped release evidence bundle, not this document. The receipt must bind the same release manifest, full commit, image digest, rollout ID and target environment; absent or failed steps stay absent or failed.

## Local validation

```bash
node --test tests/tools/deployment-slots.test.mjs tests/tools/gateway-switch.test.mjs
node tools/run-test-matrix.mjs validate
```

Local validation checks contracts and fixtures only. It does not start production slots or switch live traffic.
## Current production bundle ordering

<!-- fsus-doc-claim
claimId: browserless-production-correctness.bundle-order
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: release.production-bundle-order
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN release.production-bundle-order -->
| Key | Value |
| --- | --- |
| bundleIds | ["backend-tests","build-static","frontend-tests","performance-evidence","runtime-browser"] |
| edges | ["backend-tests->performance-evidence","build-static->performance-evidence","frontend-tests->performance-evidence","runtime-browser->performance-evidence"] |
| hasDependencyEdges | true |
| profileId | production |
| topoOrderConstraints | ["after:performance-evidence\|requires:backend-tests","after:performance-evidence\|requires:build-static","after:performance-evidence\|requires:frontend-tests","after:performance-evidence\|requires:runtime-browser"] |
<!-- FSUSBLOG-GENERATED:END release.production-bundle-order -->

## Observed blue/green authority

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.claims-blocked-until-authority-verified
behaviorId: deployment-blue-green-runtime-role
claimType: boolean
factPath: deploymentBlueGreen.claimEligible
render: boolean-negated
-->

`claimEligible` is `false` because the active-resource checks below are synthetic library proofs, not production-current observations. Schema overlap, exact volume topology and runtime ownership remain source-bound, while production volume/schema cleanup and any unknown active identity stay explicitly unsupported and fail closed.

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.blue-green-contract
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: deployment.blue-green-contract
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN deployment.blue-green-contract -->
| Key | Value |
| --- | --- |
| abortedTransitionStatus | failed |
| activeArtifactIdentity | {"deploymentGeneration":1,"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","releaseId":"20260101000000-aaaaaaaaaaaa","rolloutId":"runtime-observation-rollout","slot":"blue"} |
| activeAssetAction | retain |
| activeAssetReasons | ["active","minimum-retention-count"] |
| activeIdentity | ["activeImageDigest","activeReleaseId","activeSlot"] |
| artifactProtectionAuthorityState | synthetic-library-proof |
| authorityModules | {"destructiveOperations":{"sourceDigest":"a2072432832929c689f45c30bf56aec13d7550070c4e7f0a9abc807a8dfb2694","sourcePath":"tools/deployment/destructive-operation-authority.mjs"},"onlineSchema":{"sourceDigest":"8c76bae9a6da950dae0467944d2e087d269c66fede75bc4f8fab32d2ae6d5e09","sourcePath":"src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCompatibility.cs"},"releaseAssetsGc":{"sourceDigest":"6b81a4b46d4d479479bb37ff85d79ac18a016b4872384f94fcb5fcc7416c02b3","sourcePath":"tools/storage/release-gc.mjs"},"rollout":{"sourceDigest":"cbb0f9a9189c24adb9266a7d11e4ff69f1b40f6ec090d565bdd4788335e17d0b","sourcePath":"tools/deployment/release-rollout-lib.mjs"},"slot":{"sourceDigest":"a8ec1666cf92eee86e02d652b90cdcbedb04f1470d01ab66fa25a37cf7931d73","sourcePath":"tools/deployment/slot-lib.mjs"},"topologyAuthority":{"sourceDigest":"362913edac870579ca67f7fa46608b9f68c38474579347e5a9881a721fd662aa","sourcePath":"tools/governance/check-monolithic-distributed-architecture.mjs"}} |
| authorityState | synthetic-library-proof |
| claimEligibilityReasons | ["production-current-active-resource-evidence-absent"] |
| claimEligible | false |
| destructiveAuthority | {"contentDigest":"sha256:bfdce7ca0918af2cc87163d5e804595ac73c4cabc9587927e443f4581379b2aa","schema":"fsusblog.destructive-operation-authority.v1","schemaCleanupStatus":"unsupported","volumeCleanupStatus":"unsupported"} |
| evidenceClass | synthetic-library-proof |
| proofIds | ["release-assets.active-release-retained","rollout.failed-stage-recovery-derived","slot.active-stop-rejected","slot.gateway-transition-state-derived","slot.identity-mismatch-rejected"] |
| rollbackRequiredState | rollback_required |
| rolloutFailureState | recovery_required |
| rolloutRecoveryAction | preserve-source-stop-candidate |
| rolloutStages | ["manifest-validate","capacity-preflight","backup-restore-gate","expand-migration","asset-materialize","candidate-start","candidate-readiness","candidate-smoke","compatibility-smoke","gateway-switch","source-drain","active-fence","public-verify","source-stop","release-evidence"] |
| rolloutStateSchema | fsusblog.release-rollout-state.v1 |
| runtimeProtectionAuthorityState | synthetic-library-proof |
| schemaOverlap | {"authorityState":"observed-in-current-schema-manifest-probe","catalogDigest":"sha256:e015eb08491a2f1766a424357a2812a2e777a18c4866e11b2362efe8f3726608","catalogMetadataCount":137,"claimEligible":true,"concurrentContractFailureCodes":["schema_contract_backfill_incomplete","schema_contract_backfill_unverified","schema_contract_backup_restore_stale","schema_contract_confirmation_missing","schema_contract_current_release_dependency","schema_contract_exclusive_mode_missing","schema_contract_observation_window","schema_contract_old_writes_enabled","schema_contract_previous_release_dependency","schema_contract_release_window_open","schema_contract_rollback_manifest_open","schema_contract_slot_switch_in_progress"],"evidenceClass":"current-manifest-catalog-database-model","manifestDescriptorCount":137,"manifestDigest":"sha256:5f5d2a49bdb60f30f8ed91a70ef787c8c6b6cd21fbb2a385e0e97521c07c97aa","missingExpandFailureCodes":["schema_expand_pending"],"schema":"fsusblog.online-schema-overlap-observation.v1","sourceReadiness":"ready","targetReadiness":"ready"} |
| schemaProtectionAuthorityState | synthetic-library-proof |
| slotStateSchema | fsusblog.deployment-slots.v1 |
| slots | ["blue","green"] |
| stopActiveResult | refusing to stop active slot blue |
| switchState | switching |
| unknownIdentityResult | active release identity does not match slot record |
| volumeProtectionAuthorityState | synthetic-library-proof |
| volumeScopes | {"operator-shared":["/app/config/zk","/app/secrets/zk"],"release-artifact-store":["/app/release-assets"],"release-identity":["/app/release-manifest.json"],"shared-between-slots":["/app/data-protection","/app/release-derived","/app/storage"],"slot-private":["/app/Logs","/app/data","/app/wwwroot/aot-cache"]} |
| volumeTopology | {"app.Logs":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-logs","target":"/app/Logs","volumeName":"${FSUSBLOG_SLOT_LOGS_VOLUME:?Set slot-specific logs volume}"},"app.config.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_CONFIG_DIR:?Set FSUSBLOG_ZK_CONFIG_DIR to the host ZK config directory}","target":"/app/config/zk"},"app.data":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-slot-data","target":"/app/data","volumeName":"${FSUSBLOG_SLOT_DATA_VOLUME:?Set slot-specific data volume}"},"app.data-protection":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-data-protection","target":"/app/data-protection","volumeName":"${FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME:?Set the shared DataProtection volume explicitly}"},"app.release-assets":{"access":"read-only","protection":"exact-active-release-gc-authority","scope":"release-artifact-store","source":"${FSUSBLOG_RELEASE_ASSET_STORE:?Set the host append-only release asset store}/releases","target":"/app/release-assets"},"app.release-derived":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-release-derived","target":"/app/release-derived","volumeName":"${FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME:-fsusblog-release-derived}"},"app.release-manifest.json":{"access":"read-only","protection":"identity-bound-read-only","scope":"release-identity","source":"${FSUSBLOG_RELEASE_MANIFEST_HOST_PATH:?Set the validated host release manifest path}","target":"/app/release-manifest.json"},"app.secrets.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_SECRET_DIR:?Set FSUSBLOG_ZK_SECRET_DIR to the host ZK secret directory}","target":"/app/secrets/zk"},"app.storage":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-storage","target":"/app/storage","volumeName":"${FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME:?Set the migrated shared public-assets volume explicitly}"},"app.wwwroot.aot-cache":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-aot-cache","target":"/app/wwwroot/aot-cache","volumeName":"${FSUSBLOG_SLOT_AOT_CACHE_VOLUME:?Set slot-specific AOT cache volume}"}} |
<!-- FSUSBLOG-GENERATED:END deployment.blue-green-contract -->
