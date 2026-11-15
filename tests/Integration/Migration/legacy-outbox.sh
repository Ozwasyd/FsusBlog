#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [[ "${PGHOST:-}" != /* || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_DB:-}" ]]; then
    printf '%s\n' 'Set the isolated PostgreSQL maintenance DSN and matching Unix socket/client variables.' >&2
    exit 2
fi
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
export DOTNET_BIN="${DOTNET_BIN:-dotnet}"
export FSUSBLOG_MIGRATE_DLL=src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll
migrate=("$DOTNET_BIN" "$FSUSBLOG_MIGRATE_DLL")
project=src/Migrate/FsusBlogV2.Migrate.csproj
umask 077
scratch="$(mktemp -d /tmp/fsusv2-legacy-outbox.XXXXXXXX)"
scratch="$(cd "$scratch" && pwd -P)"
candidate="fsusv2_import_outbox_$(openssl rand -hex 10)"
source_db="${candidate}_source"
maintenance=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d postgres)
created=()
cleanup() {
    local code=$? db
    for db in ${created[@]+"${created[@]}"}; do
        "${maintenance[@]}" -c "DROP DATABASE \"$db\" WITH (FORCE)" || code=1
    done
    find "$scratch" -depth -delete || code=1
    exit "$code"
}
trap cleanup EXIT
trap 'printf "Legacy Outbox drill failed at line %s.\n" "$LINENO" >&2' ERR
for db in "$candidate" "$source_db"; do
    "${maintenance[@]}" -c "CREATE DATABASE \"$db\" TEMPLATE template0"
    created+=("$db")
done
target=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d "$candidate")
source_sql=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d "$source_db")
export FSUSBLOG_IMPORT_DB="${FSUSBLOG_TEST_DB%;};Database=$candidate"
export FSUSBLOG_DB="$FSUSBLOG_IMPORT_DB" PGDATABASE="$candidate"
export FSUSBLOG_V1_DB="${FSUSBLOG_TEST_DB%;};Database=$source_db;Options=-c default_transaction_read_only=on"
export FSUSBLOG_V1_SCHEMA=public
fixture=tests/Integration/Migration
"${source_sql[@]}" -f "$fixture/legacy-source-fixture.sql" -f "$fixture/legacy-shared-rights-fixture.sql" \
    -f "$fixture/legacy-article-outbox-fixture.sql"

"$DOTNET_BIN" restore "$project" --configfile NuGet.Config --locked-mode
"$DOTNET_BIN" build "$project" --no-restore
"${migrate[@]}" plan > "$scratch/bootstrap.json"
"${migrate[@]}" apply "$scratch/bootstrap.json"
owner=968ffb2b-77ef-4868-89ec-6a0a19b28b95
"${target[@]}" -c "INSERT INTO public.blog_user VALUES ('$owner','Outbox fixture owner',true,true,1)"
mkdir "$scratch/backup" "$scratch/media"
backup_report="$(python3 tools/site-backup.py capture "$scratch/backup" seed "$scratch/media")"
backup_sha="${backup_report##* }"
backup="$scratch/backup/seed"
[[ "$backup_sha" =~ ^[0-9a-f]{64}$ ]]
python3 tools/site-backup.py verify "$backup" "$backup_sha"

code=0
"${migrate[@]}" legacy plan postgres > "$scratch/intake.json" || code=$?
[[ "$code" == 2 ]]
python3 - "$scratch/intake.json" "$scratch/owner.json" "$owner" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text())
article = next(row for row in report["audit"]["projections"] if row["table"] == "article")
Path(sys.argv[2]).write_text(json.dumps({
    "sourceArticleSha256": article["sha256"],
    "sourceAdminIdentitySha256": report["sourceAdminIdentitySha256"],
    "owners": [{"articleId": 42, "legacyAdminId": 7, "v2UserId": sys.argv[3]}],
}))
PY
command=("${migrate[@]}" legacy import)
plan=("${command[@]}" plan postgres "$scratch/owner.json" "$backup" "$backup_sha")
apply=("${command[@]}" apply postgres "$scratch/owner.json" "$backup" "$backup_sha" "$scratch/reviewed.json")
event_table=article_mutation_outbox
edge_table=article_mutation_outbox_edge
outbox_event=04226af3773343789bd570bd9861f531

