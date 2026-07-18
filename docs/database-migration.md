# Database Migration Runbook

This document is the historical/final-state catalog for legacy descriptors. New
production changes must follow [Online Database Migration Protocol](online-database-migration.md)
and [Online Migration Operations](online-database-migration-operations.md). The only
production release entry is `tools/deployment/release-rollout.sh`: it executes an
explicit Expand before candidate start; production `serve` performs only read-only
compatibility checks. Backfill resumes from durable checkpoints, while Contract is a
separate destructive operation after observation and backup gates.

Do not replay this legacy catalog through the online Contract command. Pre-protocol
descriptors are `LegacyBootstrapOnly` and require an isolated restore/cold bootstrap.
Expand/Backfill can degrade without restarting the web process by retaining the
N/N-1 bridge or pausing the durable token. After destructive Contract, code rollback
cannot recreate removed data: isolate the write path and restore a verified backup
before selecting a compatible retained image/database pair.

## Zero-Downtime Migration Qualification

Issue #1031 qualification is an isolated Test-topology gate around the production
Expand/Backfill/Contract protocol. Its private plan supplies
`target.migrationServerDll` and
`migrationQualification.{scenarioTemplate,timeoutSeconds,expandMigrationId,backfillMigrationId,contractMigrationId}`.
The resolved template always contains exactly these ten scenarios:

| Order | Scenario | Required observation |
| ---: | --- | --- |
| 1 | Expand with old Active | old release is ready before Expand and still serves an AEDS read afterward |
| 2 | Blue/Green concurrent read/write | both direct origins read and perform bounded idempotent bridge writes with exact release headers |
| 3 | Backfill checkpoint/resume | pause is durable, resume token is hash-only, resume completes without row-count regression |
| 4 | Missing Expand | candidate qualification readiness returns 503 `schema_incompatible` |
| 5 | Contract during rollback window | command is rejected with previous-release/rollback-manifest issues |
| 6 | Qualified Contract | destructive command succeeds and a separate marker binds rollout/release with `rollbackCompatible=false` |
| 7 | Migration lock | real PostgreSQL advisory-lock timeout returns `schema_advisory_lock_timeout` |
| 8 | Database disconnect | isolated failed connection returns `schema_database_unavailable` |
| 9 | Partial Backfill failure | failed checkpoint and failure count persist, then resume reaches completed without regression |
| 10 | History integrity | checksum mismatch and unknown history record are both reported with a history hash |

`tools/deployment/rehearsal-schema-qualification-probe.mjs` is the repository-owned
adapter for fault/checkpoint operations. It runs only with
`ASPNETCORE_ENVIRONMENT=Test` and `FSUSBLOG_ROLLOUT_REHEARSAL=1`, rejects production-
like database IDs, and reads only a private env file. Blue/Green HTTP uses application
routes `POST /api/release-evidence/schema-bridge/write` and
`GET /api/release-evidence/schema-qualification/readiness`; these routes are absent
unless `SchemaMigration:QualificationEnabled=true` in the exact `Test` environment,
and still require admin `system.config` plus `fixed_ip`.

Before Contract, no-restart rollback is additive: keep the source Active, stop or
tear down the candidate, retain the bridge, and pause/resume the durable Backfill
checkpoint. During or after a qualified Contract, the marker is authoritative. If
`rollbackCompatible=false`, do not route an old image back to the modified database;
isolate writes and restore a verified backup or apply a forward repair with a
compatible retained release.

## 字段最终态表

The table below is the authoritative final-state inventory for legacy identity columns that are either removed from the physical schema or retained only for an explicit compatibility purpose. Keep it synchronized with `src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs`; `tools/db/migration-doc-lint.mjs` fails when the registry and this table diverge.

