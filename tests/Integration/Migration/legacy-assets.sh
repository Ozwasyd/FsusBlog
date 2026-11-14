#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
provider="${1:-sqlite}"
dotnet="${DOTNET_BIN:-dotnet}"
project=src/Migrate/FsusBlogV2.Migrate.csproj
dll=src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
umask 077
root="$(mktemp -d /tmp/fsusv2-legacy-assets.XXXXXXXX)"
root="$(cd "$root" && pwd -P)"
database=""
maintenance=(psql -X --no-password -v ON_ERROR_STOP=1 -d postgres)
cleanup() {
    local code=$?
    if [[ -n "$database" ]]; then
        "${maintenance[@]}" -c "DROP DATABASE \"$database\"" >/dev/null || code=1
    fi
    if [[ "$provider" == mysql ]] && ! stop_mysql_scratch "$root"; then
        printf 'Could not clean owned MySQL instance; preserving %s\n' "$root" >&2
        exit 1
    fi
    find "$root" -depth -delete || code=1
    exit "$code"
}
trap cleanup EXIT
fixture=(tests/Integration/Migration/legacy-source-fixture.sql tests/Integration/Migration/legacy-assets-fixture.sql)
case "$provider" in
    sqlite)
        export FSUSBLOG_V1_SQLITE_PATH="$root/source.sqlite"
        source_sql=(sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH")
        cat "${fixture[@]}" | "${source_sql[@]}"
        ;;
    postgres)
        : "${PGHOST:?Set the isolated PostgreSQL Unix socket}" "${PGUSER:?Set the isolated PostgreSQL user}"
        : "${FSUSBLOG_TEST_DB:?Set the matching isolated PostgreSQL DSN}"
        name="fsusv2_assets_$(openssl rand -hex 12)"
        "${maintenance[@]}" -c "CREATE DATABASE \"$name\" TEMPLATE template0" >/dev/null
        database="$name"
        export FSUSBLOG_V1_DB="${FSUSBLOG_TEST_DB%;};Database=$database;Options=-c default_transaction_read_only=on"
        export FSUSBLOG_V1_SCHEMA=public
        psql -X --no-password -v ON_ERROR_STOP=1 -d "$database" -f "${fixture[0]}" -f "${fixture[1]}" >/dev/null
        source_sql=(psql -X --no-password -v ON_ERROR_STOP=1 -d "$database" -c)
        ;;
    mysql)
        # shellcheck source=tests/Integration/Migration/mysql-scratch.sh
        source tests/Integration/Migration/mysql-scratch.sh
        check_mysql_tools
        start_mysql_scratch "$root"
        name="fsusv2_assets_$(openssl rand -hex 12)"
        "${mysql_admin[@]}" -e "CREATE DATABASE $name CHARACTER SET utf8mb4;
            CREATE USER 'fsus_read'@'localhost'; GRANT SELECT ON $name.* TO 'fsus_read'@'localhost'"
        sed 's/ uuid / char(36) /g' "${fixture[@]}" | "${mysql_admin[@]}" "$name"
        export FSUSBLOG_V1_DB="Server=$root/mysql.sock;Protocol=Unix;User ID=fsus_read;Database=$name;SSL Mode=Disabled"
        source_sql=("${mysql_admin[@]}" "$name" -e)
        ;;
    *) printf '%s\n' 'Use provider sqlite, postgres, or mysql.' >&2; exit 2 ;;
esac
"$dotnet" restore "$project" --configfile NuGet.Config --locked-mode
"$dotnet" build "$project" --no-restore

public="$root/public"
private="$root/private"
mkdir -p "$public/illustration" "$private/2b"
example="$public/illustration/ExactName.txt"
private_example="$private/2b/2b550000000040008000000000000002.txt"
printf 'abc' > "$example"
printf 'def' > "$private_example"
verify() { "$dotnet" "$dll" legacy assets "$provider" "$public" "$private"; }
expect_issues() {
    local code=0
    verify > "$root/refused.json" || code=$?
    [[ "$code" == 2 ]]
    python3 - "$root/refused.json" "$@" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    report = json.load(stream)
assert report['readyToApply'] is False
assert {row['kind']: row['count'] for row in report['issues']} == dict(
    (name, int(count)) for name, count in (item.split('=') for item in sys.argv[2:])
), report
PY
}
verify > "$root/verified.json"
verify > "$root/repeated.json"
cmp "$root/verified.json" "$root/repeated.json"
python3 - "$root/verified.json" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    raw = stream.read()
report = json.loads(raw)
assert report['readyToApply'] is False and report['issues'] == []
assert len(report['assetMetadataSha256']) == 64
assert report['references']['articles'] == report['references']['revisions'] == 1
assert report['references']['total'] == 2
assert {file['storageClass'] for file in report['custody']} == {'public', 'private'}
assert all(file['status'] == 'verified' and file['bytes'] == 3 and
           file['expectedSha256'] == file['observedSha256'] for file in report['custody'])
assert 'ExactName' not in raw and 'Fixture private alt text' not in raw
PY

printf 'xyz' > "$example"
expect_issues digest-mismatch=1
printf 'long' > "$example"
expect_issues file-length-mismatch=1
rm "$example"
expect_issues file-unavailable-or-linked=1
ln -s "$private_example" "$example"
expect_issues file-unavailable-or-linked=1
rm "$example"
printf 'abc' > "$public/illustration/exactname.txt"
expect_issues file-unavailable-or-linked=1
rm "$public/illustration/exactname.txt"
printf 'abc' > "$example"

"${source_sql[@]}" "UPDATE content_asset SET sha256=NULL WHERE storage_class='public'" >/dev/null
"${source_sql[@]}" "UPDATE content_asset SET owner_admin_principal_id=97 WHERE storage_class='private'" >/dev/null
"${source_sql[@]}" "UPDATE content_asset_reference SET source_key='2' WHERE source_kind='revision'" >/dev/null
"${source_sql[@]}" "INSERT INTO content_asset_reference VALUES ('1a550000-0000-4000-8000-000000000001', 'draft', '7:sample', NULL, 1, NULL, '2026-10-01 00:00:00')" >/dev/null
"${source_sql[@]}" "INSERT INTO content_asset_cleanup_queue VALUES ('1a550000-0000-4000-8000-000000000001', '2026-10-01 00:00:00', 0, NULL, '2026-10-01 00:00:00')" >/dev/null
expect_issues legacy-digest-unavailable=1 asset-owner-unresolved=1 revision-reference-unresolved=1 draft-reference-unsupported=1 cleanup-pending=1
"${source_sql[@]}" "ALTER TABLE content_asset RENAME TO old_content_asset" >/dev/null
code=0
verify > "$root/unregistered.json" 2> "$root/error" || code=$?
[[ "$code" == 1 && ! -s "$root/unregistered.json" ]]
rg -q '^Required v1 asset authority differs: content_asset\.$' "$root/error"
printf 'Legacy asset custody on %s passed, including byte, reference, owner, and unsupported schema cases.\n' "$provider"
