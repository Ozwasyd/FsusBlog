#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [[ "${PGHOST:-}" != /* || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_DB:-}" ]]; then
    printf '%s\n' 'Set PGHOST and PGUSER for the isolated PostgreSQL Unix socket, with matching FSUSBLOG_TEST_DB.' >&2
    exit 2
fi
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
export DOTNET_BIN="${DOTNET_BIN:-dotnet}"
export FSUSBLOG_MIGRATE_DLL="src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll"
project=src/Migrate/FsusBlogV2.Migrate.csproj
migrate=("$DOTNET_BIN" "$FSUSBLOG_MIGRATE_DLL")
maintenance=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d postgres)
umask 077
scratch="$(mktemp -d /tmp/fsusv2-legacy-project.XXXXXXXX)"
scratch="$(cd "$scratch" && pwd -P)"
database_prefix="fsusv2_import_project_$(openssl rand -hex 9)"
created=()
role=''
cleanup() {
    local code=$? database
    for database in ${created[@]+"${created[@]}"}; do
        if ! "${maintenance[@]}" -c "DROP DATABASE \"$database\""; then
            printf 'Could not remove owned test database %s\n' "$database" >&2
            code=1
        fi
    done
    if [[ -n "$role" ]] && ! "${maintenance[@]}" -c "DROP ROLE \"$role\""; then
        printf 'Could not remove the owned projection test role %s\n' "$role" >&2
        code=1
    fi
    find "$scratch" -depth -delete || code=1
    exit "$code"
}
trap cleanup EXIT

"$DOTNET_BIN" restore "$project" --configfile NuGet.Config --locked-mode
"$DOTNET_BIN" build "$project" --no-restore

owner=968ffb2b-77ef-4868-89ec-6a0a19b28b95
fixture=(tests/Integration/Migration/legacy-source-fixture.sql tests/Integration/Migration/legacy-shared-rights-fixture.sql)
digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
expect_refused() {
    if "$@" > "$run/refused.json" 2> "$run/error.log"; then
        printf '%s\n' 'The legacy projection unexpectedly succeeded.' >&2
        exit 1
    fi
    [[ -s "$run/error.log" || -s "$run/refused.json" ]]
}

prepare_candidate() {
    local case_name="$1" result rc=0
    local database="${database_prefix}_$case_name"
    run="$scratch/$case_name"
    mkdir -m 700 "$run" "$run/backup" "$run/media"
    export FSUSBLOG_V1_SQLITE_PATH="$run/source.sqlite"
    cat "${fixture[@]}" | sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH"
    # Match the old writer's actual transition kind and first/latest timestamp semantics.
    sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH" "
        UPDATE article_publication SET transition_kind='immediate-publish';
        UPDATE article SET last_published_at='2026-10-02 00:00:00',
            public_updated_at='2026-10-02 00:00:00';"
    # A syntactically valid captured digest which independent canonical recomputation must disprove.
    case "$case_name" in
        invalid_content)
            sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH" "UPDATE article_rights_snapshot
                SET content_canonical_hash='sha256:0000000000000000000000000000000000000000000000000000000000000000'
                WHERE id=701"
            ;;
        invalid_policy)
            sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH" "UPDATE article_rights_snapshot
                SET policy_hash='sha256:0000000000000000000000000000000000000000000000000000000000000000'
                WHERE id=701"
            ;;
        rollback|rollback_wrong_source|rollback_hidden|rollback_wrong_digest)
            sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH" < tests/Integration/Migration/legacy-projected-rollback-fixture.sql
            case "$case_name" in
                rollback_wrong_source)
                    sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH" "
                        UPDATE article_revision SET rollback_source_revision_id=5000000002 WHERE id=5000000004"
                    ;;
                rollback_hidden)
                    # v1 also appends a rollback publication when the resulting article stays a draft.
                    sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH" "
                        UPDATE article SET status=0,last_published_at=NULL,public_updated_at='2026-10-04 00:00:00';
                        UPDATE article_rights_snapshot
                        SET content_canonical_hash='sha256:5dde0c378a2c13cf79df9f26aade010058a1b5d1aba16b6b4e8949a8917c0eea',
                            policy_hash='sha256:26fd6e71c79716a5cd429563d9e23d1d208137da854eafe82069bb3fba89ee69'
                        WHERE id=702"
                    ;;
                rollback_wrong_digest)
                    sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH" "
                        UPDATE article_rights_snapshot SET
                            content_canonical_hash='sha256:0000000000000000000000000000000000000000000000000000000000000000'
                        WHERE id=702"
                    ;;
            esac
            ;;
    esac
    source_before="$(digest "$FSUSBLOG_V1_SQLITE_PATH")"

    "${maintenance[@]}" -c "CREATE DATABASE \"$database\" TEMPLATE template0"
    created+=("$database")
    sql=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d "$database")
    export FSUSBLOG_IMPORT_DB="${FSUSBLOG_TEST_DB%;};Database=$database"
    export FSUSBLOG_DB="$FSUSBLOG_IMPORT_DB" PGDATABASE="$database"
    "${migrate[@]}" plan > "$run/bootstrap.json"
    "${migrate[@]}" apply "$run/bootstrap.json"
    "${sql[@]}" -c "INSERT INTO public.blog_user VALUES ('$owner','Projection owner',true,true,1)"
    result="$(python3 tools/site-backup.py capture "$run/backup" seed "$run/media")"
    backup_digest="${result##* }"
    backup="$run/backup/seed"
    [[ "$backup_digest" =~ ^[0-9a-f]{64}$ ]]
    python3 tools/site-backup.py verify "$backup" "$backup_digest"

    "${migrate[@]}" legacy plan sqlite > "$run/intake.json" || rc=$?
    [[ "$rc" == 2 ]]
    python3 - "$run/intake.json" "$run/owner.json" "$owner" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text())