expect_refused() {
    if "$@" > "$scratch/refused.json" 2> "$scratch/error.log"; then
        printf '%s\n' 'Expected the isolated Outbox rehearsal to refuse this invocation.' >&2
        return 1
    fi
    [[ -s "$scratch/error.log" || -s "$scratch/refused.json" ]]
}
expect_source_finding() {
    local kind="$1" table="$2" code=0
    "${plan[@]}" > "$scratch/blocked.json" || code=$?
    [[ "$code" == 2 ]]
    python3 - "$scratch/blocked.json" "$kind" "$table" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text())
assert report["readyToStage"] is False and report["readyToApply"] is False
assert any(row["category"] == sys.argv[2] and row["source"] == sys.argv[3] and row["rows"] >= 1
           for row in report["findings"]), report
PY
    expect_refused "${apply[@]}"
    rg -Fq 'contains unsupported rows' "$scratch/error.log"
    [[ "$("${target[@]}" -qAtc "SELECT version,to_regnamespace('fsus_legacy_candidate') IS NULL FROM public.v2_schema")" == '1|t' ]]
}

"${plan[@]}" > "$scratch/reviewed.json"
python3 - "$scratch/reviewed.json" <<'PY'
import json
import re
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text())
assert plan["version"] == 3 and plan["readyToStage"] is True and plan["readyToApply"] is False
assert not plan["findings"]
for key, prefix in (("sourceProjections", ""), ("expectedTables", "shadow_")):
    assert len(plan[key]) == 14
    events, edges = plan[key][-2:]
    assert events["table"] == prefix + "article_mutation_outbox" and events["rows"] == 1
    assert edges["table"] == prefix + "article_mutation_outbox_edge" and edges["rows"] == 8
    assert all(re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) for item in (events, edges))
PY

"${source_sql[@]}" -c "DELETE FROM $edge_table WHERE edge_name='notification'"
"${plan[@]}" > "$scratch/without-optional.json"
python3 - "$scratch/without-optional.json" <<'PY'
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text())
assert plan["version"] == 3 and plan["readyToStage"] is True
assert plan["sourceProjections"][-1]["rows"] == plan["expectedTables"][-1]["rows"] == 7
PY
"${source_sql[@]}" -c "INSERT INTO $edge_table (id,outbox_event_id,edge_name,status,attempt_count,updated_at,delivery_key)
    VALUES (991100008,991000001,'notification','completed',1,'2026-10-01 00:00:02',
        encode(sha256(convert_to('$outbox_event:notification','UTF8')),'hex'))"
for state in pending processing poison; do
    "${source_sql[@]}" -c "UPDATE $event_table SET status='$state',processed_at=NULL"
    expect_source_finding "legacy-outbox-$state" "$event_table"
done
"${source_sql[@]}" -c "UPDATE $event_table SET status='processed',processed_at='2026-10-01 00:00:03'"
"${source_sql[@]}" -c "UPDATE $event_table SET claim_token='fixture-unfinished-claim'"
expect_source_finding legacy-outbox-state "$event_table"
"${source_sql[@]}" -c "UPDATE $event_table SET claim_token=NULL"
"${source_sql[@]}" -c "UPDATE $event_table SET payload_json=replace(payload_json,'\"releaseId\":900000001','\"releaseId\":900000002')"
expect_source_finding legacy-outbox-envelope "$event_table"
"${source_sql[@]}" -c "UPDATE $event_table SET payload_json=replace(payload_json,'\"releaseId\":900000002','\"releaseId\":900000001')"
"${source_sql[@]}" -c "UPDATE $event_table SET payload_json=replace(payload_json,
    '\"publicUpdatedAt\":\"2026-10-01T00:00:00.0000007Z\"','\"publicUpdatedAt\":\"2026-10-01T00:00:00.0000008Z\"')"
