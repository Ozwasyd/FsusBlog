#!/usr/bin/env bash
set -euo pipefail
umask 077
ulimit -c 0
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$repo"
fixture="$repo/tests/Integration/Migration"
activate=false
activate_rollback=false
authored_disclosure=false
malformed_disclosure=false
site_author_raw=
republish_profile=false
mixed_profile=false
expected_articles=1
case "$# ${1:-}" in
    '0 '|'1 --activate')
        if [[ "${1:-}" == --activate ]]; then activate=true; fi
        profile=first plan_version=3 expected_publications=1 rollback_profile=false
        source_overlays=("$fixture/legacy-runtime-first-publication-fixture.sql")
        public_expectation=(42 1 900000001 700 11 'News' 'Blog News' 'Legacy first publication' 'Verified starlight rehearsal.' 'Verified starlight rehearsal.')
        ;;
    '1 --activate-republish'|'1 --activate-mixed')
        activate=true republish_profile=true
        profile=republish plan_version=4 expected_publications=2 rollback_profile=false
        source_overlays=("$fixture/legacy-republish-outbox-fixture.sql")
        if [[ "$1" == --activate-mixed ]]; then
            mixed_profile=true profile=mixed expected_articles=2 expected_publications=3
            source_overlays+=("$fixture/legacy-runtime-mixed-fixture.sql")
        fi
        public_expectation=(42 2 900000002 701 12 'Work in progress' 'In progress' 'Public' 'published ☃' 'Second public summary' --republish)
        ;;
    '1 --rollback'|'1 --activate-rollback'|'1 --activate-rollback-authored'|'1 --activate-rollback-malformed'|'1 --activate-rollback-site-author')
        profile=rollback plan_version=5 expected_publications=3 rollback_profile=true
        if [[ "$1" != --rollback ]]; then
            activate=true activate_rollback=true profile=rollback-activated
        fi
        source_overlays=("$fixture/legacy-republish-outbox-fixture.sql")
        case "$1" in
            --activate-rollback-authored) authored_disclosure=true profile=rollback-authored ;;
            --activate-rollback-malformed) malformed_disclosure=true profile=rollback-malformed ;;
            --activate-rollback-site-author)
                profile=rollback-site-author
                # After trimming, the emoji that follows the 18-byte prefix crosses the 20-byte v1 cap.
                site_author_raw='　甲乙🙂AB丙丁🚀尾　'
                ;;
        esac
        if [[ "$authored_disclosure" == true || "$malformed_disclosure" == true ]]; then
            source_overlays+=("$fixture/legacy-runtime-authored-fixture.sql")
        fi
        source_overlays+=("$fixture/legacy-rollback-outbox-fixture.sql")
        public_expectation=(42 3 900000003 702 11 'News' 'Blog News' 'First' 'first' 'First public summary' --rollback)
        ;;
    *) printf 'Usage: %s [--rollback|--activate|--activate-republish|--activate-mixed|--activate-rollback|--activate-rollback-authored|--activate-rollback-malformed|--activate-rollback-site-author]\n' "$0" >&2; exit 2 ;;
esac
source_fixtures=("$fixture/legacy-source-fixture.sql" "$fixture/legacy-shared-rights-fixture.sql"
    "$fixture/legacy-article-outbox-fixture.sql" "${source_overlays[@]}")
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then export PATH="$PG_TOOLS_DIR:$PATH"; fi
dotnet_bin=$(command -v "${DOTNET_BIN:-dotnet}")
migrate_dir=${FSUSBLOG_NATIVE_MIGRATE_BUILD:-$repo/src/Migrate/bin/Release/net10.0}
server_dir=${FSUSBLOG_NATIVE_SERVER_BUILD:-$repo/src/Server/bin/Release/net10.0}
web_dir=${FSUSBLOG_WEB_DIST:-$repo/src/Web/dist}
export DOTNET_BIN="$dotnet_bin"
for artifact in "$migrate_dir/FsusBlogV2.Migrate.dll" "$server_dir/FsusBlog.V2.Server.dll" "$web_dir/index.html"; do
    [[ -f "$artifact" ]] || { printf 'Missing prebuilt v2 artifact %s\n' "$artifact" >&2; exit 2; }
done
migrate_dir=$(cd -- "$migrate_dir" && pwd -P)
server_dir=$(cd -- "$server_dir" && pwd -P)
web_dir=$(cd -- "$web_dir" && pwd -P)
export FSUSBLOG_MIGRATE_DLL="$migrate_dir/FsusBlogV2.Migrate.dll"
server_dll="$server_dir/FsusBlog.V2.Server.dll"
for executable in initdb pg_ctl psql pg_dump pg_restore python3 node curl shasum rg; do command -v "$executable" >/dev/null; done

