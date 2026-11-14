#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" ]]; then
    printf '%s\n' 'Set FSUSBLOG_TEST_DB and matching libpq variables for the isolated cluster.' >&2
    exit 2
fi
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
dotnet="${DOTNET_BIN:-dotnet}"
export DOTNET_BIN="$dotnet"
export FSUSBLOG_MIGRATE_DLL="src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll"
umask 077
root="$(mktemp -d /tmp/fsusv2-legacy-import.XXXXXXXX)"
root="$(cd "$root" && pwd -P)"
database="fsusv2_import_$(openssl rand -hex 12)"
restore="${database}_restore"
maintenance=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d postgres)
created=()
cleanup() {
    local code=$? db
    for db in "${created[@]}"; do
        if ! "${maintenance[@]}" -c "DROP DATABASE \"$db\""; then
            printf 'Could not drop owned test database %s\n' "$db" >&2
            if [[ "$code" == 0 ]]; then code=1; fi
        fi
    done
    if ! find "$root" -depth -delete; then
        printf 'Could not remove owned scratch directory %s\n' "$root" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
    fi
    if [[ "$code" == 0 ]]; then printf '%s\n' 'Owned import and restore databases and private scratch removed.'; fi
    exit "$code"
}
trap cleanup EXIT

for db in "$database" "$restore"; do
    "${maintenance[@]}" -c "CREATE DATABASE \"$db\" TEMPLATE template0"
    created+=("$db")
done
target_sql=(psql -X --no-password -v ON_ERROR_STOP=1 -d "$database")
restore_sql=(psql -X --no-password -v ON_ERROR_STOP=1 -d "$restore")
export FSUSBLOG_IMPORT_DB="${FSUSBLOG_TEST_DB%;};Database=$database"
export FSUSBLOG_DB="$FSUSBLOG_IMPORT_DB" PGDATABASE="$database"
export FSUSBLOG_V1_SQLITE_PATH="$root/source.sqlite"

project=src/Migrate/FsusBlogV2.Migrate.csproj
"$dotnet" restore "$project" --configfile NuGet.Config --locked-mode
"$dotnet" build "$project" --no-restore
migrate=("$dotnet" "$FSUSBLOG_MIGRATE_DLL")

cat tests/Integration/Migration/legacy-source-fixture.sql \
    tests/Integration/Migration/legacy-shared-rights-fixture.sql | sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH"
"${migrate[@]}" plan > "$root/bootstrap.json"
"${migrate[@]}" apply "$root/bootstrap.json"
"${target_sql[@]}" -c "INSERT INTO public.blog_user VALUES ('968ffb2b-77ef-4868-89ec-6a0a19b28b95','Import owner',true,true,1)"

mkdir -m 700 "$root/backup" "$root/media"
result="$(python3 tools/site-backup.py capture "$root/backup" seed "$root/media")"
manifest="${result##* }"
[[ "$manifest" =~ ^[0-9a-f]{64}$ ]]
backup="$root/backup/seed"
python3 tools/site-backup.py verify "$backup" "$manifest"

rc=0
"${migrate[@]}" legacy plan sqlite > "$root/intake.json" || rc=$?
[[ "$rc" == 2 ]]
python3 - "$root/intake.json" "$root/owner.json" <<'PY'
import json, pathlib, sys
report=json.loads(pathlib.Path(sys.argv[1]).read_text())
article=next(row for row in report["audit"]["projections"] if row["table"] == "article")
owner={"sourceArticleSha256":article["sha256"],"sourceAdminIdentitySha256":report["sourceAdminIdentitySha256"],
       "owners":[{"articleId":42,"legacyAdminId":7,"v2UserId":"968ffb2b-77ef-4868-89ec-6a0a19b28b95"}]}
pathlib.Path(sys.argv[2]).write_text(json.dumps(owner))
PY

plan=("${migrate[@]}" legacy import plan sqlite "$root/owner.json" "$backup" "$manifest")
apply=("${migrate[@]}" legacy import apply sqlite "$root/owner.json" "$backup" "$manifest" "$root/import.json")
"${plan[@]}" > "$root/import.json"
python3 - "$root/import.json" <<'PY'
import json, pathlib, sys
plan=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert plan["readyToStage"] is True and plan["readyToApply"] is False
assert not plan["findings"] and len(plan["sourceProjections"]) == 12
PY
mv "$backup/database.dump" "$root/seed.dump"
ln -s "$root/seed.dump" "$backup/database.dump"
if "${apply[@]}" > "$root/error.log" 2>&1; then exit 1; fi
rg -F 'backup contains an unavailable or linked file' "$root/error.log"
unlink "$backup/database.dump"
mv "$root/seed.dump" "$backup/database.dump"

