# Database Migration Runbook

## 字段最终态表

The table below is the authoritative final-state inventory for legacy identity columns that are either removed from the physical schema or retained only for an explicit compatibility purpose. Keep it synchronized with `src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs`; `tools/db/migration-doc-lint.mjs` fails when the registry and this table diverge.

| column | physical | code-mapped | kept-for | dropped-at-version |
|--------|----------|-------------|----------|--------------------|
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
| `comment.user_id` | present nullable | yes | explicit public attribution compatibility | n/a |
| `comment.reply_to_user_id` | present nullable | yes | legacy public reply projection | n/a |
| `comment.moderated_by_user_id` | dropped | no | renamed to comment.moderated_by_admin_principal_id | 20260621-pre-comment-moderation-admin-principal-attribution |
| `sys_visit_log.userid` | dropped | no | legacy human-read account binding only | 20260621-post-visit-log-anonymous-attribution-finalize |
| `sys_visit_log.user_id` | dropped | no | legacy human-read account binding only | 20260621-post-visit-log-anonymous-attribution-finalize |
| `sys_visit_log.ip` | dropped | no | replaced by sys_visit_log.ip_hash | 20260621-post-visit-log-ip-anonymization |

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

If any shrinking field contains oversized data, startup fails with a message containing `Legacy 20260517 length check failed`, the table name, column name, affected row count, observed max length, and expected max length. Do not truncate production data in place. Export the offending rows, decide the canonical replacement values, update them explicitly, then rerun the migration.

The upgrade also moves legacy content and messaging structures:

- `article.content` is copied to `article_body.markdown_content`, then the old column is dropped.
- `article.views` is copied to `article_view_seed.legacy_views`.
- `Page_*` and `sys:page:*` entries in `sys_systemconfig` are copied to `page_content`, then removed from `sys_systemconfig`.
- `sys_message` and `sys_user_message` are copied to `msg_conversation`, `msg_message`, and `msg_participant_state`, then the old tables are dropped.
- Message identity is finalized onto `initiatoraccountid`, `senderaccountid`, and `accountid`; `msg_conversation.initiatoruserid`, `msg_message.senderid`, `msg_participant_state.userid`, and the `*_identity_sync` trigger functions are dropped.
- plaintext refresh token columns on `sys_user` are nulled and dropped.
- `sys_visit_log` is extended into the human-read event source with `site_read` defaults.
- `sys_visit_log.userid` and `sys_visit_log.user_id` are dropped after human-read attribution is finalized.

Rollback is backup based. Schema migrations are intentionally `non_compensable`; use the pre-migration site package or database dump if the isolated rehearsal or production startup check fails.

## Rights V3 Schema Backfill

`20260704-post-article-rights-v3-schema` creates the durable Rights V3 tables documented in [Rights V3 Schema](rights-v3-schema.md):

- `article_rights_policy`
- `article_rights_snapshot`
- `article_rights_proof`

The migration runs after CodeFirst so it can rely on the final `article` and `article_revision` table shapes. It backfills one default policy row for every existing article, then creates one rights snapshot for the latest revision of each article that already has revisions. The latest revision is selected by highest `revision_no`, then newest `created_at`, then highest `id`. Snapshot hashes are seeded with `rights-v3:policy-hash:recompute` and `rights-v3:content-hash:recompute`; later Rights V3 canonicalizer/proof work must replace those sentinels before treating the proof as ready.

The backfill is intentionally set-based and guarded by unique indexes, so repeating startup must keep row counts stable. Articles without revisions get a policy row only and wait for the write path to create their first snapshot.

This migration does not write or serve a legacy `rights.aeds` artifact. Public read outputs remain derived artifacts: PublicAOT HTML, article detail AEDS, PublicHotRead, feeds, sitemap, search, and asset manifests must be invalidated or rebuilt through the normal mutation/outbox/projector path after Rights V3 payloads become part of the public frame. Rollback is backup based; a no-restart degradation is to pause Rights V3 proof scheduling/retry while leaving existing public artifacts in place.

## Anonymous Identity Cold-Start Reset

The anonymous-identity cutover intentionally deletes legacy users and historical comments. It is not a data migration and it does not preserve old password login, old `role=admin` semantics, old MFA secrets, old refresh sessions, passkeys bound to legacy users, or historical comment threads.

Run the reset only against an isolated restored database first:

1. Create a full site backup and restore it to an isolated PostgreSQL database.
2. Start the server once with `FSUSBLOG_CONFIRM_IDENTITY_RESET=DELETE_LEGACY_USERS`.
3. Confirm `sys_user`, `sys_user_session`, `passkey_credential`, `account_recovery_key`, `anonymous_credential`, `anonymous_credential_issuance_audit`, `comment`, `comment_anonymous_nullifier`, `comment_blocked_region`, `comment_region_compliance`, and `comment_moderation_signal` all contain zero legacy/user-bound rows.
4. Confirm user-bound `msg_participant_state`, `msg_message`, and `msg_conversation` rows have been removed.
5. Confirm public ZK circuit/root metadata such as `anonymous_credential_root`, `anonymous_credential_epoch`, and `anonymous_credential_revocation` is either preserved for the new anonymous system or rebuilt by the root lifecycle process; it is not deleted as legacy user data.
6. Repeat the same guarded startup on the production cold-start database only after the rehearsal result is accepted.

If `FSUSBLOG_CONFIRM_IDENTITY_RESET` is missing or has any other value, `LegacyIdentityColdStartResetOperation` fails before opening the destructive transaction. The operation keeps table structures in place for CodeFirst compatibility and deletes rows in dependency order: comment-derived rows, comments, user-bound recovery keys, anonymous credentials, credential issuance audit rows, user-bound messages, passkey credentials, sessions, then users. After the database transaction commits, it clears legacy user cache entries for blacklist/blocking, unread-message counts, and user-comment cursors. Rollback is backup based; do not run this operation without a fresh restore point.

The anonymous account schema migration keeps `sys_user` but changes its meaning after reset:

- physical `username`, `password`, `role`, `lastusernameupdatetime`, and `last_username_update_time` are dropped by `20260621-post-user-legacy-identity-columns-finalize`; they are not mapped by the `User` entity and must not appear in restored final-state schemas.
- `public_handle` is nullable and uniquely indexed when present.
- `identity_kind` defaults to `anonymous_account`.
- `passkey_enabled`, `recovery_enabled`, and `privacy_initialized_at` record whether the new non-password identity setup has been initialized.
- `anonymous_credential_level` and `anonymous_credential_status` provide a compact projection point for later credential-policy work.

`20260621-pre-sys-user-security-profile-split` creates `user_mfa_profile`, copies existing TOTP secret, pending secret, verified time, and TOTP recovery-code hash out of `sys_user` before CodeFirst sync, then drops `sys_user.lastloginip`, `sys_user.lastlogintime`, and the old `sys_user.mfa*` material columns. `20260621-post-sys-user-security-profile-split-finalize` repeats the old-column drop after legacy post-CodeFirst compatibility migrations, so older descriptors cannot reintroduce pending MFA columns. New login observation remains on `sys_user_session.last_ip` or security/audit event dimensions; `sys_user` must not store raw login IP or last-login timestamps.

Rollback is backup based for dropped `sys_user` columns. A no-restart degradation path is to temporarily stop user-side TOTP mutations at the edge or switch affected sensitive-action policy to require Passkey/Recovery Key step-up while preserving read-only account/session access; do not recreate `lastloginip` or write TOTP material back to `sys_user` in a live schema.

When `FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1` is enabled, application code must not treat legacy `username/password` or `role=admin` as identity, credential, or authority sources for these rows, and must read TOTP material only from `user_mfa_profile`. The legacy identity columns are absent after the finalize migration; rollback is backup based by restoring a pre-finalizer dump into an isolated database.

## Visit Log Anonymous Attribution Finalization

`sys_visit_log` is the single event source for human-read article and site statistics. The final attribution shape is anonymous: `ip_hash`, `viewer_key_hash`, `proof_id`, `event_type`, `route_key`, `article_id`, `dwell_ms`, region, and timestamp. It must not retain account binding columns or raw client IP addresses.

`20260621-post-visit-log-anonymous-attribution-finalize` drops both historical spellings:

```sql
ALTER TABLE sys_visit_log DROP COLUMN IF EXISTS userid;
ALTER TABLE sys_visit_log DROP COLUMN IF EXISTS user_id;
```

`20260621-post-visit-log-ip-anonymization` adds the anonymous IP hash column and removes the historical raw IP column:

```sql
ALTER TABLE sys_visit_log ADD COLUMN IF NOT EXISTS ip_hash varchar(64) NOT NULL DEFAULT '';
ALTER TABLE sys_visit_log DROP COLUMN IF EXISTS ip;
```

`ip_hash` is generated by the server with HMAC-SHA256 using `VisitLog:IpHashPepper`. Missing or template pepper values are production startup failures and runtime services fail closed; there is no JWT secret fallback. The migration intentionally does not SQL-backfill historical raw IP values because the pepper must not be embedded in migration SQL.

Rollback without restarting the application is limited to restoring a backup snapshot for forensic analysis. Do not recreate account binding columns or raw `ip` in a live schema; pausing `HumanReadProof:Mode` can stop new counter writes while preserving public read access.

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
