#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
dotnet_bin="${DOTNET_BIN:-dotnet}"
libpq_bin="${PG_TOOLS_DIR:-}"
if [[ -n "$libpq_bin" ]]; then
  PATH="$libpq_bin:$PATH"
fi

if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" ]]; then
  printf '%s\n' "Set FSUSBLOG_TEST_DB, PGHOST and PGUSER to the same isolated PostgreSQL test cluster." >&2
  exit 2
fi

settings="${FSUSBLOG_TEST_DB%;}"
for tool in psql pg_dump pg_restore openssl xxd rg; do
  command -v "$tool" >/dev/null
done
psql_main=(psql -X --no-password -v ON_ERROR_STOP=1 --dbname postgres)
umask 077
scratch="$(mktemp -d "${TMPDIR:-/tmp}/fsusv2-migration.XXXXXXXX")"
source_db="fsusv2_native_$(openssl rand -hex 12)"
restore_db="${source_db}_restore"
created_source=0
created_restore=0
cleanup() {
  code=$?
  trap - EXIT
  if ((created_restore == 1)); then
    if ! "${psql_main[@]}" -c "DROP DATABASE \"$restore_db\"" >&2; then
      printf 'Database cleanup failed: %s\n' "$restore_db" >&2
      if ((code == 0)); then code=1; fi
    fi
  fi
  if ((created_source == 1)); then
    if ! "${psql_main[@]}" -c "DROP DATABASE \"$source_db\"" >&2; then
      printf 'Database cleanup failed: %s\n' "$source_db" >&2
      if ((code == 0)); then code=1; fi
    fi
  fi
  if ! rm -f -- "$scratch/plan.json" "$scratch/backup.dump" "$scratch/error.log" "$scratch/inventory.json" ||
     ! rmdir -- "$scratch"; then
    printf 'Artifact cleanup failed: %s\n' "$scratch" >&2
    if ((code == 0)); then code=1; fi
  fi
  if ((code == 0)); then
    printf '%s\n' "Removed both test databases and scratch files."
  fi
  exit "$code"
}
trap cleanup EXIT

migrate_project="src/Migrate/FsusBlogV2.Migrate.csproj"
"$dotnet_bin" restore "$migrate_project" --configfile NuGet.Config --locked-mode
"$dotnet_bin" build "$migrate_project" --no-restore
migrate=("$dotnet_bin" src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll)

expect_failure() {
  local expected="$1"
  shift
  if "$@" > "$scratch/error.log" 2>&1; then
    printf 'Expected failure containing %s\n' "$expected" >&2
    return 1
  fi
  if ! rg -F "$expected" "$scratch/error.log"; then
    cat "$scratch/error.log" >&2
    return 1
  fi
}

"${psql_main[@]}" -c "CREATE DATABASE \"$source_db\" TEMPLATE template0"
created_source=1
"${psql_main[@]}" -c "CREATE DATABASE \"$restore_db\" TEMPLATE template0"
created_restore=1
export FSUSBLOG_DB="$settings;Database=$source_db"
psql_source=(psql -X --no-password -v ON_ERROR_STOP=1 --dbname "$source_db")
psql_restore=(psql -X --no-password -v ON_ERROR_STOP=1 --dbname "$restore_db")

printf 'PostgreSQL source version: '
"${psql_source[@]}" -qAtc 'SHOW server_version'
printf 'PG tools: '
pg_restore --version

expect_failure 'relation/column shape mismatch' "${migrate[@]}" verify
"${migrate[@]}" inventory
"${migrate[@]}" plan > "$scratch/plan.json"
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'plan targets a different database' "${migrate[@]}" apply "$scratch/plan.json"
"${migrate[@]}" apply "$scratch/plan.json"
FSUSBLOG_DB="$FSUSBLOG_DB;Options=-c default_transaction_read_only=on" "${migrate[@]}" verify
expect_failure 'requires an empty database' "${migrate[@]}" apply "$scratch/plan.json"

ticket=$("${migrate[@]}" operator 'Native author')
[[ "$ticket" =~ ^[0-9a-f]{64}$ ]]
digest="$(printf '%s' "$ticket" | xxd -r -p | openssl dgst -sha256 | awk '{print $NF}')"
[[ "$("${psql_source[@]}" -qAtc "SELECT encode(digest, 'hex') FROM public.login_ticket")" == "$digest" ]]
unset ticket digest
"${migrate[@]}" revoke 'Native author'
[[ "$("${psql_source[@]}" -qAtc 'SELECT count(*) FROM public.login_ticket')" == 0 ]]
[[ "$("${psql_source[@]}" -qAtc 'SELECT generation FROM public.blog_user')" == 2 ]]