| column | physical | code-mapped | kept-for | dropped-at-version |
| -------- | ---------- | ------------- | ---------- | -------------------- |
| `sys_user.username` | dropped | no | legacy password-login identity only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.password` | dropped | no | legacy password-login credential only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.role` | dropped | no | legacy role authority only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.lastusernameupdatetime` | dropped | no | legacy username rename throttle only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.last_username_update_time` | dropped | no | legacy username rename throttle only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.refreshtoken` | dropped | no | legacy plaintext refresh-token cleanup only | 20260602-post-user-auth-security-hardening |
| `sys_user.refreshtokenexpirytime` | dropped | no | legacy plaintext refresh-token cleanup only | 20260602-post-user-auth-security-hardening |
| `sys_user.refresh_token` | dropped | no | legacy plaintext refresh-token cleanup only | 20260602-post-user-auth-security-hardening |
| `sys_user.refresh_token_expiry_time` | dropped | no | legacy plaintext refresh-token cleanup only | 20260602-post-user-auth-security-hardening |
| `sys_user.lastloginip` | dropped | no | legacy login observation only | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.lastlogintime` | dropped | no | legacy login observation only | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfasecretencrypted` | dropped | no | migrated to user_mfa_profile.mfa_secret_encrypted | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfapendingsecretencrypted` | dropped | no | migrated to user_mfa_profile.mfa_pending_secret_encrypted | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfapendingcreatedat` | dropped | no | migrated to user_mfa_profile.mfa_pending_created_at | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfaverifiedat` | dropped | no | migrated to user_mfa_profile.mfa_verified_at | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfarecoverycodeshash` | dropped | no | migrated to user_mfa_profile.mfa_recovery_codes_hash | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.account_subject_hash` | present nullable during rolling expand | yes | stable account subject projection; startup gate requires every row populated | n/a |
| `comment.user_id` | present nullable | yes | explicit public attribution compatibility | n/a |
| `comment.reply_to_user_id` | present nullable | yes | legacy public reply projection | n/a |
| `comment.moderated_by_user_id` | dropped | no | renamed to comment.moderated_by_admin_principal_id | 20260621-pre-comment-moderation-admin-principal-attribution |
| `sys_visit_log.userid` | dropped | no | legacy human-read account binding only | 20260621-post-visit-log-anonymous-attribution-finalize |
| `sys_visit_log.user_id` | dropped | no | legacy human-read account binding only | 20260621-post-visit-log-anonymous-attribution-finalize |
| `sys_visit_log.ip` | dropped | no | replaced transitionally by sys_visit_log.ip_hash before full table retirement | 20260621-post-visit-log-ip-anonymization |
| `sys_visit_log` | dropped | no | event-level read trajectory table retired in favor of aggregate-only tables | 20260715-post-read-event-retirement |

## Legacy 20260517 Upgrade

The supported legacy baseline is the PostgreSQL dump profile captured on 2026-05-17. It contains the old tables `article`, `article_tag`, `category`, `comment`, `sys_message`, `sys_systemconfig`, `sys_user`, `sys_user_message`, `sys_visit_log`, and `tag`.

Before running this upgrade in production:

1. Create a full site backup with `tools/operations/backup-site.sh`.
2. Restore the backup or the legacy dump into an isolated PostgreSQL database.
3. Run `tools/db/verify-legacy-upgrade-20260517.sh` with `FSUS_LEGACY_20260517_DUMP_GZ` pointing to the local dump file.
4. Confirm the migration can run twice without duplicate rows in migration history, `article_body`, `article_view_seed`, `msg_conversation`, `msg_message`, or `msg_participant_state`.

The migration expands safe columns before CodeFirst synchronization:

- `article.title`: `varchar(200)` to `varchar(256)`
- `article.summary`: `varchar(500)` to `varchar(512)`
- `sys_user.username`: legacy shorter length to `varchar(64)` before anonymous identity finalization; the post-CodeFirst finalizer drops this column.

The migration fail-fast checks shrinking fields before applying the current schema:

- `category.name` must be at most 128 characters.
- `tag.name` must be at most 128 characters.
- `sys_systemconfig.key` must be at most 64 characters.
- `sys_systemconfig.value` must be at most 512 characters after legacy `Page_*` and `sys:page:*` entries have moved to `page_content`.

If any shrinking field contains oversized data, the isolated legacy bootstrap fails with a message containing `Legacy 20260517 length check failed`, the table name, column name, affected row count, observed max length, and expected max length. Do not truncate production data in place. Export the offending rows, decide the canonical replacement values, update them explicitly, then rerun the isolated migration.