article = next(row for row in report["audit"]["projections"] if row["table"] == "article")
owner_map = {
    "sourceArticleSha256": article["sha256"],
    "sourceAdminIdentitySha256": report["sourceAdminIdentitySha256"],
    "owners": [{"articleId": 42, "legacyAdminId": 7, "v2UserId": sys.argv[3]}],
}
Path(sys.argv[2]).write_text(json.dumps(owner_map))
PY
    "${migrate[@]}" legacy import plan sqlite "$run/owner.json" "$backup" "$backup_digest" > "$run/import.json"
    "${migrate[@]}" legacy import apply sqlite "$run/owner.json" "$backup" "$backup_digest" "$run/import.json" > "$run/staged.json"
    [[ "$(digest "$FSUSBLOG_V1_SQLITE_PATH")" == "$source_before" ]]
    plan_digest="$(python3 - "$run/staged.json" <<'PY'
import json
import re
import sys
from pathlib import Path

digest = json.loads(Path(sys.argv[1]).read_text())["planSha256"]
assert re.fullmatch("[0-9a-f]{64}", digest)
print(digest)
PY
)"
    project_rows=("${migrate[@]}" legacy import project "$run/import.json" "$plan_digest" "$backup" "$backup_digest")
    verify_rows=("${migrate[@]}" legacy import verify "$run/import.json" "$plan_digest" "$backup" "$backup_digest")
}

state() {
    "${sql[@]}" -Atc "SELECT version,
        (SELECT count(*) FROM public.article),
        (SELECT count(*) FROM public.article_revision),
        (SELECT count(*) FROM public.article_publication),
        (SELECT count(*) FROM public.article_publication_history),
        (SELECT count(*) FROM public.article_revision_rights),
        (SELECT count(*) FROM public.article_publication_rights),
        (SELECT count(*) FROM public.category),
        (SELECT count(*) FROM public.tag),
        (SELECT count(*) FROM public.tag_url_name),
        (SELECT count(*) FROM public.article_command),
        (SELECT count(*) FROM public.blog_outbox),
        (SELECT last_value::text || ':' || is_called::text FROM public.article_id_seq),
        (SELECT last_value::text || ':' || is_called::text FROM public.article_publication_publication_id_seq),
        (SELECT last_value::text || ':' || is_called::text FROM public.article_publication_rights_id_seq),
        to_regclass('fsus_legacy_candidate.current_projection') IS NOT NULL
        FROM public.v2_schema WHERE singleton"
}

prepare_candidate valid
before="$(state)"
[[ "$before" == '-1|0|0|0|0|0|0|0|0|0|0|0|1:false|1:false|1:false|f' ]]
expect_refused "${verify_rows[@]}"
expect_refused "${migrate[@]}" legacy import project "$run/import.json" "$backup_digest" "$backup" "$backup_digest"
expect_refused "${migrate[@]}" legacy import project "$run/import.json" "$(digest "$run/import.json")" "$backup" "$backup_digest"
[[ "$(state)" == "$before" ]]

# Projection and verification operate from the sealed staging lineage, with no legacy connection.
unset FSUSBLOG_V1_SQLITE_PATH FSUSBLOG_V1_DB
role="fsusv2_proj_$(openssl rand -hex 12)"
"${maintenance[@]}" -c "CREATE ROLE \"$role\" LOGIN"
"${sql[@]}" -c "GRANT USAGE ON SCHEMA public,fsus_legacy_candidate TO \"$role\";
    GRANT SELECT ON ALL TABLES IN SCHEMA public,fsus_legacy_candidate TO \"$role\";
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$role\";
    GRANT INSERT ON public.category,public.tag,public.tag_url_name,public.article,public.article_revision,
      public.article_revision_category,public.article_revision_tag,public.article_publication,
      public.article_publication_history,public.article_revision_rights TO \"$role\""