"${psql_source[@]}" <<'SQL'
BEGIN;
INSERT INTO public.article (owner_id, revision, title, body, deleted, published_revision, publication_count)
    SELECT id, 2, 'Private draft', 'Unpublished changes', false, 1, 1 FROM public.blog_user;
INSERT INTO public.article_revision (article_id, revision, title, body, happened_at)
    SELECT id, 1, 'Public article', 'Published body', now() FROM public.article
    UNION ALL
    SELECT id, revision, title, body, now() FROM public.article;
INSERT INTO public.article_publication (article_id, revision, published_at)
    SELECT id, published_revision, now() FROM public.article;
COMMIT;
SQL

"${psql_source[@]}" -c 'UPDATE public.v2_schema SET version = 99'
expect_failure 'schema marker at version 1' "${migrate[@]}" verify
"${psql_source[@]}" -c 'UPDATE public.v2_schema SET version = 1'
"${psql_source[@]}" -c 'UPDATE public.article_publication SET revision = 2'
expect_failure 'inconsistent publication coordinates' "${migrate[@]}" verify
"${psql_source[@]}" -c 'UPDATE public.article_publication SET revision = 1'
"${psql_source[@]}" -c 'UPDATE public.article_publication SET publication_no = 2'
expect_failure 'inconsistent publication coordinates' "${migrate[@]}" verify
"${psql_source[@]}" -c 'UPDATE public.article_publication SET publication_no = 1'
"${migrate[@]}" inventory --counts > "$scratch/inventory.json"
rg -A 3 '"name": "article",' "$scratch/inventory.json" | rg -F '"rows": 1'
pg_dump --no-password --format=custom --dbname "$source_db" --file "$scratch/backup.dump"
pg_restore --no-password --single-transaction --exit-on-error --dbname "$restore_db" "$scratch/backup.dump"
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify

# A database older than the edit component still verifies, but a partial installation is invalid.
"${psql_restore[@]}" -c 'DROP TABLE public.comment_author_edit_outbox'
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'Comment author edit storage is incomplete.' "${migrate[@]}" verify
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'Comment author edit storage is incomplete.' "${migrate[@]}" comment author-edit-schema
"${psql_restore[@]}" -c 'DROP TABLE public.comment_author_edit_challenge, public.comment_author_edited'
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" comment author-edit-schema
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" comment author-edit-schema
"${psql_restore[@]}" -c 'ALTER TABLE public.comment_author_edited DROP CONSTRAINT comment_author_edited_next_version_check'
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'constraint shape mismatch' "${migrate[@]}" comment author-edit-schema
"${psql_restore[@]}" -c 'ALTER TABLE public.comment_author_edited ADD CONSTRAINT comment_author_edited_next_version_check CHECK (comment_version = previous_version + 1)'
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify

"${psql_restore[@]}" -c 'DROP TABLE public.comment_report'
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" comment report-schema
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" comment report-schema
"${psql_restore[@]}" -c 'ALTER TABLE public.comment_report DROP CONSTRAINT comment_report_article_id_comment_id_reporter_id_key'
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'constraint shape mismatch' "${migrate[@]}" comment report-schema
"${psql_restore[@]}" -c 'ALTER TABLE public.comment_report ADD UNIQUE (article_id, comment_id, reporter_id)'
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify

source_site=$("${psql_source[@]}" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')
restore_site=$("${psql_restore[@]}" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')
[[ -n "$source_site" && "$source_site" == "$restore_site" ]]
"${migrate[@]}" recovery-scope
[[ "$source_site" == "$("${psql_source[@]}" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')" ]]
"${psql_restore[@]}" <<'SQL'
DROP TABLE public.author_recent_open, public.author_recent_open_receipt, public.author_recent_open_collection,
    public.authoring_recovery_site;
SQL
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'relation/column shape mismatch' "${migrate[@]}" verify
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" recovery-scope
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" author-recent-opens
new_site=$("${psql_restore[@]}" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')
[[ -n "$new_site" && "$new_site" != "$source_site" ]]
[[ "$("${psql_restore[@]}" -qAtc 'SELECT generation FROM public.blog_user')" == 2 ]]
read_public="SELECT r.title FROM public.article_publication p
JOIN public.article_revision r ON (r.article_id, r.revision) = (p.article_id, p.revision)"
[[ "$("${psql_restore[@]}" -qAtc "$read_public")" == 'Public article' ]]
[[ "$("${psql_restore[@]}" -qAtc 'SELECT title FROM public.article')" == 'Private draft' ]]
[[ "$("${psql_restore[@]}" -qAtc 'SELECT publication_count FROM public.article')" == 1 ]]
[[ "$("${psql_restore[@]}" -qAtc 'SELECT publication_no FROM public.article_publication')" == 1 ]]

"${psql_restore[@]}" <<'SQL'
BEGIN;
INSERT INTO public.article (owner_id, revision, title, body, deleted, publication_count)
    SELECT id, 5, 'Previously withdrawn', 'Private body', false, 2 FROM public.blog_user;
INSERT INTO public.article_revision (article_id, revision, title, body, happened_at)
    SELECT id, revision, title, body, now() FROM public.article WHERE title = 'Previously withdrawn';
DROP TABLE public.publication_transparency_head, public.article_publication_transparency,
    public.article_publication_proof, public.publication_proof_key, public.article_publication_canonical;
ALTER TABLE public.article_publication_rights DROP CONSTRAINT publication_rights_native_binding;
ALTER TABLE public.blog_outbox DROP CONSTRAINT outbox_native_publication_binding;
DROP TABLE IF EXISTS public.article_publication_media;
DROP TABLE public.article_publication_history, public.admin_article_rollback, public.admin_article_rollback_step_up,
    public.article_publication_responsibility, public.article_revision_responsibility;
COMMIT;
SQL
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'relation/column shape mismatch' "${migrate[@]}" verify
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" publication-history
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" publication-history
retained=$("${psql_restore[@]}" -qAtc "SELECT concat_ws('|',event_no,revision,publication_no,coalesce(publication_id,0),
    kind,reason,(happened_at IS NOT NULL)::text,(actor_id IS NULL)::text) FROM public.article_publication_history ORDER BY article_id")
active=$("${psql_restore[@]}" -qAtc 'SELECT publication_id FROM public.article_publication')
[[ "$retained" == $'1|1|1|'"$active"$'|retained-active|pre-history|true|true\n1|5|2|0|retained-hidden|pre-history|false|true' ]]
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify
"${psql_restore[@]}" -c "UPDATE public.article_publication_history SET reason = 'changed' WHERE kind = 'retained-active'"
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'inconsistent publication history' "${migrate[@]}" verify
"${psql_restore[@]}" -c "UPDATE public.article_publication_history SET reason = 'pre-history' WHERE kind = 'retained-active'"
"${psql_restore[@]}" -c 'DROP TABLE public.article_schedule, public.article_schedule_receipt'
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'relation/column shape mismatch' "${migrate[@]}" verify
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" article-schedule
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" article-schedule
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify
[[ "$("${psql_restore[@]}" -qAtc 'SELECT count(*) FROM public.article_schedule')" == 0 ]]
[[ "$("${psql_restore[@]}" -qAtc 'SELECT publication_id FROM public.article_publication')" == "$active" ]]

"${psql_restore[@]}" -c 'DROP TABLE public.article_publication_rights, public.article_revision_rights'
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'relation/column shape mismatch' "${migrate[@]}" verify
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" publication-rights
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" publication-rights
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify
[[ "$("${psql_restore[@]}" -qAtc 'SELECT count(*) FROM public.article_publication_rights')" == 0 ]]
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" admin-article-rollback schema
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" publication-canonical schema
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" publication-proof schema
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" publication-proof schema
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" publication-canonical verify | rg -Fx '{"canonicalVersion":2,"verifiedPublications":0}'
[[ "$("${psql_restore[@]}" -qAtc 'SELECT publication_id FROM public.article_publication')" == "$active" ]]

# Exercise outbox verification after both retained and native publication boundaries.
"${psql_restore[@]}" <<'SQL'
BEGIN;
INSERT INTO public.blog_outbox (article_id, revision, kind)
SELECT article_id, revision, CASE kind WHEN 'retained-active' THEN 'publish' ELSE 'retract' END
FROM public.article_publication_history WHERE kind IN ('retained-active', 'retained-hidden');

INSERT INTO public.admin_principal (id, handle, user_handle, enabled, generation)
VALUES ('27d50f12-dd1a-4747-8752-d1d59dc8903a', 'migration-history-fixture', decode(repeat('5a',32),'hex'), true, 1);
INSERT INTO public.article (owner_id, revision, title, body, deleted, published_revision, publication_count)
SELECT id, 5, 'Draft after archive restore', 'Private draft body', false, 4, 4 FROM public.blog_user
RETURNING id AS article \gset
INSERT INTO public.article_revision (article_id, revision, title, body, happened_at)
SELECT :article, revision, title, body, '2026-01-01T00:00:00Z'::timestamptz + revision * interval '1 minute'
FROM (VALUES (1,'First release','Recorded source body'), (2,'Replacement release','Replacement body'),
    (3,'First release','Recorded source body'), (4,'First release','Recorded source body'),
    (5,'Draft after archive restore','Private draft body')) fixture(revision,title,body);
INSERT INTO public.article_command (actor_id, command_id, fingerprint, article_id, revision, title, body, published)
SELECT a.owner_id, gen_random_uuid(), decode(repeat('4a',32),'hex'), r.article_id, r.revision, r.title, r.body, true
FROM public.article_revision r JOIN public.article a ON a.id = r.article_id
WHERE r.article_id = :article AND r.revision IN (1,2);
INSERT INTO public.article_publication_history (article_id, event_no, revision, publication_no, publication_id,
    supersedes_id, kind, reason, happened_at, actor_id, command_id)
SELECT r.article_id, r.revision, r.revision, r.revision, 100+r.revision, CASE WHEN r.revision=2 THEN 101 END,
    CASE r.revision WHEN 1 THEN 'publish' ELSE 'replace' END,
    CASE r.revision WHEN 1 THEN 'author-published' ELSE 'author-replaced' END, r.happened_at, c.actor_id, c.command_id
FROM public.article_revision r JOIN public.article_command c ON (c.article_id, c.revision) = (r.article_id, r.revision)
WHERE r.article_id = :article;
INSERT INTO public.article_revision_rights
SELECT article_id, revision, true, 'CC-BY-4.0', 'Fixture holder', 2026, 'Fixture rights', '',
       'append-attribution', 40, true, true, false
FROM public.article_revision WHERE article_id = :article;
INSERT INTO public.article_publication_rights (article_id, publication_id, revision)
SELECT article_id, 100+revision, revision FROM public.article_revision WHERE article_id = :article AND revision <= 4;
INSERT INTO public.article_revision_responsibility (article_id, revision, responsible_party, basis, reference, recorded_by)
VALUES (:article, 1, 'Fixture claimant', 'Original fixture evidence', 'history-fixture-record', current_user);
INSERT INTO public.article_revision_responsibility (article_id, revision, responsible_party, basis, reference, recorded_by, source_snapshot_id)
SELECT article_id, 3, responsible_party, basis, reference, recorded_by, id
FROM public.article_revision_responsibility WHERE article_id = :article AND revision = 1;
INSERT INTO public.article_revision_responsibility (article_id, revision, responsible_party, basis, reference, recorded_by, source_snapshot_id)
SELECT article_id, 4, responsible_party, basis, reference, recorded_by, id
FROM public.article_revision_responsibility WHERE article_id = :article AND revision = 3;
INSERT INTO public.article_publication_responsibility (publication_id, article_id, revision, snapshot_id)
SELECT 100+revision, article_id, revision, id FROM public.article_revision_responsibility WHERE article_id = :article;
INSERT INTO public.admin_article_rollback (principal_id, command_id, fingerprint, article_id, previous_revision, source_revision,
    revision, source_publication_id, previous_publication_id, publication_id, publication_no, published_at,
    rights_snapshot_id, responsibility_snapshot_id, reason, destination, from_archive)
SELECT '27d50f12-dd1a-4747-8752-d1d59dc8903a', gen_random_uuid(), decode(repeat('3a',32),'hex'), r.article_id, r.revision-1, 1,
    r.revision, 101, 99+r.revision, w.publication_id, r.revision, r.happened_at,
    w.id, d.id, 'Verified fixture lineage', CASE r.revision WHEN 3 THEN 3 ELSE 2 END, r.revision=4
FROM public.article_revision r
JOIN public.article_publication_rights w ON (w.article_id, w.revision) = (r.article_id, r.revision)
JOIN public.article_revision_responsibility d ON (d.article_id, d.revision) = (r.article_id, r.revision)
WHERE r.article_id = :article AND r.revision IN (3,4);
INSERT INTO public.article_publication_history (article_id, event_no, revision, publication_no, publication_id, supersedes_id,
    kind, reason, happened_at, admin_actor_id, admin_command_id)
SELECT article_id, revision, revision, publication_no, CASE WHEN from_archive THEN publication_id END,
    CASE WHEN NOT from_archive THEN previous_publication_id END, CASE WHEN from_archive THEN 'publish' ELSE 'retract' END,
    CASE WHEN from_archive THEN 'administrator-archive-republished' ELSE 'administrator-rollback-archived' END,
    published_at, principal_id, command_id
FROM public.admin_article_rollback WHERE article_id = :article;
INSERT INTO public.article_publication (article_id, publication_id, revision, publication_no, published_at)
SELECT article_id, publication_id, revision, publication_no, happened_at
FROM public.article_publication_history WHERE article_id = :article AND revision = 4;
ALTER SEQUENCE public.article_publication_publication_id_seq RESTART WITH 105;
INSERT INTO public.blog_outbox (article_id, revision, kind)
VALUES (:article,1,'publish'), (:article,2,'publish'), (:article,2,'publish'), (:article,3,'retract'), (:article,4,'publish');
COMMIT;
SQL
(
  export FSUSBLOG_DB="$settings;Database=$restore_db"
  history_article=$("${psql_restore[@]}" -qAtc "SELECT id FROM public.article WHERE title = 'Draft after archive restore'")
  [[ "$history_article" =~ ^[1-9][0-9]*$ ]]
  history_error="Article $history_article has inconsistent publication history."
  # An ordinary replacement requires a matching publish event and accepts multiple copies.
  "${migrate[@]}" verify
  for entry in '3 retract duplicate-archive' '4 publish duplicate-restore' \
      '5 publish orphan-after-boundary' '2 delete wrong-kind-at-replacement'; do
    read -r revision kind label <<< "$entry"
    printf 'Reject %s outbox at revision %s.\n' "$label" "$revision"
    outbox_id=$("${psql_restore[@]}" -qAtc "INSERT INTO public.blog_outbox (article_id,revision,kind)
      VALUES ($history_article,$revision,'$kind') RETURNING id")
    [[ "$outbox_id" =~ ^[1-9][0-9]*$ ]]
    expect_failure "$history_error" "${migrate[@]}" verify
    "${psql_restore[@]}" -qc "DELETE FROM public.blog_outbox WHERE id=$outbox_id"
  done
  for entry in '2 publish' '3 retract' '4 publish'; do
    read -r revision kind <<< "$entry"
    printf 'Reject missing %s outbox at revision %s.\n' "$kind" "$revision"
    "${psql_restore[@]}" -qc "DELETE FROM public.blog_outbox
      WHERE article_id=$history_article AND revision=$revision AND kind='$kind'"
    expect_failure "$history_error" "${migrate[@]}" verify
    "${psql_restore[@]}" -qc "INSERT INTO public.blog_outbox (article_id,revision,kind)
      VALUES ($history_article,$revision,'$kind')"
  done
  "${migrate[@]}" verify
)

# A new database always has optional subscription storage. A current database from before it still verifies.
[[ "$("${psql_source[@]}" -qAtc 'SELECT count(*) FROM public.site_subscription')" == 0 ]]
"${psql_restore[@]}" -c 'DROP TABLE public.site_subscription'
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify
FSUSBLOG_DB="$settings;Database=$restore_db" \
  FSUSBLOG_SUBSCRIPTION_HMAC_KEY=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f \
  expect_failure 'relation/column shape mismatch' "${migrate[@]}" site-subscription issue-cancel email <<< 'fixture@example.invalid'
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" site-subscription schema
"${psql_restore[@]}" -c "INSERT INTO public.site_subscription (email_key,channel,enabled,created_at,unsubscribed_at)
    VALUES (decode(repeat('ab',32),'hex'),2,false,'2026-01-01 00:00:00+00','2026-01-02 00:00:00+00')"
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" site-subscription schema
[[ "$("${psql_restore[@]}" -qAtc 'SELECT channel FROM public.site_subscription WHERE NOT enabled AND unsubscribed_at IS NOT NULL')" == 2 ]]
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify
"${psql_restore[@]}" -c 'ALTER TABLE public.site_subscription DROP CONSTRAINT site_subscription_channel_check'
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'constraint shape mismatch' "${migrate[@]}" verify
FSUSBLOG_DB="$settings;Database=$restore_db" expect_failure 'constraint shape mismatch' "${migrate[@]}" site-subscription schema

"${psql_source[@]}" -c 'ALTER SEQUENCE public.article_id_seq INCREMENT BY 2'
expect_failure 'unexpected-identity-sequence' "${migrate[@]}" verify
"${psql_source[@]}" -c 'ALTER SEQUENCE public.article_id_seq INCREMENT BY 1'
"${psql_source[@]}" -c 'ALTER TABLE public.article DROP CONSTRAINT article_current_revision_fk'
expect_failure 'constraint shape mismatch' "${migrate[@]}" verify
printf '%s\n' "Native PostgreSQL migration checks passed."
