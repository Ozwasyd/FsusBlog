#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [[ "${PGHOST:-}" != /* || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_DB:-}" ]]; then
    printf '%s\n' 'Set PGHOST and PGUSER for the isolated PostgreSQL Unix socket, with matching FSUSBLOG_TEST_DB.' >&2
    exit 2
fi
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
dotnet="${DOTNET_BIN:-dotnet}"
project=src/Migrate/FsusBlogV2.Migrate.csproj
migrate=("$dotnet" src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll)
umask 077
scratch="$(mktemp -d /tmp/fsusv2-asset-rehearsal.XXXXXXXX)"
scratch="$(cd "$scratch" && pwd -P)"
candidate="fsusv2_import_assets_$(openssl rand -hex 12)"
same_instance="${candidate}_source"
maintenance=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d postgres)
created=()
second_started=0
cleanup() {
    local code=$? database
    if [[ "$second_started" == 1 && -f "$scratch/second-data/postmaster.pid" ]] &&
       ! pg_ctl -D "$scratch/second-data" -w -t 12 stop -m fast >/dev/null; then
        printf 'Could not stop owned PostgreSQL instance. Preserving %s\n' "$scratch" >&2
        exit 1
    fi
    # The rehearse command may seal its files and directory, so restore permissions only on the test tree.
    find "$scratch" -type d -exec chmod u+rwx {} + || code=1
    for database in "${created[@]}"; do
        if ! "${maintenance[@]}" -c "DROP DATABASE \"$database\""; then
            printf 'Could not remove owned test database %s\n' "$database" >&2
            code=1
        fi
    done
    find "$scratch" -depth -delete || code=1
    exit "$code"
}
trap cleanup EXIT

for database in "$candidate" "$same_instance"; do
    "${maintenance[@]}" -c "CREATE DATABASE \"$database\" TEMPLATE template0"
    created+=("$database")
done
target_sql=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d "$candidate")
export FSUSBLOG_DB="${FSUSBLOG_TEST_DB%;};Database=$candidate"
export FSUSBLOG_IMPORT_DB="$FSUSBLOG_DB;Options=-c default_transaction_read_only=on"
export FSUSBLOG_V1_DB="${FSUSBLOG_TEST_DB%;};Database=$same_instance;Options=-c default_transaction_read_only=on"
export FSUSBLOG_V1_SCHEMA=public
export FSUSBLOG_V1_SQLITE_PATH="$scratch/source.sqlite"

fixtures=(tests/Integration/Migration/legacy-source-fixture.sql tests/Integration/Migration/legacy-assets-fixture.sql)
cat "${fixtures[@]}" | sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH"
psql -X -q --no-password -v ON_ERROR_STOP=1 -d "$same_instance" -f "${fixtures[0]}" -f "${fixtures[1]}"

"$dotnet" restore "$project" --configfile NuGet.Config --locked-mode
"$dotnet" build "$project" --no-restore
"${migrate[@]}" plan > "$scratch/bootstrap.json"
"${migrate[@]}" apply "$scratch/bootstrap.json"

target_owner=968ffb2b-77ef-4868-89ec-6a0a19b28b95
"${target_sql[@]}" -c "INSERT INTO public.blog_user VALUES ('$target_owner','Media fixture owner',true,true,1)"
target_site="$("${target_sql[@]}" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')"
candidate_state() {
    "${target_sql[@]}" -Atc "SELECT version, (SELECT count(*) FROM public.article),
        (SELECT count(*) FROM public.private_media), (SELECT count(*) FROM public.blog_user),
        to_regnamespace('fsus_legacy_candidate') IS NULL FROM public.v2_schema"
}
candidate_before="$(candidate_state)"

public="$scratch/public"
private="$scratch/private"
public_file="$public/illustration/ExactName.txt"
private_file="$private/2b/2b550000000040008000000000000002.txt"
mkdir -p "$public/illustration" "$private/2b" "$scratch/packages"
printf 'abc' > "$public_file"
printf 'def' > "$private_file"

"${migrate[@]}" legacy assets sqlite "$public" "$private" > "$scratch/custody.json"

rehearsal=("${migrate[@]}" legacy assets rehearsal)
source_site=87bcdd48-255d-49dd-a984-dd4c4ee6f9d4
other_site=6af52915-6d9a-47e7-87c5-51804c21b89d
sqlite_before="$(shasum -a 256 "$FSUSBLOG_V1_SQLITE_PATH")"
cp "$FSUSBLOG_V1_SQLITE_PATH" "$scratch/frozen-before.sqlite"
digest() {
    shasum -a 256 "$1" | cut -d ' ' -f 1
}
expect_refused() {
    if "$@" > "$scratch/refusal.json" 2> "$scratch/error.log"; then
        printf 'The legacy asset rehearsal unexpectedly succeeded.\n' >&2
        exit 1
    fi
    [[ -s "$scratch/error.log" ]]
}