evidence_parent=${FSUSBLOG_TEST_EVIDENCE:-$repo/artifacts/native-migration}
mkdir -p -- "$evidence_parent"
evidence=$(mktemp -d "$evidence_parent/legacy-runtime.XXXXXXXX")
evidence=$(cd -- "$evidence" && pwd)
scratch=$(mktemp -d /tmp/fsusv2-legacy-runtime.XXXXXXXX)
scratch=$(cd -- "$scratch" && pwd -P)
server_pid=
pg_attempted=0
stop_server() {
    local attempt
    [[ -n "$server_pid" ]] || return 0
    if kill -0 "$server_pid" 2>/dev/null; then kill "$server_pid"; fi
    for ((attempt=0; attempt<120; attempt++)); do
        if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
        sleep 0.1
    done
    if kill -0 "$server_pid" 2>/dev/null; then
        kill -KILL "$server_pid"
        wait "$server_pid" 2>/dev/null || true
        server_pid=
        return 1
    fi
    wait "$server_pid" 2>/dev/null || true
    server_pid=
}
cleanup() {
    local status=$? clean=yes
    trap - EXIT
    stop_server || clean=no
    if (( pg_attempted )) && pg_ctl -D "$scratch/data" status >/dev/null 2>&1; then
        pg_ctl -D "$scratch/data" -m fast -w -t 20 stop >> "$evidence/postgres.log" 2>&1 || clean=no
    fi
    if pg_ctl -D "$scratch/data" status >/dev/null 2>&1; then clean=no; fi
    if [[ "$clean" == yes && "$status" == 0 ]]; then find "$scratch" -depth -delete || clean=no; fi
    if [[ "$status" != 0 || "$clean" != yes ]]; then printf 'retained_scene=%s\n' "$scratch" >> "$evidence/run.txt"; fi
    if [[ "$clean" != yes ]]; then status=1; fi
    printf 'exit=%s\ncleanup=%s\nended=%s\n' "$status" "$clean" "$(date -u +%FT%TZ)" >> "$evidence/run.txt"
    printf 'Evidence %s\n' "$evidence"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'printf "Runtime rehearsal failed at line %s.\n" "$LINENO" >&2' ERR
mkdir "$scratch/socket" "$scratch/backups" "$scratch/transfer" "$scratch/readback" "$scratch/media" "$scratch/restored-media" \
    "$scratch/server-work"
{
    printf 'started=%s\nprofile=%s\n' "$(date -u +%FT%TZ)" "$profile"
    git rev-parse HEAD 2>/dev/null || true
    "$dotnet_bin" --version
    psql --version
    node --version
    shasum -a 256 "$FSUSBLOG_MIGRATE_DLL" "$server_dll" "$web_dir/index.html" "$fixture"/legacy-runtime*.{sh,sql,mjs} \
        "${source_fixtures[@]}"
} > "$evidence/run.txt"

unset PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGPASSFILE PGSSLMODE PGHOSTADDR
export PGHOST="$scratch/socket" PGPORT=54934 PGUSER=legacy_runtime_qa
initdb -D "$scratch/data" -U "$PGUSER" --auth-local=trust --auth-host=reject --locale=C -E UTF8 > "$evidence/init.log"
pg_attempted=1
pg_ctl -D "$scratch/data" -l "$evidence/postgres.log" -o "-c listen_addresses='' -p $PGPORT -k $PGHOST -c unix_socket_permissions=0700" -w -t 20 start

source_db=legacy_runtime_v1
quarantine_db=fsusv2_import_runtime_quarantine
runtime_db=legacy_runtime_v2
restore_db=legacy_runtime_v2_restore
if [[ "$activate" == true || "$rollback_profile" == true ]]; then
    v1_prefix="fsusv2_import_$(openssl rand -hex 12)"
    source_db="${v1_prefix}_source"
    recovered_source="${v1_prefix}_source_restore"
    runtime_db=fsusv2_import_runtime_first_release
    restored_seed=fsusv2_import_runtime_first_release_restore
fi
psql_db() { psql -X -q --no-password -v ON_ERROR_STOP=1 -d "$@"; }
dsn() { printf 'Host=%s;Port=%s;Username=%s;Database=%s;SSL Mode=Disable' "$PGHOST" "$PGPORT" "$PGUSER" "$1"; }
migrate_db() { local db=$1; shift; FSUSBLOG_DB="$(dsn "$db")" "$dotnet_bin" "$FSUSBLOG_MIGRATE_DLL" "$@"; }
bootstrap() {
    migrate_db "$1" plan > "$scratch/$1-bootstrap.json"
    migrate_db "$1" apply "$scratch/$1-bootstrap.json"
    migrate_db "$1" verify
}
capture() {
    local result
    result=$(PGDATABASE="$1" FSUSBLOG_DB="$(dsn "$1")" python3 tools/site-backup.py capture "$scratch/backups" "$2" "$scratch/media")
    [[ "${result##* }" =~ ^[0-9a-f]{64}$ ]]
    printf '%s\n' "${result##* }"
}
site_id() { psql_db "$1" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton'; }
db_oid() { psql_db "$1" -Atc 'SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()'; }
for db in "$source_db" "$quarantine_db" "$runtime_db" "$restore_db"; do
    psql_db postgres -c "CREATE DATABASE $db TEMPLATE template0"
done
for source_fixture in "${source_fixtures[@]}"; do
    psql_db "$source_db" -v malformed_disclosure="$malformed_disclosure" -f "$source_fixture"
done
if [[ "$rollback_profile" == true ]]; then
    psql_db "$source_db" -c 'CREATE TABLE public.sys_systemconfig (key varchar(64) PRIMARY KEY, value varchar(512) NOT NULL)'
fi
if [[ -n "$site_author_raw" ]]; then
    psql_db "$source_db" -v site_author_raw="$site_author_raw" <<'SITE_AUTHOR_SEED'
INSERT INTO public.sys_systemconfig (key,value) VALUES ('Seo_Author',:'site_author_raw');
SITE_AUTHOR_SEED
fi
if [[ "$republish_profile" == true ]]; then
    # Both actual publications have null responsibility. The v1 policy digest excludes the proof-binding flag.
    psql_db "$source_db" -c "DELETE FROM article_responsibility_snapshot; UPDATE article_rights_snapshot SET proof_binding_enabled=false;
        UPDATE article_rights_policy SET proof_binding_enabled=false;
        INSERT INTO tag_url_alias VALUES ('IN PROGRESS',22,'In progress','2026-09-07 00:00:00')"
fi
if [[ "$activate" == true || "$rollback_profile" == true ]]; then
    psql_db postgres -c "CREATE DATABASE $recovered_source TEMPLATE template0"
    mkdir -m 700 "$scratch/v1-backup"
    PYTHONDONTWRITEBYTECODE=1 python3 "$fixture/legacy-source-backup.py" "$source_db" "$recovered_source" "$scratch/v1-backup" \
        > "$evidence/legacy-source-restore.json"
    source_db="$recovered_source"
fi
if [[ "$activate" == true ]]; then
    psql_db postgres -c "CREATE DATABASE $restored_seed TEMPLATE template0"
    mkdir -m 700 "$scratch/approval"
fi
bootstrap "$quarantine_db"
bootstrap "$runtime_db"
if [[ "$activate_rollback" == true ]]; then
    migrate_db "$runtime_db" legacy release-origin-schema > "$evidence/release-origin-schema.log"
    [[ "$(psql_db "$runtime_db" -Atc 'SELECT count(*) FROM public.legacy_release_origin')" == 0 ]]
fi
quarantine_site=$(site_id "$quarantine_db")
runtime_site=$(site_id "$runtime_db")
[[ -n "$quarantine_site" && -n "$runtime_site" && "$quarantine_site" != "$runtime_site" ]]
quarantine_oid=$(db_oid "$quarantine_db")
runtime_oid=$(db_oid "$runtime_db")
[[ "$quarantine_oid" != "$runtime_oid" && "$runtime_oid" != "$(db_oid "$restore_db")" ]]
owner=968ffb2b-77ef-4868-89ec-6a0a19b28b95
psql_db "$quarantine_db" -c "INSERT INTO public.blog_user VALUES ('$owner','Fixture projection owner',true,true,1)"
quarantine_backup="$scratch/backups/quarantine-seed"
quarantine_backup_sha=$(capture "$quarantine_db" quarantine-seed)
if [[ "$activate" == true ]]; then
    psql_db "$runtime_db" -c "INSERT INTO public.blog_user VALUES ('$owner','Reviewed disabled legacy custodian',false,false,1)"
fi
runtime_empty_sha=$(capture "$runtime_db" runtime-seed)
python3 tools/site-backup.py verify "$quarantine_backup" "$quarantine_backup_sha"
python3 tools/site-backup.py verify "$scratch/backups/runtime-seed" "$runtime_empty_sha"

FSUSBLOG_IMPORT_DB=$(dsn "$quarantine_db")
FSUSBLOG_V1_DB="$(dsn "$source_db");Options=-c default_transaction_read_only=on"
export FSUSBLOG_IMPORT_DB FSUSBLOG_V1_DB FSUSBLOG_V1_SCHEMA=public
intake_status=0
migrate_db "$quarantine_db" legacy plan postgres > "$scratch/intake.json" || intake_status=$?
[[ "$intake_status" == 2 ]]
python3 - "$scratch/intake.json" "$scratch/owners.json" "$owner" "$expected_articles" <<'PY'
import json
import sys
from pathlib import Path

intake, output, owner, articles = sys.argv[1:]
articles = int(articles)
report = json.loads(Path(intake).read_text())
article, = [row for row in report["audit"]["projections"] if row["table"] == "article"]
assert article["rows"] == articles, article
Path(output).write_text(json.dumps({
    "sourceArticleSha256": article["sha256"], "sourceAdminIdentitySha256": report["sourceAdminIdentitySha256"],
    "owners": [{"articleId": 42 + offset, "legacyAdminId": 7, "v2UserId": owner} for offset in range(articles)],
}))
PY
legacy_input=(postgres "$scratch/owners.json" "$quarantine_backup" "$quarantine_backup_sha")
migrate_db "$quarantine_db" legacy import plan "${legacy_input[@]}" > "$scratch/reviewed.json"
python3 - "$scratch/reviewed.json" "$plan_version" "$expected_articles" "$expected_publications" <<'PY'
import json
import sys
from pathlib import Path

path = sys.argv[1]
version, articles, publications = map(int, sys.argv[2:])
plan = json.loads(Path(path).read_text())
assert plan["version"] == version and plan["readyToStage"] and not plan["readyToApply"] and not plan["findings"], plan
counts = {row["table"]: row["rows"] for row in plan["expectedTables"]}
assert counts["shadow_article"] == articles
assert counts["shadow_revision"] == counts["shadow_publication"] == publications
assert counts["shadow_article_mutation_outbox"] == publications and counts["shadow_article_mutation_outbox_edge"] == 7 * publications
assert counts["shadow_article_responsibility_snapshot"] == (2 if version == 5 else 0)
assert "shadow_article_mutation_command" not in counts
PY
if [[ -n "$site_author_raw" ]]; then
    python3 - "$scratch/reviewed.json" "$site_author_raw" <<'CHECK_APPROVED_SITE_AUTHOR'
import json
import sys
from pathlib import Path

assert json.loads(Path(sys.argv[1]).read_text())['siteAuthor'] == sys.argv[2]
CHECK_APPROVED_SITE_AUTHOR
    psql_db "$source_db" -c "UPDATE public.sys_systemconfig SET value='Different sealed author' WHERE key='Seo_Author'"
    if migrate_db "$quarantine_db" legacy import apply "${legacy_input[@]}" "$scratch/reviewed.json" \
        > "$evidence/import-wrong-site-author.log" 2>&1; then exit 1; fi
    rg -Fq 'The import plan no longer matches its source' "$evidence/import-wrong-site-author.log"
    [[ "$(psql_db "$quarantine_db" -Atc "SELECT to_regnamespace('fsus_legacy_candidate') IS NULL")" == t ]]
    FSUSBLOG_DB="$(dsn "$quarantine_db")" python3 tools/site-backup.py verify-restored "$quarantine_backup" "$quarantine_backup_sha" "$scratch/media"
    psql_db "$source_db" -v site_author_raw="$site_author_raw" <<'RESTORE_SITE_AUTHOR'
UPDATE public.sys_systemconfig SET value=:'site_author_raw' WHERE key='Seo_Author';
RESTORE_SITE_AUTHOR
fi
migrate_db "$quarantine_db" legacy import apply "${legacy_input[@]}" "$scratch/reviewed.json" > "$scratch/applied.json"
unset FSUSBLOG_V1_DB FSUSBLOG_V1_SCHEMA
json_hash() {
    python3 - "$1" "$2" <<'PY'
import json
import re
import sys
from pathlib import Path

path, key = sys.argv[1:]
value = json.loads(Path(path).read_text())[key]
assert re.fullmatch(r"[0-9a-f]{64}", value)
print(value)
PY
}
plan_sha=$(json_hash "$scratch/applied.json" planSha256)
projection_args=("$scratch/reviewed.json" "$plan_sha" "$quarantine_backup" "$quarantine_backup_sha")
migrate_db "$quarantine_db" legacy import project "${projection_args[@]}" > "$scratch/projected.json"
projection_sha=$(json_hash "$scratch/projected.json" projectionSha256)
if [[ "$activate_rollback" == true ]]; then
    source_admin_sha=$(json_hash "$scratch/reviewed.json" sourceAdminIdentitySha256)
fi
verify_quarantine() {
    FSUSBLOG_IMPORT_DB="$(dsn "$quarantine_db");Options=-c default_transaction_read_only=on" \
        migrate_db "$quarantine_db" legacy import verify "${projection_args[@]}" > "$scratch/quarantine-checked.json"
    [[ "$(json_hash "$scratch/quarantine-checked.json" projectionSha256)" == "$projection_sha" ]]
}
verify_quarantine
python3 - "$scratch/projected.json" "$scratch/quarantine-checked.json" "$expected_publications" "$plan_version" <<'PY'
import json
import sys
from pathlib import Path

projected, verified = sys.argv[1:3]
publications, version = map(int, sys.argv[3:])
reports = [json.loads(Path(path).read_text()) for path in (projected, verified)]
assert [row["result"] for row in reports] == ["projected", "verified"]
for row in reports:
    assert not row["readyToApply"] and row["retainedLegacyPublicationRows"] == publications
    assert row["retainedLegacyCreateCommands"] == row["retainedInitialSchedules"] == 0
    assert row["retainedLegacyOutboxEvents"] == publications and row["retainedLegacyOutboxEdges"] == 7 * publications
    assert row["verifiedPublishedRollbackRows"] == row["retainedLegacyRollbackOutboxEvents"] == (1 if version == 5 else 0)
    assert row["retainedLegacyRepublishOutboxEvents"] == (1 if publications >= 2 else 0)
PY
if [[ "$rollback_profile" == true ]]; then
    custody_query="$fixture/legacy-runtime-rollback-custody.sql"
    psql_db "$source_db" -At -v quarantined=false -f "$custody_query" > "$scratch/source-history.jsonl"
    psql_db "$quarantine_db" -At -v quarantined=true -f "$custody_query" > "$scratch/quarantined-history.jsonl"
    cmp "$scratch/source-history.jsonl" "$scratch/quarantined-history.jsonl"
    python3 - "$scratch/quarantined-history.jsonl" <<'PY'
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

rows = defaultdict(list)
for line in Path(sys.argv[1]).read_text().splitlines():
    row = json.loads(line)
    rows[row[0]].append(row)

assert {name: len(items) for name, items in rows.items()} == {
    "article": 1, "revision": 3, "publication": 3, "category": 2, "tag": 3, "tag-alias": 2, "article-tag": 1,
    "rights": 3, "responsibility": 2, "event": 3, "edge": 21,
}
assert [(r[1], r[3], r[4], r[7], r[8], r[9], r[14], r[15], r[16]) for r in rows["revision"]] == [
    (5000000001, 1, "First", "first", 11, "21", 7, None, None),
    (5000000002, 2, "Public", "published ☃", 12, "22", 8, None, None),
    (5000000003, 3, "First", "first", 11, "21", 7, 5000000001, "Restore the original reviewed article"),
]
assert [p[1:9] for p in rows["publication"]] == [
    [900000001, 42, 1, 5000000001, 1, 700, None, "immediate-publish"],
    [900000002, 42, 2, 5000000002, 2, 701, None, "immediate-publish"],
    [900000003, 42, 3, 5000000003, 3, 702, 802, "rollback"],
]
assert [p[9:11] for p in rows["publication"]] == [[f"2026-10-0{n}T00:00:00"] * 2 for n in (1, 2, 3)]
assert [r[1] for r in rows["rights"]] == [700, 701, 702] and all(r[16] is True for r in rows["rights"])
original, cloned = rows["responsibility"]
assert original[1:8] == [799, 42, 5000000001, 1, 1, None, "2026-10-01T00:00:00"]
assert cloned[1:8] == [802, 42, 5000000003, 3, 1, None, "2026-10-03T00:00:00.000005"]
assert original[8] == cloned[8]
assert [(e[1], e[13], e[14], e[-1]) for e in rows["event"]] == [
    (991000001, "created", "processed", "59f604a6c5ba6f8c009a056cb44bd92ec20dab97a1f261fdf44c05677280054f"),
    (991000002, "updated", "processed", "0657ced05fb326cd273f4a104732c7ed8951f84ce981b6f585054936a5f7bc66"),
    (991000003, "updated", "processed", "9d1a4412ee2732ab58a5c9be5f91d7f9b8bee90fc8d5dfd04d384bd3d40bc978"),
]
assert Counter(edge[2] for edge in rows["edge"]) == {991000001: 7, 991000002: 7, 991000003: 7}
assert len({edge[7] for edge in rows["edge"]}) == 21
assert all(edge[4] == "completed" and edge[8] is True for edge in rows["edge"])
PY
    cp "$scratch/quarantined-history.jsonl" "$evidence/verified-rollback-custody.jsonl"
    shasum -a 256 "$evidence/verified-rollback-custody.jsonl" >> "$evidence/run.txt"
fi

transfer() {
    local db=$1 oid=$2 site=$3 dir=$4 mode=$5 seal=$6 interrupt=$7
    (cd -- "$dir" && psql_db "$db" -v database_name="$db" -v database_oid="$oid" -v site_id="$site" \
        -v plan_sha="$plan_sha" -v projection_sha="$projection_sha" -v owner_id="$owner" \
        -v copy_out="$mode" -v source_seal="$seal" -v interrupt_transfer="$interrupt" -v rollback_profile="$rollback_profile" -v republish_profile="$republish_profile" -v mixed_profile="$mixed_profile" \
        -f "$fixture/legacy-runtime-transfer.sql")
}
check_release_origin() {
    local db=$1 output=$2
    psql_db "$db" -At -v plan_sha="$plan_sha" -v projection_sha="$projection_sha" -v source_admin_sha="$source_admin_sha" \
        > "$output" <<'ORIGIN_ROWS'
SELECT jsonb_build_array(article_id,revision,publication_id,source_revision_id,source_actor_id,source_rollback_revision_id,
    rollback_reason,responsibility->>'id',jsonb_array_length(evidence->'edges'),manifest->>'responsibilitySnapshotId',
    manifest->'legacyFallback',manifest #>> '{authors,0,name}',evidence #> '{rights,proof_binding_enabled}',
    evidence ?& ARRAY['publication','rights','event','edges'],
    plan_sha256=:'plan_sha' AND projection_sha256=:'projection_sha' AND source_admin_identity_sha256=:'source_admin_sha',
    encode(sha256(convert_to(jsonb_build_array(responsibility,evidence,manifest)::text,'UTF8')),'hex'),
    CASE WHEN responsibility IS NOT NULL THEN encode(sha256(convert_to(json_build_array(
        (responsibility->>'inherit_site_author')::integer=1,responsibility->>'authors_json',responsibility->>'reviewer_json',
        responsibility->>'sources_json',responsibility->>'update_summary',responsibility->>'update_reason',
        (responsibility->>'effective_at')::timestamp,responsibility->>'conclusion_impact',responsibility->>'methodology',
        responsibility->>'applicability',responsibility->>'limitations',
        (responsibility->>'responsible_person_confirmed')::integer=1)::text,'UTF8')),'hex') END,evidence->'siteAuthor')
FROM public.legacy_release_origin ORDER BY article_id,revision;
ORIGIN_ROWS
    python3 - "$output" "$scratch/source-history.jsonl" "$authored_disclosure" "$site_author_raw" <<'CHECK_ORIGIN_ROWS'
import json
import re
import sys
from pathlib import Path

rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
original = [json.loads(line) for line in Path(sys.argv[2]).read_text().splitlines()]
responsibility_hash = {row[1]: row[8] for row in original if row[0] == 'responsibility'}
site_author = '甲乙🙂AB丙丁' if sys.argv[4] else 'Fsu'
raw_site_author = {'key': 'Seo_Author', 'value': sys.argv[4]} if sys.argv[4] else None
author = 'Lead Writer' if sys.argv[3] == 'true' else site_author
assert [row[:12] for row in rows] == [
    [42, 1, 900000001, 5000000001, 7, None, None, '799', 7, '799', False, author],
    [42, 2, 900000002, 5000000002, 8, None, None, None, 7, None, True, site_author],
    [42, 3, 900000003, 5000000003, 7, 5000000001, 'Restore the original reviewed article', '802', 7, '802', False, author],
]
assert [row[16] for row in rows] == [responsibility_hash[799], None, responsibility_hash[802]]
assert [row[17] for row in rows] == [raw_site_author] * 3
for row in rows:
    # The frozen SQLite-compatible projection can encode the same true value as the integer 1.
    assert row[12] in (True, 1) and row[13:15] == [True, True] and re.fullmatch(r'[0-9a-f]{64}', row[15]), row
CHECK_ORIGIN_ROWS
}
transfer "$quarantine_db" "$quarantine_oid" "$quarantine_site" "$scratch/transfer" true true false
if [[ "$activate" == true ]]; then
    FSUSBLOG_RELEASE_ACTIVATION_DB=$(dsn "$runtime_db")
    export FSUSBLOG_RELEASE_ACTIVATION_DB
    seed="$scratch/backups/runtime-seed"
    pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d "$restored_seed" "$seed/database.dump"
    FSUSBLOG_DB="$(dsn "$restored_seed")" python3 tools/site-backup.py verify-restored "$seed" "$runtime_empty_sha" "$scratch/media"
    release_plan="$scratch/approval/release.json"
    launch=("$runtime_site" "$seed" "$runtime_empty_sha")
    if [[ "$malformed_disclosure" == true ]]; then
        if migrate_db "$quarantine_db" legacy import release-plan "${projection_args[@]}" "${launch[@]}" \
            > "$evidence/release-malformed-disclosure.log" 2>&1; then exit 1; fi
        rg -Fq 'Legacy rollback responsibility disclosure is malformed or exceeds its byte budget.' \
            "$evidence/release-malformed-disclosure.log"
        FSUSBLOG_DB="$(dsn "$runtime_db")" python3 tools/site-backup.py verify-restored "$seed" "$runtime_empty_sha" "$scratch/media"
        verify_quarantine
        printf 'Malformed responsibility disclosure refused. Runtime backup and quarantine verified.\n'
        exit 0
    fi
    migrate_db "$quarantine_db" legacy import release-plan "${projection_args[@]}" "${launch[@]}" > "$release_plan"
    if [[ "$activate_rollback" == true ]]; then
        python3 - "$release_plan" <<'CHECK_APPROVED_ORIGIN'
import json
import re
import sys
from pathlib import Path

approved = json.loads(Path(sys.argv[1]).read_text())
origin, = [row for row in approved['relations'] if row['name'] == 'legacy_release_origin']
assert origin['rows'] == 3 and origin['kind'] == 'r' and re.fullmatch(r'[0-9a-f]{64}', origin['sha256']), origin
CHECK_APPROVED_ORIGIN
    fi
    release_sha="$(shasum -a 256 "$release_plan" | cut -d' ' -f1)"
    run_release() { migrate_db "$quarantine_db" legacy import release-activate "${projection_args[@]}" "${launch[@]}" "$release_plan" "$release_sha"; }
    if FSUSBLOG_RELEASE_ACTIVATION_DB="$(dsn "$restored_seed")" run_release > "$evidence/release-wrong-target.log" 2>&1; then exit 1; fi
    rg -Fq 'approved release activation plan differs' "$evidence/release-wrong-target.log"
    if FSUSBLOG_IMPORT_DB="$(dsn "$restored_seed")" run_release > "$evidence/release-wrong-source.log" 2>&1; then exit 1; fi
    rg -Fq 'not the original staged database and site' "$evidence/release-wrong-source.log"
    policy=$(psql_db "$quarantine_db" -Atc 'SELECT rights_statement FROM fsus_legacy_candidate.shadow_article_rights_policy WHERE article_id=42')
    psql_db "$quarantine_db" -c "UPDATE fsus_legacy_candidate.shadow_article_rights_policy SET rights_statement='Unreviewed change' WHERE article_id=42"
    if run_release > "$evidence/release-wrong-rights.log" 2>&1; then exit 1; fi
    rg -Fq 'Staged source has changed: shadow_article_rights_policy' "$evidence/release-wrong-rights.log"
    psql_db "$quarantine_db" -v original_policy="$policy" <<'RESTORE_POLICY'
UPDATE fsus_legacy_candidate.shadow_article_rights_policy SET rights_statement=:'original_policy' WHERE article_id=42;
RESTORE_POLICY
    FSUSBLOG_DB="$(dsn "$runtime_db")" python3 tools/site-backup.py verify-restored "$seed" "$runtime_empty_sha" "$scratch/media"
    run_release > "$evidence/release-activated.json"
    if [[ "$activate_rollback" == true ]]; then
        check_release_origin "$runtime_db" "$evidence/activated-release-origin.jsonl"
        if [[ "$authored_disclosure" == true ]]; then
            psql_db "$runtime_db" -c "UPDATE public.legacy_release_origin SET responsibility=jsonb_set(responsibility,
                '{sources_json}',to_jsonb('[]'::text)) WHERE article_id=42 AND revision=3"
        else
            psql_db "$runtime_db" -c 'UPDATE public.legacy_release_origin SET source_actor_id=8 WHERE article_id=42 AND revision=3'
        fi
        if run_release > "$evidence/release-wrong-origin.log" 2>&1; then exit 1; fi
        rg -Fq 'match neither the empty rollback nor this complete approved batch' "$evidence/release-wrong-origin.log"
        if [[ "$authored_disclosure" == true ]]; then
            psql_db "$runtime_db" -c "UPDATE public.legacy_release_origin AS restored SET responsibility=jsonb_set(restored.responsibility,
                '{sources_json}',original.responsibility->'sources_json') FROM public.legacy_release_origin AS original
                WHERE restored.article_id=42 AND restored.revision=3 AND original.article_id=42 AND original.revision=1"
        else
            psql_db "$runtime_db" -c 'UPDATE public.legacy_release_origin SET source_actor_id=7 WHERE article_id=42 AND revision=3'
        fi
    fi
    if [[ "$republish_profile" == true ]]; then
        psql_db "$runtime_db" -c "UPDATE public.article_revision SET body='Unapproved first revision' WHERE article_id=42 AND revision=1"
        if run_release > "$evidence/release-wrong-history.log" 2>&1; then exit 1; fi
        rg -Fq 'match neither the empty rollback nor this complete approved batch' "$evidence/release-wrong-history.log"
        psql_db "$runtime_db" -c "UPDATE public.article_revision SET body='first' WHERE article_id=42 AND revision=1"
    fi
    run_release > "$evidence/release-retry.json"
    python3 - "$evidence/release-activated.json" "$evidence/release-retry.json" "$release_sha" "$expected_articles" <<'RELEASE_REPLAY'
