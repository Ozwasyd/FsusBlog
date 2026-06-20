# Database Migration Runbook

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
- `sys_user.username`: legacy shorter length to `varchar(64)`

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
- plaintext refresh token columns on `sys_user` are nulled and dropped.
- `sys_visit_log` is extended into the human-read event source with `site_read` defaults.

Rollback is backup based. Schema migrations are intentionally `non_compensable`; use the pre-migration site package or database dump if the isolated rehearsal or production startup check fails.

## Anonymous Identity Cold-Start Reset

The anonymous-identity cutover intentionally deletes legacy users and historical comments. It is not a data migration and it does not preserve old password login, old `role=admin` semantics, old MFA secrets, old refresh sessions, passkeys bound to legacy users, or historical comment threads.

Run the reset only against an isolated restored database first:

1. Create a full site backup and restore it to an isolated PostgreSQL database.
2. Start the server once with `FSUSBLOG_CONFIRM_IDENTITY_RESET=DELETE_LEGACY_USERS`.
3. Confirm `sys_user`, `sys_user_session`, `passkey_credential`, `account_recovery_key`, `anonymous_credential`, `anonymous_credential_issuance_audit`, `comment`, `comment_anonymous_nullifier`, `comment_region_compliance`, and `comment_moderation_signal` all contain zero legacy/user-bound rows.
4. Confirm user-bound `msg_participant_state`, `msg_message`, and `msg_conversation` rows have been removed.
5. Confirm public ZK circuit/root metadata such as `anonymous_credential_root`, `anonymous_credential_epoch`, and `anonymous_credential_revocation` is either preserved for the new anonymous system or rebuilt by the root lifecycle process; it is not deleted as legacy user data.
6. Repeat the same guarded startup on the production cold-start database only after the rehearsal result is accepted.

If `FSUSBLOG_CONFIRM_IDENTITY_RESET` is missing or has any other value, `LegacyIdentityColdStartResetOperation` fails before opening the destructive transaction. The operation keeps table structures in place for CodeFirst compatibility and deletes rows in dependency order: comment-derived rows, comments, user-bound recovery keys, anonymous credentials, credential issuance audit rows, user-bound messages, passkey credentials, sessions, then users. After the database transaction commits, it clears legacy user cache entries for blacklist/blocking, unread-message counts, and user-comment cursors. Rollback is backup based; do not run this operation without a fresh restore point.

The anonymous account schema migration keeps `sys_user` but changes its meaning after reset:

- `username` and `password` become nullable legacy compatibility columns.
- `public_handle` is nullable and uniquely indexed when present.
- `identity_kind` defaults to `anonymous_account`.
- `passkey_enabled`, `recovery_enabled`, and `privacy_initialized_at` record whether the new non-password identity setup has been initialized.
- `anonymous_credential_level` and `anonymous_credential_status` provide a compact projection point for later credential-policy work.

When `FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1` is enabled, application code must not treat `username/password` or `role=admin` as authority sources for these rows.

## Comment Attribution Index Finalization

The comment schema keeps `comment.user_id`, `comment.reply_to_user_id`, and `comment.moderated_by_user_id` only as explicit compatibility fields for public attribution, legacy reply projection, and admin moderation records. Default anonymous and strong-anonymous comment paths must not query, authorize, or recover comments through these columns.

`20260621-post-comment-attribution-index-finalize` drops the old generic `idx_comment_user_id_desc` index and creates `idx_comment_attributable_public_user_id_desc`:

```sql
CREATE INDEX IF NOT EXISTS idx_comment_attributable_public_user_id_desc
ON comment(user_id, id DESC)
WHERE author_mode = 'public' AND user_id IS NOT NULL;
```

The older `20260418-post-comment-threading-indexes` descriptor is left immutable because applied migration checksums are verified at startup. New or restored databases may briefly create the old index while replaying legacy descriptors, then the finalizer removes it in the same migration run.

Rollback without restarting the application is limited to the database index shape: recreate `idx_comment_user_id_desc` manually only if an emergency query plan regression is confirmed, then remove it again before reenabling anonymous-comment write traffic. Do not use that fallback to reintroduce default anonymous user-bound queries.
