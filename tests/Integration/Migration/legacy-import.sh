#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
provider="${1:-sqlite}"
case "$provider" in
    sqlite|postgres|mysql) ;;
    *) printf 'Usage: %s [sqlite|postgres|mysql]\n' "$0" >&2; exit 2 ;;
esac
if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" ]]; then
    printf '%s\n' 'Set FSUSBLOG_TEST_DB and matching libpq variables for the isolated cluster.' >&2
    exit 2
fi
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
if [[ "$provider" == mysql ]]; then
    # shellcheck source=tests/Integration/Migration/mysql-scratch.sh
    source tests/Integration/Migration/mysql-scratch.sh
    check_mysql_tools
fi
dotnet="${DOTNET_BIN:-dotnet}"
export DOTNET_BIN="$dotnet"
export FSUSBLOG_MIGRATE_DLL="src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll"
umask 077
root="$(mktemp -d /tmp/fsusv2-legacy-import.XXXXXXXX)"
root="$(cd "$root" && pwd -P)"
database="fsusv2_import_$(openssl rand -hex 12)"
restore="${database}_restore"
source_db="${database}_source"
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
    if [[ "$provider" == mysql ]] && ! stop_mysql_scratch "$root"; then
        printf 'Could not stop and clean owned MySQL instance. Preserving %s\n' "$root" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
        exit "$code"
    fi
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

fixture=(
    tests/Integration/Migration/legacy-source-fixture.sql
    tests/Integration/Migration/legacy-shared-rights-fixture.sql
)
case "$provider" in
    postgres)
        "${maintenance[@]}" -c "CREATE DATABASE \"$source_db\" TEMPLATE template0"
        created+=("$source_db")
        psql -X --no-password -v ON_ERROR_STOP=1 -d "$source_db" -f "${fixture[0]}" -f "${fixture[1]}"
        export FSUSBLOG_V1_DB="${FSUSBLOG_TEST_DB%;};Database=$source_db;Options=-c default_transaction_read_only=on"
        export FSUSBLOG_V1_SCHEMA=public
        source_sql=(psql -X --no-password -v ON_ERROR_STOP=1 -d "$source_db" -c)
        ;;
    mysql)
        start_mysql_scratch "$root"
        "${mysql_admin[@]}" -e "CREATE DATABASE $source_db CHARACTER SET utf8mb4;
            CREATE USER 'fsus_read'@'localhost';
            GRANT SELECT ON $source_db.* TO 'fsus_read'@'localhost'"
        cat "${fixture[@]}" | "${mysql_admin[@]}" "$source_db"
        export FSUSBLOG_V1_DB="Server=$root/mysql.sock;Protocol=Unix;User ID=fsus_read;Database=$source_db;SSL Mode=Disabled"
        source_sql=("${mysql_admin[@]}" "$source_db" -e)
        ;;
    sqlite)
        export FSUSBLOG_V1_SQLITE_PATH="$root/source.sqlite"
        cat "${fixture[@]}" | sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH"
        source_sql=(sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH")
        ;;
esac

project=src/Migrate/FsusBlogV2.Migrate.csproj
"$dotnet" restore "$project" --configfile NuGet.Config --locked-mode
"$dotnet" build "$project" --no-restore
migrate=("$dotnet" "$FSUSBLOG_MIGRATE_DLL")

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
"${migrate[@]}" legacy plan "$provider" > "$root/intake.json" || rc=$?
[[ "$rc" == 2 ]]
python3 - "$root/intake.json" "$root/owner.json" <<'PY'
import json, pathlib, sys
report=json.loads(pathlib.Path(sys.argv[1]).read_text())
article=next(row for row in report["audit"]["projections"] if row["table"] == "article")
owner={"sourceArticleSha256":article["sha256"],"sourceAdminIdentitySha256":report["sourceAdminIdentitySha256"],
       "owners":[{"articleId":42,"legacyAdminId":7,"v2UserId":"968ffb2b-77ef-4868-89ec-6a0a19b28b95"}]}
pathlib.Path(sys.argv[2]).write_text(json.dumps(owner))
PY

plan=("${migrate[@]}" legacy import plan "$provider" "$root/owner.json" "$backup" "$manifest")
apply=("${migrate[@]}" legacy import apply "$provider" "$root/owner.json" "$backup" "$manifest" "$root/import.json")
"${target_sql[@]}" -c "INSERT INTO public.admin_principal (id,handle,user_handle,enabled,generation)
    VALUES ('4ebd2ccb-f588-492c-94cb-f14d0ac890e5','fixture-page-editor',decode(repeat('b4',32),'hex'),false,1);
    UPDATE public.site_page_content SET revision=1,markdown='Unreviewed page' WHERE slug='about';
    INSERT INTO public.site_page_publish_audit VALUES ('about',1,'4ebd2ccb-f588-492c-94cb-f14d0ac890e5',
        sha256(convert_to('','UTF8')),sha256(convert_to('Unreviewed page','UTF8')),now())"
if "${plan[@]}" > "$root/rejected.json" 2> "$root/error.log"; then exit 1; fi
rg -Fx 'The independent target business and sequence digests differ from the backup.' "$root/error.log"
"${target_sql[@]}" -c "DELETE FROM public.site_page_publish_audit WHERE slug='about';
    UPDATE public.site_page_content SET revision=0,markdown=NULL WHERE slug='about';
    DELETE FROM public.admin_principal WHERE id='4ebd2ccb-f588-492c-94cb-f14d0ac890e5'"
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

"${source_sql[@]}" "UPDATE article_rights_snapshot SET copyright_holder='Changed' WHERE id=701"
if "${apply[@]}" > "$root/error.log" 2>&1; then exit 1; fi
rg -F 'The import plan no longer matches' "$root/error.log"
"${source_sql[@]}" "UPDATE article_rights_snapshot SET copyright_holder='Fixture Author' WHERE id=701"

"${source_sql[@]}" 'CREATE TABLE content_asset (id integer); INSERT INTO content_asset VALUES (1),(2)'
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
"${source_sql[@]}" 'DROP TABLE content_asset'
"${source_sql[@]}" "UPDATE admin_principal SET permissions='[\"article.publish\"]', isroot=true"
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
"${source_sql[@]}" "UPDATE admin_principal SET permissions='[]', isroot=false"
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
printf 'Legacy %s source to PostgreSQL candidate import, resume, refusal and independent recovery passed.\n' "$provider"