import json, pathlib, sys
applied, retried = [json.loads(pathlib.Path(path).read_bytes()) for path in sys.argv[1:3]]
assert applied['result'] == 'activated' and retried['result'] == 'revalidated'
assert applied['activationSha256'] == retried['activationSha256'] == sys.argv[3]
assert applied['publications'] == int(sys.argv[4]) and not applied['legacyCandidateServing'] and not applied['readyToApply']
RELEASE_REPLAY
else
    if [[ "$rollback_profile" == true ]]; then
        if FSUSBLOG_RELEASE_ACTIVATION_DB="$(dsn "$runtime_db")" migrate_db "$quarantine_db" legacy import release-plan "${projection_args[@]}" "$runtime_site" \
            "$scratch/backups/runtime-seed" "$runtime_empty_sha" > "$evidence/release-rollback-refused.log" 2>&1; then exit 1; fi
        rg -Fq 'Rollback activation requires the offline legacy release-origin schema.' "$evidence/release-rollback-refused.log"
    fi
    if transfer "$runtime_db" "$runtime_oid" "$quarantine_site" "$scratch/transfer" false false false > "$evidence/wrong-site.log" 2>&1; then exit 1; fi
    rg -Fq 'Rehearsal transfer database identity or ownership lock differs' "$evidence/wrong-site.log"
    if transfer "$runtime_db" "$runtime_oid" "$runtime_site" "$scratch/transfer" false false true > "$evidence/interrupted.log" 2>&1; then exit 1; fi
    rg -Fq 'Injected failure after rehearsal transfer' "$evidence/interrupted.log"
    FSUSBLOG_DB="$(dsn "$runtime_db")" python3 tools/site-backup.py verify-restored "$scratch/backups/runtime-seed" "$runtime_empty_sha" "$scratch/media"
    transfer "$runtime_db" "$runtime_oid" "$runtime_site" "$scratch/transfer" false false false
