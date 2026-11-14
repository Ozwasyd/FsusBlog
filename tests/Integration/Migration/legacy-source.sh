#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
dotnet_bin="${DOTNET_BIN:-dotnet}"
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi

provider="${1:-}"
if [[ "$provider" != sqlite && "$provider" != postgres && "$provider" != mysql ]]; then
    printf 'Usage: %s sqlite|postgres|mysql\n' "$0" >&2
    exit 2
fi
if [[ "$provider" == postgres && ( -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" ) ]]; then
    printf '%s\n' "Set FSUSBLOG_TEST_DB, PGHOST and PGUSER to the same isolated PostgreSQL test cluster." >&2
    exit 2
fi
if [[ "$provider" == mysql ]]; then
    # shellcheck source=tests/Integration/Migration/mysql-scratch.sh
    source tests/Integration/Migration/mysql-scratch.sh
    check_mysql_tools
fi
umask 077
if [[ "$provider" == mysql ]]; then
    # Keep the Unix socket path below macOS and Linux limits.
    scratch="$(mktemp -d "/tmp/fsusv2-legacy.XXXXXXXX")"
    scratch="$(cd "$scratch" && pwd -P)"
else
    scratch="$(mktemp -d "${TMPDIR:-/tmp}/fsusv2-legacy.XXXXXXXX")"
fi
fixture="tests/Integration/Migration/legacy-source-fixture.sql"
database="fsusv2_legacy_$(openssl rand -hex 12)"
created=0
pg=(psql -X --no-password -v ON_ERROR_STOP=1)
cleanup() {
    local code=$?
    if [[ "$provider" == mysql ]] && ! stop_mysql_scratch "$scratch"; then
        printf 'MySQL cleanup did not complete. Preserving %s\n' "$scratch" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
        exit "$code"
    fi
    if [[ "$created" == 1 ]] && ! "${pg[@]}" -d postgres -c "DROP DATABASE \"$database\""; then
        printf 'Could not remove owned test database %s\n' "$database" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
    fi
    if ! rm -f -- "$scratch/source.sqlite" "$scratch/"{inventory,plan,repeat,corrupt,incomplete}.json ||
       ! rmdir -- "$scratch"; then
        printf 'Could not remove owned scratch directory %s\n' "$scratch" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
    fi
    if [[ "$provider" == mysql && "$code" == 0 ]]; then
        printf 'Removed the MySQL scratch server, socket and data directory.\n'
    fi
    exit "$code"
}
trap cleanup EXIT

if [[ "$provider" == postgres ]]; then
    "${pg[@]}" -d postgres -c "CREATE DATABASE \"$database\" TEMPLATE template0"
    created=1
    "${pg[@]}" -d "$database" -f "$fixture"
    export FSUSBLOG_V1_DB="${FSUSBLOG_TEST_DB%;};Database=$database;Options=-c default_transaction_read_only=on"
    export FSUSBLOG_V1_SCHEMA=public
    source_sql=("${pg[@]}" -d "$database" -c)
elif [[ "$provider" == mysql ]]; then
    start_mysql_scratch "$scratch"
    "${mysql_admin[@]}" -e "CREATE DATABASE $database CHARACTER SET utf8mb4;
        CREATE USER 'fsus_read'@'localhost';
        GRANT SELECT ON $database.* TO 'fsus_read'@'localhost'"
    "${mysql_admin[@]}" "$database" < "$fixture"
    export FSUSBLOG_V1_DB="Server=$scratch/mysql.sock;Protocol=Unix;User ID=fsus_read;Database=$database;SSL Mode=Disabled"
    source_sql=("${mysql_admin[@]}" "$database" -e)
else
    export FSUSBLOG_V1_SQLITE_PATH="$scratch/source.sqlite"
    sqlite3 "$FSUSBLOG_V1_SQLITE_PATH" < "$fixture"
    source_sql=(sqlite3 "$FSUSBLOG_V1_SQLITE_PATH")
fi

migrate_project=src/Migrate/FsusBlogV2.Migrate.csproj
"$dotnet_bin" restore "$migrate_project" --configfile NuGet.Config --locked-mode
"$dotnet_bin" build "$migrate_project" --no-restore
migrate=("$dotnet_bin" src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll)

expect_blocked() {
    local rc=0
    "${migrate[@]}" legacy plan "$provider" > "$1" || rc=$?
    [[ "$rc" == 2 ]]
}

"${migrate[@]}" legacy inventory "$provider" > "$scratch/inventory.json"
expect_blocked "$scratch/plan.json"
expect_blocked "$scratch/repeat.json"
cmp "$scratch/plan.json" "$scratch/repeat.json"
python3 - "$scratch/" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
inventory = json.loads((root / 'inventory.json').read_text())
plan_raw = (root / 'plan.json').read_text()
plan = json.loads(plan_raw)
assert inventory['audit']['issues'] == []
assert not plan['readyToApply'] and plan['blockers']
assert plan['audit']['issues'] == []
actual = {p['table']: p['rows'] for p in inventory['audit']['projections']}
assert actual == {
    'article': 1,
    'article_body': 1,
    'article_revision': 3,
    'article_revision_content_block': 3,
    'article_publication': 2,
}
assert all(len(p['sha256']) == 64 for p in plan['audit']['projections'])
assert 'Private edit' not in plan_raw and 'published ☃' not in plan_raw
PY

"${source_sql[@]}" "UPDATE article_revision_content_block SET markdown_content = 'wrong' WHERE id = 200"
"${source_sql[@]}" 'UPDATE article_publication SET revision_no = 3 WHERE id = 900000002'
expect_blocked "$scratch/corrupt.json"
rg -F '"kind": "immutable block byte count or SHA-256 mismatch"' "$scratch/corrupt.json"
rg -F '"kind": "publication missing parent article, matching revision or required coordinate"' "$scratch/corrupt.json"
"${source_sql[@]}" 'ALTER TABLE article RENAME COLUMN current_publication_id TO unknown'
expect_blocked "$scratch/incomplete.json"
rg -F 'article.current_publication_id: required v1 column missing or ambiguous' "$scratch/incomplete.json"
if [[ "$provider" == mysql ]]; then
    "${source_sql[@]}" 'ALTER TABLE article RENAME COLUMN unknown TO current_publication_id'
    "${source_sql[@]}" 'ALTER TABLE article_body ENGINE=MyISAM'
    expect_blocked "$scratch/incomplete.json"
    rg -F 'article_body: relation is not a supported transactional base table' "$scratch/incomplete.json"
fi
printf 'Legacy %s read-only inventory and blocker checks passed.\n' "$provider"