expect_source_finding legacy-outbox-envelope "$event_table"
"${source_sql[@]}" -c "UPDATE $event_table SET payload_json=replace(payload_json,'0000008Z','0000007Z')"
"${source_sql[@]}" -c "UPDATE $edge_table SET delivery_key=repeat('0',64) WHERE edge_name='search-projection'"
expect_source_finding legacy-outbox-edge "$edge_table"
"${source_sql[@]}" -c "UPDATE $edge_table SET delivery_key=encode(sha256(convert_to('$outbox_event:' || edge_name,'UTF8')),'hex')
    WHERE edge_name='search-projection'"
for edge in search-projection notification; do
    for state in skipped failed; do
        "${source_sql[@]}" -c "UPDATE $edge_table SET status='$state',last_error='Fixture retained failure' WHERE edge_name='$edge'"
        expect_source_finding legacy-outbox-edge "$edge_table"
    done
    "${source_sql[@]}" -c "UPDATE $edge_table SET status='completed',last_error=NULL WHERE edge_name='$edge'"
done
"${source_sql[@]}" -c "UPDATE $edge_table SET outbox_event_id=991000002 WHERE edge_name='search-projection'"
expect_source_finding legacy-outbox-orphan-edge "$edge_table"
expect_source_finding legacy-outbox-missing-required-edge "$event_table"
"${source_sql[@]}" -c "UPDATE $edge_table SET outbox_event_id=991000001 WHERE edge_name='search-projection'"
"${source_sql[@]}" -c 'DROP INDEX ux_article_mutation_outbox_edge_event_name'
expect_source_finding legacy-outbox-catalog "$edge_table"
"${source_sql[@]}" -c "CREATE UNIQUE INDEX ux_article_mutation_outbox_edge_event_name ON $edge_table(outbox_event_id,edge_name)"
"${source_sql[@]}" -c "UPDATE $edge_table SET attempt_count=2 WHERE edge_name='search-projection'"
"${plan[@]}" > "$scratch/source-drift.json"
python3 - "$scratch/reviewed.json" "$scratch/source-drift.json" <<'PY'
import json
import sys
from pathlib import Path

before, after = [json.loads(Path(path).read_text()) for path in sys.argv[1:]]
for key in ("sourceProjections", "expectedTables"):
    assert before[key][:-1] == after[key][:-1]
    assert before[key][-1]["sha256"] != after[key][-1]["sha256"]
PY
expect_refused "${apply[@]}"
rg -F 'The import plan no longer matches' "$scratch/error.log"
"${source_sql[@]}" -c "UPDATE $edge_table SET attempt_count=1 WHERE edge_name='search-projection'"
"${source_sql[@]}" -f "$fixture/legacy-article-command-fixture.sql"
"${plan[@]}" > "$scratch/reviewed.json"
python3 - "$scratch/reviewed.json" <<'PY'
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text())
assert plan["version"] == 3 and plan["readyToStage"] is True and plan["readyToApply"] is False
for key, prefix in (("sourceProjections", ""), ("expectedTables", "shadow_")):
    assert len(plan[key]) == 15
    assert [(row["table"], row["rows"]) for row in plan[key][-3:]] == [
        (prefix + "article_mutation_command", 1),
        (prefix + "article_mutation_outbox", 1),
        (prefix + "article_mutation_outbox_edge", 8)]
PY

source_bytes() {
    "${source_sql[@]}" -qAtc "SELECT row_to_json(e) FROM $event_table e ORDER BY id;
        SELECT row_to_json(e) FROM $edge_table e ORDER BY id;
        SELECT row_to_json(c) FROM article_mutation_command c ORDER BY id;"
}
source_before="$(source_bytes)"
"${apply[@]}" > "$scratch/applied.json"
[[ "$(source_bytes)" == "$source_before" ]]
shadow_event="fsus_legacy_candidate.shadow_$event_table"
shadow_edge="fsus_legacy_candidate.shadow_$edge_table"
[[ "$("${target[@]}" -qAtc "SELECT id,event_id,aggregate_id,article_revision_id,rights_snapshot_id,article_publication_id,
    created_at,next_retry_at::timestamp,processed_at::timestamp,status,
    claim_token IS NULL,claimed_by IS NULL,last_error IS NULL FROM $shadow_event")" \
    == "991000001|$outbox_event|42|5000000001|700|900000001|2026-10-01T00:00:00.0000000|2026-10-01 00:02:00|2026-10-01 00:00:03|processed|t|t|t" ]]