fi
transfer "$runtime_db" "$runtime_oid" "$runtime_site" "$scratch/readback" true false false
for rows in "$scratch/transfer/"*.csv; do cmp "$rows" "$scratch/readback/${rows##*/}"; done
verify_quarantine
migrate_db "$runtime_db" verify

runtime_backup_sha=$(capture "$runtime_db" runtime-ready)
runtime_backup="$scratch/backups/runtime-ready"
python3 tools/site-backup.py verify "$runtime_backup" "$runtime_backup_sha"
python3 - "$scratch/backups/runtime-seed/manifest.json" "$runtime_backup/manifest.json" "$scratch/transfer" "$activate" "$activate_rollback" <<'PY'
import json
import sys
from pathlib import Path

def read(path):
    site = json.loads(Path(path).read_text())["site"]
    assert not site["media"]
    return {row["name"]: row for row in site["relations"]}

before, after, exported, activated, activated_rollback = sys.argv[1:]
expected = {row.stem for row in Path(exported).glob("*.csv")} | {
    "blog_user", "article_id_seq", "category_id_seq", "tag_id_seq", "article_publication_publication_id_seq",
    "article_publication_rights_id_seq",
}
if activated == 'true': expected.remove('blog_user')
if activated_rollback == 'true': expected.add('legacy_release_origin')
left, right = read(before), read(after)
assert left.keys() == right.keys()
assert {name for name in left if left[name] != right[name]} == expected
for name in expected:
    if right[name]["kind"] == "r":
        assert left[name]["rows"] == 0 and right[name]["rows"] > 0, name
