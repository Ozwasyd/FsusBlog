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
[[ "$("${psql_restore[@]}" -qAtc 'SELECT generation FROM public.blog_user')" == 2 ]]
read_public="SELECT r.title FROM public.article_publication p
JOIN public.article_revision r ON (r.article_id, r.revision) = (p.article_id, p.revision)"
[[ "$("${psql_restore[@]}" -qAtc "$read_public")" == 'Public article' ]]
[[ "$("${psql_restore[@]}" -qAtc 'SELECT title FROM public.article')" == 'Private draft' ]]
[[ "$("${psql_restore[@]}" -qAtc 'SELECT publication_count FROM public.article')" == 1 ]]
[[ "$("${psql_restore[@]}" -qAtc 'SELECT publication_no FROM public.article_publication')" == 1 ]]

"${psql_source[@]}" -c 'ALTER SEQUENCE public.article_id_seq INCREMENT BY 2'
expect_failure 'unexpected-identity-sequence' "${migrate[@]}" verify
"${psql_source[@]}" -c 'ALTER SEQUENCE public.article_id_seq INCREMENT BY 1'
"${psql_source[@]}" -c 'ALTER TABLE public.article DROP CONSTRAINT article_current_revision_fk'
expect_failure 'constraint shape mismatch' "${migrate[@]}" verify
printf '%s\n' "Native PostgreSQL migration checks passed."