[[ "$("${source_sql[@]}" -qAtc "SELECT encode(sha256(convert_to(payload_json,'UTF8')),'hex') FROM $event_table")" \
    == "$("${target[@]}" -qAtc "SELECT encode(sha256(convert_to(payload_json,'UTF8')),'hex') FROM $shadow_event")" ]]
[[ "$("${target[@]}" -qAtc "SELECT count(*),bool_and(status='completed' AND attempt_count=1 AND
    delivery_key=encode(sha256(convert_to('$outbox_event:' || edge_name,'UTF8')),'hex')) FROM $shadow_edge")" == '8|t' ]]
plan_sha="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["planSha256"])' < "$scratch/applied.json")"
[[ "$plan_sha" =~ ^[0-9a-f]{64}$ ]]

# A partial phase-3 interruption with matching source is recoverable.
"${target[@]}" -c "DROP TABLE $shadow_event,$shadow_edge,fsus_legacy_candidate.shadow_article_rights_policy,
    fsus_legacy_candidate.shadow_article_rights_snapshot,fsus_legacy_candidate.shadow_article_responsibility_snapshot,
    fsus_legacy_candidate.shadow_article_mutation_command;
    DELETE FROM fsus_legacy_candidate.checkpoint WHERE phase=3"
"${apply[@]}" > "$scratch/resumed.json"
python3 - "$scratch/resumed.json" "$plan_sha" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text())
assert report["planSha256"] == sys.argv[2] and report["readyToApply"] is False
assert [(row["phase"], row["result"]) for row in report["phases"]] == [
    (1, "revalidated"), (2, "revalidated"), (3, "staged")]
PY
[[ "$(source_bytes)" == "$source_before" ]]
unset FSUSBLOG_V1_DB FSUSBLOG_V1_SCHEMA
project_rows=("${command[@]}" project "$scratch/reviewed.json" "$plan_sha" "$backup" "$backup_sha")
verify_rows=("${command[@]}" verify "$scratch/reviewed.json" "$plan_sha" "$backup" "$backup_sha")
"${project_rows[@]}" > "$scratch/projected.json"
"${project_rows[@]}" > "$scratch/revalidated.json"
FSUSBLOG_IMPORT_DB="$FSUSBLOG_IMPORT_DB;Options=-c default_transaction_read_only=on" "${verify_rows[@]}" > "$scratch/verified.json"
python3 - "$scratch/projected.json" "$scratch/revalidated.json" "$scratch/verified.json" <<'PY'
import json
import sys
from pathlib import Path

reports = [json.loads(Path(path).read_text()) for path in sys.argv[1:]]
assert [row["result"] for row in reports] == ["projected", "revalidated", "verified"]
assert all(row["retainedLegacyOutboxEvents"] == 1 and row["retainedLegacyOutboxEdges"] == 8
           and row["retainedLegacyCreateCommands"] == 1 and row["readyToApply"] is False for row in reports), reports
assert len({report["projectionSha256"] for report in reports}) == 1
PY
"${target[@]}" -c "UPDATE $shadow_edge SET attempt_count=2 WHERE edge_name='search-projection'"
expect_refused "${verify_rows[@]}"
rg -Fx 'Staged source has changed: shadow_article_mutation_outbox_edge.' "$scratch/error.log"
"${target[@]}" -c "UPDATE $shadow_edge SET attempt_count=1 WHERE edge_name='search-projection'"
"${verify_rows[@]}" > /dev/null
[[ "$("${target[@]}" -qAtc 'SELECT version,(SELECT count(*) FROM public.article),
    (SELECT count(*) FROM public.article_command),(SELECT count(*) FROM public.blog_outbox) FROM public.v2_schema')" == '-1|1|0|0' ]]
expect_refused "${migrate[@]}" verify
rg -F 'isolated legacy import candidate and cannot serve' "$scratch/error.log"
printf '%s\n' 'Legacy PostgreSQL processed Outbox events and their edge custody passed staging, resume, refusal and source-free projection.'