[[ "$("${sql[@]}" -Atc "SELECT has_table_privilege('$role','public.article_revision_rights','INSERT'),
    has_table_privilege('$role','public.article_publication_rights','INSERT')")" == 't|f' ]]
FSUSBLOG_IMPORT_DB="$FSUSBLOG_IMPORT_DB;Username=$role" expect_refused "${project_rows[@]}"
rg -Fx 'Projection of article_publication_rights was rejected (42501).' "$run/error.log"
[[ "$(state)" == "$before" ]]

"${project_rows[@]}" > "$run/projected.json"
"${project_rows[@]}" > "$run/repeat.json"
FSUSBLOG_IMPORT_DB="$FSUSBLOG_IMPORT_DB;Options=-c default_transaction_read_only=on" \
    "${verify_rows[@]}" > "$run/verified.json"
python3 - "$run/projected.json" "$run/repeat.json" "$run/verified.json" <<'PY'
import json
import re
import sys
from pathlib import Path

done, repeat, verified = [json.loads(Path(path).read_text()) for path in sys.argv[1:]]
assert [row["result"] for row in (done, repeat, verified)] == ["projected", "revalidated", "verified"]
assert all(row["readyToApply"] is False for row in (done, repeat, verified))
for key in ("planSha256", "projectionSha256"):
    assert re.fullmatch("[0-9a-f]{64}", done[key])
    assert done[key] == repeat[key] == verified[key]
assert all(row["retainedLegacyPublicationRows"] == 2 for row in (done, repeat, verified))
PY
[[ "$("${sql[@]}" -Atc "SELECT id,owner_id,revision,title,body,published_revision,publication_count,deleted FROM public.article")" \
    == "42|$owner|3|Private edit|Private edit ☃|2|2|f" ]]
[[ "$("${sql[@]}" -Atc "SELECT revision,title,body FROM public.article_revision ORDER BY revision")" \
    == $'1|First|first\n2|Public|published ☃\n3|Private edit|Private edit ☃' ]]
[[ "$("${sql[@]}" -Atc "SELECT article_id,publication_id,revision,publication_no,published_at AT TIME ZONE 'UTC' FROM public.article_publication")" \
    == '42|900000002|2|2|2026-10-02 00:00:00' ]]
[[ "$("${sql[@]}" -Atc "SELECT article_id,event_no,revision,publication_id,publication_no,kind,actor_id IS NULL,command_id IS NULL
    FROM public.article_publication_history")" == '42|1|2|900000002|2|retained-active|t|t' ]]
[[ "$("${sql[@]}" -Atc "SELECT source_publication_id,source_revision_id,source_rights_snapshot_id,
    source_responsibility_snapshot_id FROM fsus_legacy_candidate.shadow_publication ORDER BY publication_number")" \
    == $'900000001|5000000001|700|\n900000002|5000000002|701|800' ]]
[[ "$("${sql[@]}" -Atc "SELECT revision,license_type,copyright_holder,rights_statement FROM public.article_revision_rights ORDER BY revision")" \
    == $'1|all-rights-reserved|Fixture Author|Historic rights ☃\n2|CC-BY-4.0|Fixture Author|Updated rights' ]]
[[ "$("${sql[@]}" -Atc "SELECT id,article_id,publication_id,revision FROM public.article_publication_rights ORDER BY id")" \
    == $'700|42|900000001|1\n701|42|900000002|2' ]]
[[ "$("${sql[@]}" -Atc "SELECT revision,tag_id FROM public.article_revision_tag ORDER BY revision,tag_id")" \
    == $'1|21\n2|21\n3|22\n3|23' ]]
[[ "$("${sql[@]}" -Atc "SELECT revision,category_id FROM public.article_revision_category ORDER BY revision")" \
    == $'1|11\n2|11\n3|12' ]]
