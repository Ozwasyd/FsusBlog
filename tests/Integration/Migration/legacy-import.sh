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
source_command_id=4f0cd9d1-dfaa-4461-9730-20904c0bdd99
source_command_hash=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF
case "$provider" in
    postgres)
        "${maintenance[@]}" -c "CREATE DATABASE \"$source_db\" TEMPLATE template0"
        created+=("$source_db")
        psql -X --no-password -v ON_ERROR_STOP=1 -d "$source_db" -f "${fixture[0]}" -f "${fixture[1]}" \
            -f tests/Integration/Migration/legacy-article-command-fixture.sql
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
[[ "$("${target_sql[@]}" -Atc "SELECT singleton,revision,
    (SELECT count(*) FROM public.admin_tag_metadata_command) FROM public.taxonomy_epoch")" == 't|0|0' ]]
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
"${target_sql[@]}" -c 'UPDATE public.taxonomy_epoch SET revision=1 WHERE singleton'
if "${plan[@]}" > "$root/rejected.json" 2> "$root/error.log"; then exit 1; fi
rg -Fx 'The taxonomy epoch and durable command history do not agree.' "$root/error.log"
"${target_sql[@]}" -c 'UPDATE public.taxonomy_epoch SET revision=0 WHERE singleton'
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
python3 - "$root/import.json" "$provider" <<'PY'
import json, pathlib, re, sys
plan=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert plan["readyToStage"] is True and plan["readyToApply"] is False
assert not plan["findings"]
if sys.argv[2] == "postgres":
    assert plan["version"] == 2 and len(plan["sourceProjections"]) == len(plan["expectedTables"]) == 13
    for rows, table in ((plan["sourceProjections"], "article_mutation_command"),
                        (plan["expectedTables"], "shadow_article_mutation_command")):
        receipt = next(item for item in rows if item["table"] == table)
        assert receipt["rows"] == 1 and re.fullmatch(r"[0-9a-f]{64}", receipt["sha256"]), receipt
else:
    assert plan["version"] == 1 and len(plan["sourceProjections"]) == len(plan["expectedTables"]) == 12
PY
if [[ "$provider" == postgres ]]; then
    expect_command_refused() {
        local exit_code=0
        "${plan[@]}" > "$root/rejected.json" || exit_code=$?
        [[ "$exit_code" == 2 ]]
        python3 - "$root/rejected.json" <<'PY'
import json, pathlib, sys
report = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert not report["readyToStage"] and not report["readyToApply"]
assert report["findings"] == [{"category":"legacy-create-command","source":"article_mutation_command","rows":1}], report
PY
        if "${apply[@]}" > "$root/error.log" 2>&1; then exit 1; fi
        rg -F 'contains unsupported rows' "$root/error.log"
    }

    "${source_sql[@]}" "UPDATE article_mutation_command SET client_mutation_id=upper(client_mutation_id)"
    expect_command_refused
    "${source_sql[@]}" "UPDATE article_mutation_command SET client_mutation_id='$source_command_id',request_hash=repeat('Z',64)"
    expect_command_refused
    "${source_sql[@]}" "UPDATE article_mutation_command SET request_hash='$source_command_hash',revision_id=9999999999"
    expect_command_refused
    "${source_sql[@]}" "UPDATE article_mutation_command SET revision_id=5000000001,request_hash=repeat('A',64)"
    "${plan[@]}" > "$root/command-drift.json"
    python3 - "$root/import.json" "$root/command-drift.json" <<'PY'
import json, pathlib, sys
before, after = [json.loads(pathlib.Path(path).read_text()) for path in sys.argv[1:]]
for key, table in (("sourceProjections", "article_mutation_command"),
                   ("expectedTables", "shadow_article_mutation_command")):
    before_rows, after_rows = ({row["table"]: row for row in plan[key]} for plan in (before, after))
    assert before_rows.pop(table)["sha256"] != after_rows.pop(table)["sha256"]
    assert before_rows == after_rows
PY
    if "${apply[@]}" > "$root/error.log" 2>&1; then exit 1; fi
    rg -F 'The import plan no longer matches' "$root/error.log"
    "${source_sql[@]}" "UPDATE article_mutation_command SET request_hash='$source_command_hash'"
    "${source_sql[@]}" 'DROP INDEX ux_article_mutation_command_identity'
    rc=0
    "${plan[@]}" > "$root/rejected.json" || rc=$?
    [[ "$rc" == 2 ]]
    python3 - "$root/rejected.json" <<'PY'
import json, pathlib, sys
report = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert not report["readyToStage"]
assert report["findings"] == [{"category":"unsupported-source-relation","source":"article_mutation_command","rows":1}], report
PY
    "${source_sql[@]}" 'CREATE UNIQUE INDEX ux_article_mutation_command_identity
        ON article_mutation_command(admin_principal_id,client_mutation_id)'