# The source is a different database in the same PostgreSQL instance as target.
expect_refused "${rehearsal[@]}" plan postgres "$public" "$private" "$source_site" "$target_site"
rg -iq 'same.*(instance|cluster)|separate clusters' "$scratch/error.log"
expect_refused "${rehearsal[@]}" plan sqlite "$public" "$private" "$source_site" "$other_site"
rg -iq 'site' "$scratch/error.log"
[[ -z "$(find "$scratch/packages" -mindepth 1 -print)" ]]

"${rehearsal[@]}" plan sqlite "$public" "$private" "$source_site" "$target_site" > "$scratch/sqlite-plan.json"
python3 - "$scratch/sqlite-plan.json" "$scratch/custody.json" "$source_site" "$target_site" <<'PY'
import json
import re
import sys
from pathlib import Path

plan, custody = [json.loads(Path(path).read_text()) for path in sys.argv[1:3]]
assert plan["sourceReference"] == custody["sourceReference"]
assert plan["provider"] == "sqlite" and plan["sourceSiteId"] == sys.argv[3] and plan["targetSiteId"] == sys.argv[4]
assert plan["assetMetadataSha256"] == custody["assetMetadataSha256"]
assert plan["referenceSha256"] == custody["references"]["sha256"]
assert re.fullmatch("[0-9a-f]{64}", plan["sourceAdminIdentitySha256"])
assert plan["readyToApply"] is False
assert plan["owners"] == [{"sourceAdminPrincipalId": 7, "targetUserId": None}]
PY

write_review() {
    python3 - "$1" "$2" "$3" <<'PY'
import json, sys
from pathlib import Path
review = json.loads(Path(sys.argv[1]).read_text())
review["owners"][0]["targetUserId"] = sys.argv[3]
Path(sys.argv[2]).write_text(json.dumps(review))
PY
}
write_review "$scratch/sqlite-plan.json" "$scratch/sqlite-review.json" "$target_owner"
write_review "$scratch/sqlite-plan.json" "$scratch/unknown-owner.json" "$other_site"
review_digest="$(digest "$scratch/sqlite-review.json")"
copy=("${rehearsal[@]}" copy sqlite "$public" "$private")
expect_refused "${copy[@]}" "$scratch/sqlite-plan.json" "$(digest "$scratch/sqlite-plan.json")" "$scratch/packages" not-reviewed
expect_refused "${copy[@]}" "$scratch/unknown-owner.json" "$(digest "$scratch/unknown-owner.json")" "$scratch/packages" wrong-owner
expect_refused "${copy[@]}" "$scratch/sqlite-review.json" "$(digest "$scratch/sqlite-plan.json")" "$scratch/packages" review-drift
expect_refused "${copy[@]}" "$scratch/sqlite-review.json" "$review_digest" "$private" overlapping-output
[[ ! -e "$private/overlapping-output" ]]
ln -s "$scratch/packages" "$scratch/linked-output"
expect_refused "${copy[@]}" "$scratch/sqlite-review.json" "$review_digest" "$scratch/linked-output" linked-output
expect_refused env FSUSBLOG_PRIVATE_MEDIA_ROOT="$scratch/packages" "${copy[@]}" \
    "$scratch/sqlite-review.json" "$review_digest" "$scratch/packages" runtime-media-overlap
"${target_sql[@]}" -c "UPDATE public.blog_user SET enabled=false WHERE id='$target_owner'"
expect_refused "${copy[@]}" "$scratch/sqlite-review.json" "$review_digest" "$scratch/packages" ineligible-owner
"${target_sql[@]}" -c "UPDATE public.blog_user SET enabled=true WHERE id='$target_owner'"
"${target_sql[@]}" -c 'CREATE SCHEMA fsus_legacy_candidate'
expect_refused "${copy[@]}" "$scratch/sqlite-review.json" "$review_digest" "$scratch/packages" staged-candidate
"${target_sql[@]}" -c 'DROP SCHEMA fsus_legacy_candidate'
"${target_sql[@]}" -c 'CREATE SCHEMA unrelated; CREATE TABLE unrelated.unreviewed (id integer)'
expect_refused "${copy[@]}" "$scratch/sqlite-review.json" "$review_digest" "$scratch/packages" unreviewed-relation
"${target_sql[@]}" -c 'DROP TABLE unrelated.unreviewed; DROP SCHEMA unrelated'
[[ "$(shasum -a 256 "$FSUSBLOG_V1_SQLITE_PATH")" == "$sqlite_before" ]]
[[ -z "$(find "$scratch/packages" -mindepth 1 -print)" ]]

