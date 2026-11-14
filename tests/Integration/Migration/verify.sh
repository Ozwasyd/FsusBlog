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
  if ! rm -f -- "$scratch/plan.json" "$scratch/backup.dump" "$scratch/error.log" ||
     ! rmdir -- "$scratch"; then
    printf 'Artifact cleanup failed: %s\n' "$scratch" >&2
    if ((code == 0)); then code=1; fi
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
"${migrate[@]}" verify
expect_failure 'requires an empty database' "${migrate[@]}" apply "$scratch/plan.json"

ticket=$("${migrate[@]}" operator 'Native author')
[[ "$ticket" =~ ^[0-9a-f]{64}$ ]]
digest="$(printf '%s' "$ticket" | xxd -r -p | openssl dgst -sha256 | awk '{print $NF}')"
[[ "$("${psql_source[@]}" -qAtc 'SELECT encode(digest, $f$hex$f$) FROM public.login_ticket')" == "$digest" ]]
unset ticket digest
"${migrate[@]}" revoke 'Native author'
[[ "$("${psql_source[@]}" -qAtc 'SELECT count(*) FROM public.login_ticket')" == 0 ]]
[[ "$("${psql_source[@]}" -qAtc 'SELECT generation FROM public.blog_user')" == 2 ]]

"${psql_source[@]}" -c 'UPDATE public.v2_schema SET version = 99'
expect_failure 'schema marker at version 1' "${migrate[@]}" verify
"${psql_source[@]}" -c 'UPDATE public.v2_schema SET version = 1'
pg_dump --no-password --format=custom --dbname "$source_db" --file "$scratch/backup.dump"
pg_restore --no-password --single-transaction --exit-on-error --dbname "$restore_db" "$scratch/backup.dump"
FSUSBLOG_DB="$settings;Database=$restore_db" "${migrate[@]}" verify
[[ "$("${psql_restore[@]}" -qAtc 'SELECT generation FROM public.blog_user')" == 2 ]]

"${psql_source[@]}" -c 'ALTER TABLE public.article DROP CONSTRAINT article_current_revision_fk'
expect_failure 'constraint shape mismatch' "${migrate[@]}" verify
printf '%s\n' "Native PostgreSQL migration checks passed. Dropping the two test databases."