fi
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
if [[ "$provider" == postgres ]]; then
    [[ "$("${target_sql[@]}" -qAtc "SELECT id,admin_principal_id,client_mutation_id,request_hash,article_id,revision_id,
        revision_no,release_id,release_no,status,rights_snapshot_id,rights_revision_no,created_at_utc::timestamp
        FROM fsus_legacy_candidate.shadow_article_mutation_command")" \
        == "990000001|7|$source_command_id|$source_command_hash|42|5000000001|1|900000001|1|2|700|1|2026-10-01 00:00:00" ]]
    [[ "$("${target_sql[@]}" -qAtc 'SELECT (SELECT count(*) FROM public.article_command),
        (SELECT count(*) FROM public.blog_outbox)')" == '0|0' ]]
    "${target_sql[@]}" -c "UPDATE fsus_legacy_candidate.shadow_article_mutation_command SET request_hash=repeat('A',64)"
    if "${apply[@]}" > "$root/error.log" 2>&1; then exit 1; fi
    rg -Fx 'Candidate table shadow_article_mutation_command does not match its independently read source projection.' "$root/error.log"
    "${target_sql[@]}" -c "UPDATE fsus_legacy_candidate.shadow_article_mutation_command SET request_hash='$source_command_hash'"
    "${apply[@]}" > "$root/revalidated.json"
    python3 - "$root/applied.json" "$root/revalidated.json" <<'PY'
import json, pathlib, sys
applied, retry = [json.loads(pathlib.Path(path).read_text()) for path in sys.argv[1:]]
assert retry["planSha256"] == applied["planSha256"] and retry["readyToApply"] is False
assert [item["result"] for item in retry["phases"]] == ["revalidated"] * 3
PY
fi
if "${migrate[@]}" verify > "$root/error.log" 2>&1; then exit 1; fi
rg -F 'isolated legacy import candidate and cannot serve' "$root/error.log"

# Model an interruption after phase 2 in the disposable database.
phase_three_tables='fsus_legacy_candidate.shadow_article_rights_policy,
    fsus_legacy_candidate.shadow_article_rights_snapshot, fsus_legacy_candidate.shadow_article_responsibility_snapshot'
if [[ "$provider" == postgres ]]; then
    phase_three_tables+=', fsus_legacy_candidate.shadow_article_mutation_command'
fi
"${target_sql[@]}" -c "BEGIN; DROP TABLE $phase_three_tables; DELETE FROM fsus_legacy_candidate.checkpoint WHERE phase=3; COMMIT"
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
if [[ "$provider" == postgres ]]; then
    "${target_sql[@]}" -c "UPDATE fsus_legacy_candidate.shadow_revision SET body='published ☃' WHERE revision=2"
    plan_sha="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["planSha256"])' < "$root/applied.json")"
    project_args=("${migrate[@]}" legacy import project "$root/import.json" "$plan_sha" "$backup" "$manifest")
    verify_args=("${migrate[@]}" legacy import verify "$root/import.json" "$plan_sha" "$backup" "$manifest")
    unset FSUSBLOG_V1_DB FSUSBLOG_V1_SCHEMA
    "${project_args[@]}" > "$root/projected.json"
    shadow_unique="$("${target_sql[@]}" -qAtc "SELECT conname FROM pg_constraint
        WHERE conrelid='fsus_legacy_candidate.shadow_article_mutation_command'::regclass AND contype='u'")"
    [[ "$shadow_unique" =~ ^[a-z0-9_]+$ ]]
    "${target_sql[@]}" -c "ALTER TABLE fsus_legacy_candidate.shadow_article_mutation_command DROP CONSTRAINT \"$shadow_unique\""
    if "${verify_args[@]}" > "$root/error.log" 2>&1; then exit 1; fi
    rg -Fx 'Candidate table shadow_article_mutation_command shape differs.' "$root/error.log"
    "${target_sql[@]}" -c 'ALTER TABLE fsus_legacy_candidate.shadow_article_mutation_command
        ADD UNIQUE (admin_principal_id,client_mutation_id)'
    "${verify_args[@]}" > "$root/verified.json"
    python3 - "$root/projected.json" "$root/verified.json" <<'PY'
import json, pathlib, sys
projected, verified = [json.loads(pathlib.Path(path).read_text()) for path in sys.argv[1:]]
assert [projected["result"], verified["result"]] == ["projected", "verified"]
assert projected["projectionSha256"] == verified["projectionSha256"]
assert all(item["retainedLegacyCreateCommands"] == 1 and item["readyToApply"] is False
           for item in (projected, verified))
PY
    [[ "$("${target_sql[@]}" -qAtc 'SELECT (SELECT count(*) FROM public.article),
        (SELECT count(*) FROM public.article_command),(SELECT count(*) FROM public.blog_outbox)')" == '1|0|0' ]]
fi
printf 'Legacy %s source to PostgreSQL candidate import, resume, refusal and independent recovery passed.\n' "$provider"