printf 'xyz' > "$public_file"
expect_refused "${copy[@]}" "$scratch/sqlite-review.json" "$review_digest" "$scratch/packages" changed-bytes
printf 'abc' > "$public_file"
sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH" "UPDATE content_asset_reference SET reference_count=2 WHERE source_kind='article'"
expect_refused "${copy[@]}" "$scratch/sqlite-review.json" "$review_digest" "$scratch/packages" changed-reference
cp "$scratch/frozen-before.sqlite" "$FSUSBLOG_V1_SQLITE_PATH"
[[ -z "$(find "$scratch/packages" -mindepth 1 -print)" ]]

assert_package() {
    local package="$1" receipt="$2" review="$3" manifest
    manifest="$(python3 - "$receipt" "$package" "$review" <<'PY'
import hashlib, json, stat, sys
from pathlib import Path

receipt = json.loads(Path(sys.argv[1]).read_text())
package = Path(sys.argv[2])
manifest = package / "manifest.json"
review = Path(sys.argv[3]).read_bytes()
assert receipt["readyToApply"] is False
assert receipt["manifestSha256"] == hashlib.sha256(manifest.read_bytes()).hexdigest()
data = json.loads(manifest.read_bytes())
assert data["format"] == "fsusblog-legacy-media-quarantine-v1" and data["readyToApply"] is False
assert data["review"] == json.loads(review)
assert data["reviewSha256"] == hashlib.sha256(review).hexdigest()
owner = data["review"]["owners"][0]["targetUserId"]
assert stat.S_IMODE(package.lstat().st_mode) == 0o500
expected = {
    "1a550000000040008000000000000001.blob": b"abc",
    "2b550000000040008000000000000002.blob": b"def",
}
assert {entry.name for entry in package.iterdir()} == set(expected) | {"manifest.json"}
for entry in package.iterdir():
    info = entry.lstat()
    assert stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o400 and info.st_nlink == 1
    if entry.name in expected:
        assert entry.read_bytes() == expected[entry.name]
records = {item["storageClass"]: item for item in data["files"]}
assert set(records) == {"public", "private"} and len(data["files"]) == 2
assert records["public"]["storageKey"] == "illustration/ExactName.txt"
assert records["public"]["sourceOwnerId"] is None and records["public"]["targetOwnerId"] is None
assert records["private"]["storageKey"] == "2b/2b550000000040008000000000000002.txt"
assert records["private"]["sourceOwnerId"] == 7 and records["private"]["targetOwnerId"] == owner
for record in records.values():
    blob = expected[record["assetId"].replace("-", "") + ".blob"]
    assert record["bytes"] == len(blob) and record["sha256"] == hashlib.sha256(blob).hexdigest()
references = {item["sourceKind"]: item for item in data["references"]}
assert len(data["references"]) == 2 and set(references) == {"article", "revision"}
assert (references["article"]["articleId"], references["article"]["sourceId"]) == (42, 42)
assert (references["revision"]["articleId"], references["revision"]["sourceId"]) == (42, 5000000002)
assert references["article"]["altText"] == "Fixture private alt text"
assert "ExactName.txt" not in Path(sys.argv[1]).read_text() and "Fixture private alt text" not in Path(sys.argv[1]).read_text()
print(receipt["manifestSha256"])
PY
)"
    (
        unset FSUSBLOG_DB FSUSBLOG_IMPORT_DB FSUSBLOG_V1_DB FSUSBLOG_V1_SQLITE_PATH
        "${rehearsal[@]}" verify "$package" "$manifest"
    ) > "$scratch/verified.json"
    python3 - "$scratch/verified.json" "$manifest" <<'PY'
import json, sys
from pathlib import Path
receipt = json.loads(Path(sys.argv[1]).read_text())
assert receipt["readyToApply"] is False and receipt["manifestSha256"] == sys.argv[2]
PY
    printf '%s\n' "$manifest"
}