PY
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d "$restore_db" "$runtime_backup/database.dump"
[[ "$(site_id "$restore_db")" == "$runtime_site" ]]
FSUSBLOG_DB="$(dsn "$restore_db")" python3 tools/site-backup.py verify-restored "$runtime_backup" "$runtime_backup_sha" "$scratch/restored-media"
if [[ "$activate_rollback" == true ]]; then
    check_release_origin "$restore_db" "$evidence/restored-release-origin.jsonl"
    cmp "$evidence/activated-release-origin.jsonl" "$evidence/restored-release-origin.jsonl"
    shasum -a 256 "$evidence/restored-release-origin.jsonl" >> "$evidence/run.txt"
fi

start_server() {
    (
        cd -- "$scratch/server-work"
        exec env -i PATH="$PATH" LC_ALL=C TZ=UTC DOTNET_PROCESSOR_COUNT="${DOTNET_PROCESSOR_COUNT:-2}" \
            ASPNETCORE_ENVIRONMENT=Production ASPNETCORE_URLS=http://127.0.0.1:0 \
            FSUSBLOG_DB="$(dsn "$1")" FSUSBLOG_WEB_DIST="$web_dir" "$dotnet_bin" "$server_dll"
    ) > "$2" 2>&1 &
    server_pid=$!
}
start_server "$quarantine_db" "$evidence/quarantine-server.log"
for ((attempt=0; attempt<160; attempt++)); do
    if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
    sleep 0.1