[[ "$("${sql[@]}" -Atc "SELECT name_key,tag_id FROM public.tag_url_name ORDER BY name_key COLLATE \"C\"")" \
    == $'BLOG NEWS|21\nCAFÉ|23\nCAFÉ ARCHIVE|23\nNEWS|21\nWORK IN PROGRESS|22' ]]
[[ "$("${sql[@]}" -Atc "SELECT (SELECT count(*) FROM public.article_command),
    (SELECT count(*) FROM public.blog_outbox), (SELECT count(*) FROM fsus_legacy_candidate.current_projection)")" == '0|0|1' ]]
[[ "$("${sql[@]}" -Atc "SELECT (SELECT last_value FROM public.article_id_seq),
    (SELECT last_value FROM public.article_publication_publication_id_seq),
    (SELECT last_value FROM public.article_publication_rights_id_seq)")" == '43|900000003|702' ]]
expect_refused "${migrate[@]}" verify
rg -F 'isolated legacy import candidate and cannot serve' "$run/error.log"

"${sql[@]}" -c "UPDATE fsus_legacy_candidate.shadow_revision SET body='shadow drift' WHERE revision=2"
expect_refused "${verify_rows[@]}"
expect_refused "${project_rows[@]}"
"${sql[@]}" -c "UPDATE fsus_legacy_candidate.shadow_revision SET body='published ☃' WHERE revision=2"
"${sql[@]}" -c "UPDATE public.article SET title='public projection drift' WHERE id=42"
expect_refused "${verify_rows[@]}"
expect_refused "${project_rows[@]}"
"${sql[@]}" -c "UPDATE public.article SET title='Private edit' WHERE id=42"
"${verify_rows[@]}" > /dev/null
[[ "$(digest "$run/source.sqlite")" == "$source_before" ]]

prepare_candidate invalid_content
before="$(state)"
expect_refused "${project_rows[@]}"
rg -F 'canonical content SHA-256' "$run/error.log" "$run/refused.json"
[[ "$(state)" == "$before" ]]
expect_refused "${project_rows[@]}"
[[ "$(state)" == "$before" && "$(digest "$FSUSBLOG_V1_SQLITE_PATH")" == "$source_before" ]]
prepare_candidate invalid_policy
before="$(state)"
expect_refused "${project_rows[@]}"
rg -F 'rights policy SHA-256' "$run/error.log" "$run/refused.json"
[[ "$(state)" == "$before" && "$(digest "$FSUSBLOG_V1_SQLITE_PATH")" == "$source_before" ]]
prepare_candidate rollback
"${project_rows[@]}" > "$run/projected.json"
"${project_rows[@]}" > "$run/revalidated.json"
FSUSBLOG_IMPORT_DB="$FSUSBLOG_IMPORT_DB;Options=-c default_transaction_read_only=on" \
    "${verify_rows[@]}" > "$run/verified.json"
python3 - "$run/projected.json" "$run/revalidated.json" "$run/verified.json" <<'PY'
import json, sys
from pathlib import Path
receipts = [json.loads(Path(path).read_text()) for path in sys.argv[1:]]
assert [receipt["result"] for receipt in receipts] == ["projected", "revalidated", "verified"]
assert all(receipt["verifiedPublishedRollbackRows"] == 1 and receipt["retainedLegacyPublicationRows"] == 3
           and receipt["readyToApply"] is False for receipt in receipts)
assert len({receipt["projectionSha256"] for receipt in receipts}) == 1
PY
[[ "$("${sql[@]}" -Atc "SELECT a.revision,a.title,a.body,p.publication_id,p.publication_no,p.published_at AT TIME ZONE 'UTC'
    FROM public.article a JOIN public.article_publication p ON p.article_id=a.id")" == '4|First|first|900000003|3|2026-10-04 00:00:00' ]]
[[ "$("${sql[@]}" -Atc "SELECT source_revision_id,source_rollback_revision_id,source_admin_id,source_rollback_reason
    FROM fsus_legacy_candidate.shadow_revision WHERE revision=4")" == '5000000004|5000000001|7|Return to the original article text' ]]
[[ "$("${sql[@]}" -Atc "SELECT id,publication_id,revision FROM public.article_publication_rights ORDER BY publication_id")" \
    == $'700|900000001|1\n701|900000002|2\n702|900000003|4' ]]
[[ "$("${sql[@]}" -Atc "SELECT kind,actor_id IS NULL,command_id IS NULL FROM public.article_publication_history")" == 'retained-active|t|t' ]]
[[ "$("${sql[@]}" -Atc "SELECT (SELECT count(*) FROM public.article_rollback),(SELECT count(*) FROM public.article_command),
    (SELECT count(*) FROM public.blog_outbox)")" == '0|0|0' ]]
[[ "$(digest "$FSUSBLOG_V1_SQLITE_PATH")" == "$source_before" ]]

for case_name in rollback_wrong_source rollback_hidden rollback_wrong_digest; do
    prepare_candidate "$case_name"
    before="$(state)"
    expect_refused "${project_rows[@]}"
    if [[ "$case_name" == rollback_wrong_digest ]]; then
        rg -F 'canonical content SHA-256' "$run/error.log"
    else
        rg -F 'legacy published rollback lacks its exact historical source or cloned provenance' "$run/error.log"
    fi
    [[ "$(state)" == "$before" && "$(digest "$FSUSBLOG_V1_SQLITE_PATH")" == "$source_before" ]]
done
printf '%s\n' 'Staged legacy data projected and reverified with original publication IDs, rights, permanent quarantine, drift refusal, and no changes after a refused projection.'