The upgrade also moves legacy content and messaging structures:

- `article.content` is copied to `article_body.markdown_content`, then the old column is dropped.
- `article.views` is copied to `article_view_seed.legacy_views`.
- `Page_*` and `sys:page:*` entries in `sys_systemconfig` are copied to `page_content`, then removed from `sys_systemconfig`.
- `sys_message` and `sys_user_message` are copied to `msg_conversation`, `msg_message`, and `msg_participant_state`, then the old tables are dropped.
- Message identity is finalized onto `initiatoraccountid`, `senderaccountid`, and `accountid`; `msg_conversation.initiatoruserid`, `msg_message.senderid`, `msg_participant_state.userid`, and the `*_identity_sync` trigger functions are dropped.
- plaintext refresh token columns on `sys_user` are nulled and dropped.
- Legacy `sys_visit_log` rows are used only during the same migration transaction to seed aggregate counters, then the entire table and its projection watermark are dropped.

Rollback for this legacy bootstrap path is backup based and its mutation descriptor remains `non_compensable`. Production serve startup now performs read-only schema compatibility checks; it does not execute this legacy mutation path. If an isolated legacy bootstrap or an explicitly approved destructive Contract step fails, keep serving through the compatible image/bridge while it remains valid, or restore the pre-migration site package and database dump according to the online migration runbook.

## Rights V3 Schema Backfill

`20260704-post-article-rights-v3-schema` creates the durable Rights V3 tables documented in [Rights V3 Schema](rights-v3-schema.md):

- `article_rights_policy`
- `article_rights_snapshot`
- `article_rights_proof`

Within the isolated legacy bootstrap, the migration runs after CodeFirst so it can rely on the final `article` and `article_revision` table shapes. It backfills one default policy row for every existing article because historical articles had no editor-authored Rights V3 intent, then creates one rights snapshot for the latest revision of each article that already has revisions. The latest revision is selected by highest `revision_no`, then newest `created_at`, then highest `id`. Snapshot hashes are seeded with `rights-v3:policy-hash:recompute` and `rights-v3:content-hash:recompute`; later Rights V3 canonicalizer/proof work must replace those sentinels before treating the proof as ready.

The backfill is intentionally set-based and guarded by unique indexes, so repeating the isolated legacy bootstrap must keep row counts stable. Articles without revisions get a policy row only and wait for the write path to create their first snapshot. After the migration, create/update writes normalize omitted rights to the same defaults and store policy + revision snapshot + outbox `rightsSnapshotId` in one transaction.

This migration does not write or serve a legacy `rights.aeds` artifact. Public read outputs remain derived artifacts: PublicAOT HTML, article detail AEDS, PublicHotRead, feeds, sitemap, search, and asset manifests must be invalidated or rebuilt through the normal mutation/outbox/projector path after Rights V3 payloads become part of the public frame. Rollback is backup based; a no-restart degradation is to pause Rights V3 proof scheduling/retry while leaving existing public artifacts in place.

## Account Subject Physical Projection Cutover

The anonymous-account cutover preserves existing accounts and comments. `20260711-pre-account-subject-hash-expand` adds nullable `sys_user.account_subject_hash` so the old and new binaries can overlap during a rolling deployment. `20260711-post-account-subject-hash-backfill` then scans missing or malformed rows in `id` keyset batches of 256 and computes each digest with the same C# `AccountSubjectHasher` used by account creation. The migration intentionally does not duplicate .NET case-folding in PostgreSQL SQL, and it is non-transactional so an interrupted run resumes from rows that still need projection.

Before activating the new binary:

1. Drain writers running the previous binary, while keeping read traffic available.
2. Confirm both migration ids are successful in `__fsus_schema_migration_history`.
3. Run the exact completion query below; the result must be `0`.

```sql
SELECT COUNT(*)
FROM sys_user
WHERE account_subject_hash IS NULL OR account_subject_hash = '';
```