done
if kill -0 "$server_pid" 2>/dev/null; then exit 1; fi
if wait "$server_pid"; then exit 1; fi
server_pid=
rg -Fq 'isolated legacy import candidate and cannot serve' "$evidence/quarantine-server.log"
if rg -Fq 'Now listening on' "$evidence/quarantine-server.log"; then exit 1; fi

probe_server() {
    local label=$1 log="$evidence/$1-server.log" url='' found=no candidate attempt
    local served_db="$runtime_db"
    if [[ "$activate" == true ]]; then served_db="$restore_db"; fi
    start_server "$served_db" "$log"
    for ((attempt=0; attempt<300; attempt++)); do
        kill -0 "$server_pid" 2>/dev/null || return 1
        candidate=$(rg -o 'Now listening on: http://127\.0\.0\.1:[0-9]+' "$log" | head -n1 || true)
        candidate=${candidate#Now listening on: }
        if [[ -n "$candidate" ]]; then url=$candidate; break; fi
        sleep 0.1
    done
    [[ -n "$url" ]]
    for ((attempt=0; attempt<100; attempt++)); do
        kill -0 "$server_pid" 2>/dev/null || return 1
        if [[ "$(curl --noproxy '*' --silent --max-time 1 --output /dev/null --write-out '%{http_code}' "$url/health/ready")" == 204 ]]; then
            found=yes
            break
        fi
        sleep 0.1
    done
    [[ "$found" == yes ]]
    env -i PATH="$PATH" node "$fixture/legacy-runtime-public.mjs" "$url" "${public_expectation[@]}" > "$evidence/$label-probe.sha256"
    if [[ "$activate_rollback" == true ]]; then
        local accountability_args=("$url")
        if [[ "$authored_disclosure" == true ]]; then accountability_args+=(--authored); fi
        if [[ -n "$site_author_raw" ]]; then accountability_args+=(--site-author); fi
        env -i PATH="$PATH" node "$fixture/legacy-runtime-accountability.mjs" "${accountability_args[@]}" > "$evidence/$label-accountability.sha256"
        if [[ "$label" == restarted ]]; then
            # Remove the restored scratch article's active coordinate while the original Kestrel snapshot is still resident.
            psql_db "$served_db" -c 'BEGIN; UPDATE public.article SET published_revision=NULL WHERE id=42;
                DELETE FROM public.article_publication WHERE article_id=42; COMMIT;'
            env -i PATH="$PATH" node "$fixture/legacy-runtime-accountability.mjs" "$url" --hidden > "$evidence/hidden-accountability.sha256"
        fi
    fi
    if [[ "$mixed_profile" == true ]]; then
        env -i PATH="$PATH" node "$fixture/legacy-runtime-public.mjs" "$url" 43 1 900000003 702 11 'News' 'Blog News' \
            'Independent masthead' 'first' 'Different first summary' >> "$evidence/$label-probe.sha256"
    fi
    stop_server
}
probe_server first
probe_server restarted
cmp "$evidence/first-probe.sha256" "$evidence/restarted-probe.sha256"
if [[ "$activate_rollback" == true ]]; then
    cmp "$evidence/first-accountability.sha256" "$evidence/restarted-accountability.sha256"
fi
FSUSBLOG_DB="$(dsn "$runtime_db")" python3 tools/site-backup.py verify-restored "$runtime_backup" "$runtime_backup_sha" "$scratch/media"
verify_quarantine
printf 'plan_sha256=%s\nprojection_sha256=%s\nruntime_manifest_sha256=%s\n' "$plan_sha" "$projection_sha" "$runtime_backup_sha" >> "$evidence/run.txt"
printf 'Verified retained %s publication in a separate recovered, default v2 rehearsal. Original quarantine preserved.\n' "$profile"
