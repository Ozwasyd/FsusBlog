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
3. Confirm `sys_user`, `sys_user_session`, `passkey_credential`, `comment`, `comment_region_compliance`, and `comment_moderation_signal` all contain zero rows.
4. Confirm user-bound `msg_participant_state`, `msg_message`, and `msg_conversation` rows have been removed.
5. Repeat the same guarded startup on the production cold-start database only after the rehearsal result is accepted.

If `FSUSBLOG_CONFIRM_IDENTITY_RESET` is missing or has any other value, `LegacyIdentityColdStartResetOperation` fails before opening the destructive transaction. The operation keeps table structures in place for CodeFirst compatibility and deletes rows in dependency order: comment-derived rows, comments, user-bound messages, passkey credentials, sessions, then users. After the database transaction commits, it clears legacy user cache entries for blacklist/blocking, unread-message counts, and user-comment cursors. Rollback is backup based; do not run this operation without a fresh restore point.