4. Also confirm every non-null value matches lowercase SHA-256 hex: `account_subject_hash ~ '^[0-9a-f]{64}$'`.
5. Start the candidate and confirm startup task `accountSubjectHashInvariant=ok` before routing traffic.
6. Create one anonymous account with a public handle and one without a public handle; both rows must receive a physical digest before the account response is returned.

The column remains nullable only for rolling-schema compatibility. It is not optional to the new runtime: token issuance, account-state/blacklist caches, MFA step-up, binary auth and notification admission fail closed when the physical value is absent or malformed. The account snapshot cache namespace is `account:subject-v1:*`, so snapshots written before this projection are never accepted. The permanent startup gate reruns the count/format invariant even after migration history is complete, catching a stale writer that reintroduces null rows.

Rollback does not require a destructive data action. Route traffic back to the previous binary while leaving the additive column in place, correct or backfill affected rows, then retry the candidate. Do not delete projected values or reintroduce account-id-derived runtime fallbacks.

The anonymous account schema keeps `sys_user` as its account container:

- physical `username`, `password`, `role`, `lastusernameupdatetime`, and `last_username_update_time` are dropped by `20260621-post-user-legacy-identity-columns-finalize`; they are not mapped by the `User` entity and must not appear in restored final-state schemas.
- `public_handle` is nullable and uniquely indexed when present.
- `identity_kind` defaults to `anonymous_account`.
- `passkey_enabled`, `recovery_enabled`, and `privacy_initialized_at` record whether the new non-password identity setup has been initialized.
- `anonymous_credential_level` and `anonymous_credential_status` provide a compact projection point for later credential-policy work.

`20260621-pre-sys-user-security-profile-split` creates `user_mfa_profile`, copies existing TOTP secret, pending secret, verified time, and TOTP recovery-code hash out of `sys_user` before CodeFirst sync, then drops `sys_user.lastloginip`, `sys_user.lastlogintime`, and the old `sys_user.mfa*` material columns. `20260621-post-sys-user-security-profile-split-finalize` repeats the old-column drop after legacy post-CodeFirst compatibility migrations, so older descriptors cannot reintroduce pending MFA columns. New login observation remains on `sys_user_session.last_ip` or security/audit event dimensions; `sys_user` must not store raw login IP or last-login timestamps.

Rollback is backup based for dropped `sys_user` columns. A no-restart degradation path is to temporarily stop user-side TOTP mutations at the edge or switch affected sensitive-action policy to require Passkey/Recovery Key step-up while preserving read-only account/session access; do not recreate `lastloginip` or write TOTP material back to `sys_user` in a live schema.

When `FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1` is enabled, application code must not treat legacy `username/password` or `role=admin` as identity, credential, or authority sources for these rows, and must read TOTP material only from `user_mfa_profile`. The legacy identity columns are absent after the finalize migration; rollback is backup based by restoring a pre-finalizer dump into an isolated database.

## Read Event Retirement

The older `20260621-*` and `20260715-pre-visit-log-ip-pseudonym-epoch` descriptors remain replayable so an installation can upgrade from any supported history checksum. They are transitional only; `sys_visit_log` is not part of the final schema.

`20260715-pre-read-event-retirement-compat` creates an empty compatibility table when a fresh database has no legacy table, allowing older descriptors to replay deterministically. After all older backfills have run, `20260715-post-read-event-retirement` executes in one transaction:

```sql
UPDATE daily_read_stats SET unique_viewer_estimate = 0;
DELETE FROM region_read_stats;
DELETE FROM author_route_stats;
DELETE FROM author_daily_read_stats;
DROP TABLE IF EXISTS article_view_projection_watermark;
DROP TABLE IF EXISTS sys_visit_log;
```

CodeFirst creates only `article_read_hourly_aggregate` and `read_dwell_daily_aggregate` for the new read path. The processor also increments the existing daily/event-type counters, but no table contains viewer/proof/device/IP/UA identity, route sequence, exact request timestamp, or exact dwell milliseconds.