sqlite3 "$FSUSBLOG_V1_SQLITE_PATH" "UPDATE article_rights_snapshot SET copyright_holder='Changed' WHERE id=701"
if "${apply[@]}" > "$root/error.log" 2>&1; then exit 1; fi
rg -F 'The import plan no longer matches' "$root/error.log"
sqlite3 "$FSUSBLOG_V1_SQLITE_PATH" "UPDATE article_rights_snapshot SET copyright_holder='Fixture Author' WHERE id=701"

sqlite3 "$FSUSBLOG_V1_SQLITE_PATH" 'CREATE TABLE content_asset (id integer); INSERT INTO content_asset VALUES (1),(2)'
rc=0
"${plan[@]}" > "$root/blocked.json" || rc=$?
[[ "$rc" == 2 ]]
python3 - "$root/blocked.json" <<'PY'
import json, pathlib, sys
plan=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert not plan["readyToApply"] and not plan["readyToStage"]
assert plan["findings"] == [{"category":"attachments","source":"content_asset","rows":2}]
PY
if "${apply[@]}" > "$root/error.log" 2>&1; then exit 1; fi
rg -F 'contains unsupported rows' "$root/error.log"
sqlite3 "$FSUSBLOG_V1_SQLITE_PATH" 'DROP TABLE content_asset'
sqlite3 "$FSUSBLOG_V1_SQLITE_PATH" <<'SQL'
UPDATE admin_principal SET permissions='["article.publish"]', isroot=true;
SQL
rc=0
"${plan[@]}" > "$root/blocked.json" || rc=$?
[[ "$rc" == 2 ]]
python3 - "$root/blocked.json" <<'PY'
import json, pathlib, sys
plan=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert not plan["readyToStage"]
assert plan["findings"] == [
    {"category":"legacy-privilege","source":"admin_principal.isroot","rows":1},
    {"category":"legacy-privilege","source":"admin_principal.permissions","rows":1}
]
PY
sqlite3 "$FSUSBLOG_V1_SQLITE_PATH" "UPDATE admin_principal SET permissions='[]', isroot=false"
[[ "$("${target_sql[@]}" -qAtc 'SELECT version FROM public.v2_schema')" == 1 ]]

"${apply[@]}" > "$root/applied.json"
[[ "$("${target_sql[@]}" -qAtc 'SELECT version FROM public.v2_schema')" == -1 ]]
[[ "$("${target_sql[@]}" -qAtc 'SELECT count(*) FROM public.article')" == 0 ]]
[[ "$("${target_sql[@]}" -qAtc "SELECT count(*) FROM fsus_legacy_candidate.shadow_publication")" == 2 ]]
[[ "$("${target_sql[@]}" -qAtc "SELECT source_revision_id,publication_number,source_rights_snapshot_id FROM fsus_legacy_candidate.shadow_publication ORDER BY publication_number")" == $'5000000001|1|700\n5000000002|2|701' ]]
if "${migrate[@]}" verify > "$root/error.log" 2>&1; then exit 1; fi
rg -F 'isolated legacy import candidate and cannot serve' "$root/error.log"

# Model an interruption after phase 2 in the disposable database.
"${target_sql[@]}" -c 'BEGIN; DROP TABLE fsus_legacy_candidate.shadow_article_rights_policy,
    fsus_legacy_candidate.shadow_article_rights_snapshot, fsus_legacy_candidate.shadow_article_responsibility_snapshot;
    DELETE FROM fsus_legacy_candidate.checkpoint WHERE phase=3; COMMIT'
"${apply[@]}" > "$root/resumed.json"
python3 - "$root/resumed.json" <<'PY'
import json, pathlib, sys
result=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert not result["readyToApply"]
assert [(entry["phase"],entry["result"]) for entry in result["phases"]] == [(1,"revalidated"),(2,"revalidated"),(3,"staged")]
PY
"${target_sql[@]}" -c "UPDATE fsus_legacy_candidate.shadow_revision SET body='unexpected drift' WHERE revision=2"
if "${apply[@]}" > "$root/error.log" 2>&1; then exit 1; fi
rg -F 'does not match its independently read source projection' "$root/error.log"

pg_restore --no-password --single-transaction --exit-on-error --no-owner --no-privileges \
    --dbname "$restore" "$backup/database.dump"
FSUSBLOG_DB="${FSUSBLOG_TEST_DB%;};Database=$restore" python3 tools/site-backup.py verify-restored "$backup" "$manifest" "$root/media"
[[ "$("${restore_sql[@]}" -qAtc 'SELECT version FROM public.v2_schema')" == 1 ]]
[[ "$("${restore_sql[@]}" -qAtc 'SELECT count(*) FROM public.article')" == 0 ]]
printf '%s\n' 'Legacy PostgreSQL candidate import, resume, refusal and independent recovery passed.'