"${copy[@]}" "$scratch/sqlite-review.json" "$review_digest" "$scratch/packages" sealed-sqlite > "$scratch/sqlite-result.json"
package="$scratch/packages/sealed-sqlite"
manifest="$(assert_package "$package" "$scratch/sqlite-result.json" "$scratch/sqlite-review.json")"
expect_refused "${copy[@]}" "$scratch/sqlite-review.json" "$review_digest" "$scratch/packages" sealed-sqlite
"${rehearsal[@]}" verify "$package" "$manifest" > /dev/null
expect_refused "${rehearsal[@]}" verify "$package" "$review_digest"
chmod 700 "$package"
expect_refused "${rehearsal[@]}" verify "$package" "$manifest"
chmod 500 "$package"

blob="$package/1a550000000040008000000000000001.blob"
chmod 600 "$blob"
printf 'xyz' > "$blob"
chmod 400 "$blob"
expect_refused "${rehearsal[@]}" verify "$package" "$manifest"
chmod 700 "$package"
mv "$blob" "$scratch/replaced.blob"
ln -s "$public_file" "$blob"
chmod 500 "$package"
expect_refused "${rehearsal[@]}" verify "$package" "$manifest"
chmod 700 "$package"
unlink "$blob"
mv "$scratch/replaced.blob" "$blob"
chmod 600 "$blob"
printf 'abc' > "$blob"
chmod 400 "$blob"
ln "$blob" "$scratch/hard-link.blob"
chmod 500 "$package"
expect_refused "${rehearsal[@]}" verify "$package" "$manifest"
unlink "$scratch/hard-link.blob"
if [[ "$(uname -s)" == Darwin ]]; then
    chmod +a 'everyone allow read' "$blob"
    expect_refused "${rehearsal[@]}" verify "$package" "$manifest"
    chmod -N "$blob"
fi
chmod 700 "$package"
printf '' > "$package/unexpected"
chmod 500 "$package"
expect_refused "${rehearsal[@]}" verify "$package" "$manifest"
chmod 700 "$package"
unlink "$package/unexpected"
chmod 500 "$package"
"${rehearsal[@]}" verify "$package" "$manifest" > /dev/null
[[ "$(shasum -a 256 "$FSUSBLOG_V1_SQLITE_PATH")" == "$sqlite_before" ]]

# Use an independently initialized PostgreSQL cluster for a positive v1 provider run.
mkdir "$scratch/second-socket"
initdb -D "$scratch/second-data" -U asset_source_admin --auth=trust --no-locale -E UTF8 > "$scratch/init.log"
second_port=54932
second_started=1
pg_ctl -D "$scratch/second-data" -l "$scratch/second.log" -w -t 15 \
    -o "-c listen_addresses='' -c unix_socket_directories='$scratch/second-socket' -p $second_port" start >/dev/null
second_sql=(psql -X -q --no-password -v ON_ERROR_STOP=1 -h "$scratch/second-socket" -p "$second_port" -U asset_source_admin -d postgres)
"${second_sql[@]}" -f "${fixtures[0]}" -f "${fixtures[1]}"
"${second_sql[@]}" -c 'CREATE ROLE asset_source_read LOGIN;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO asset_source_read;
    GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO asset_source_read'
export FSUSBLOG_V1_DB="Host=$scratch/second-socket;Port=$second_port;Database=postgres;Username=asset_source_read;SSL Mode=Disable;Options=-c default_transaction_read_only=on"
pg_source_before="$("${second_sql[@]}" -Atc 'SELECT row_to_json(asset)::text FROM public.content_asset AS asset ORDER BY id')"
"${rehearsal[@]}" plan postgres "$public" "$private" "$source_site" "$target_site" > "$scratch/postgres-plan.json"
write_review "$scratch/postgres-plan.json" "$scratch/postgres-review.json" "$target_owner"
"${rehearsal[@]}" copy postgres "$public" "$private" "$scratch/postgres-review.json" "$(digest "$scratch/postgres-review.json")" \
    "$scratch/packages" sealed-postgres > "$scratch/postgres-result.json"
assert_package "$scratch/packages/sealed-postgres" "$scratch/postgres-result.json" "$scratch/postgres-review.json" > /dev/null
[[ "$("${second_sql[@]}" -Atc 'SELECT row_to_json(asset)::text FROM public.content_asset AS asset ORDER BY id')" == "$pg_source_before" ]]

[[ "$(candidate_state)" == "$candidate_before" ]]
printf '%s\n' 'Legacy asset copy rehearsal passed with SQLite and separate PostgreSQL sources, same-instance refusal, sealed-byte verification, and no candidate data changes.'