Rollback without restarting is `HumanReadProof:Mode=paused`: content remains readable while new counting stops. Do not shift traffic to a build that recreates `sys_visit_log`; a destructive rollback requires restoring a verified pre-migration backup into an isolated environment, never into the live schema. Cross-media deletion and backup/WAL verification continue under [historical raw-IP lifecycle](security/ip-anonymization-lifecycle.md), extended to reject event-level read trajectory fields.

## Message Account Principal Finalization

Message center schema finalization removes the migration-only bridge between legacy user ids and anonymous account ids. `20260620-post-message-account-principal` backfills account/admin-principal columns from older message rows, and `20260621-post-message-legacy-identity-columns-finalize` immediately removes the compatibility surface:

```sql
DROP TRIGGER IF EXISTS trg_msg_conversation_identity_sync ON msg_conversation;
DROP TRIGGER IF EXISTS trg_msg_message_identity_sync ON msg_message;
DROP TRIGGER IF EXISTS trg_msg_participant_identity_sync ON msg_participant_state;
DROP FUNCTION IF EXISTS public.fsusblog_msg_conversation_identity_sync();
DROP FUNCTION IF EXISTS public.fsusblog_msg_message_identity_sync();
DROP FUNCTION IF EXISTS public.fsusblog_msg_participant_identity_sync();
ALTER TABLE msg_conversation DROP COLUMN IF EXISTS initiatoruserid;
ALTER TABLE msg_message DROP COLUMN IF EXISTS senderid;
ALTER TABLE msg_participant_state DROP COLUMN IF EXISTS userid;
```

The final message tables must carry account identity only through `msg_conversation.initiatoraccountid`, `msg_message.senderaccountid`, and `msg_participant_state.accountid`; admin-originated rows use the dedicated admin-principal columns. Rollback without restarting the application is backup based. Do not recreate the sync triggers in a live schema; pause message writes at the edge or restore the pre-migration snapshot for forensic analysis.

## Authoring Admin Principal Attribution

Fresh databases create authoring workspace tables directly with the final admin-principal attribution columns:

```sql
article_draft.owner_admin_principal_id
article_revision.created_by_admin_principal_id
```

The legacy columns `article_draft.owner_user_id` and `article_revision.created_by_user_id` are migration-only inputs. `20260621-pre-authoring-admin-principal-attribution` renames them when possible, copies them into the final columns when both shapes exist, drops the old columns, and recreates the durable `idx_article_draft_admin_principal_key` index. A second migration run must leave only the final admin-principal columns.

Rollback without restarting the application is backup based. Do not recreate the old `owner_user_id` or `created_by_user_id` columns in a live schema; pause admin authoring writes or restore the pre-migration snapshot for forensic analysis.

## Comment Attribution Index Finalization

The comment schema keeps `comment.user_id` and `comment.reply_to_user_id` only as explicit compatibility fields for public attribution and legacy reply projection. Admin moderation records use `comment.moderated_by_admin_principal_id`; default anonymous and strong-anonymous comment paths must not query, authorize, or recover comments through account-bound columns.

Fresh databases create `comment.moderated_by_admin_principal_id` directly. Historical `comment.moderated_by_user_id` is accepted only as a migration input: the compatibility migration renames or copies it into `moderated_by_admin_principal_id`, then drops the old column. Final schema validation and integration tests assert the old moderation column is absent after idempotent migration replay.

`20260621-post-comment-attribution-index-finalize` drops the old generic `idx_comment_user_id_desc` index and creates `idx_comment_attributable_public_user_id_desc`:

```sql
CREATE INDEX IF NOT EXISTS idx_comment_attributable_public_user_id_desc
ON comment(user_id, id DESC)
WHERE author_mode = 'public' AND user_id IS NOT NULL;
```

The older `20260418-post-comment-threading-indexes` descriptor is left immutable because applied migration checksums are verified at startup. New or restored databases may briefly create the old index while replaying legacy descriptors, then the finalizer removes it in the same migration run.

Rollback without restarting the application is limited to the database index shape: recreate `idx_comment_user_id_desc` manually only if an emergency query plan regression is confirmed, then remove it again before reenabling anonymous-comment write traffic. Do not use that fallback to reintroduce default anonymous user-bound queries.
