#!/usr/bin/env bash
# Prepare and independently read back the selected C11 PostgreSQL fixture.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
repo=$PWD
if [[ $# != 2 || ( $1 != pilot && $1 != nightly ) ]]; then
    printf 'Usage: %s {pilot|nightly} NEW_EVIDENCE_DIRECTORY\n' "$0" >&2
    exit 2
fi
profile=$1
if [[ $profile == nightly ]]; then articles=100000 nightly=true; else articles=20 nightly=false; fi
if [[ -n ${PG_TOOLS_DIR:-} ]]; then export PATH="$PG_TOOLS_DIR:$PATH"; fi
dotnet=$(command -v "${DOTNET_BIN:-dotnet}")
migrate_dll=${FSUSBLOG_MIGRATE_DLL:-$repo/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}
test_dll=${FSUSBLOG_NIGHTLY_TEST_DLL:-$repo/tests/Integration/bin/Release/net10.0/FsusBlog.V2.Integration.Tests.dll}
for artifact in "$migrate_dll" "$test_dll"; do
    [[ -f $artifact ]] || { printf 'Missing built fixture artifact %s\n' "$artifact" >&2; exit 2; }
done
for executable in initdb pg_ctl psql python3 git shasum; do command -v "$executable" >/dev/null; done

mkdir -- "$2"
evidence=$(cd -- "$2" && pwd -P)
scratch=$(mktemp -d /tmp/fsusv2-nightly.XXXXXXXX)
scratch=$(cd -- "$scratch" && pwd -P)
data_dir="$scratch/data"
cleanup() {
    local result=$? cleaned=yes
    trap - EXIT
    if pg_ctl -D "$data_dir" status >/dev/null 2>&1; then
        pg_ctl -D "$data_dir" -m fast -w -t 20 stop >> "$evidence/postgres.log" 2>&1 || cleaned=no
    fi
    if pg_ctl -D "$data_dir" status >/dev/null 2>&1; then cleaned=no; fi
    if [[ $cleaned == yes ]]; then find "$scratch" -depth -delete || cleaned=no; fi
    if [[ $cleaned != yes ]]; then result=1; fi
    printf 'exit=%s\ncleanup=%s\nfinished=%s\n' "$result" "$cleaned" "$(date -u +%FT%TZ)" >> "$evidence/run.txt"
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'printf "Nightly fixture preparation failed at line %s.\n" "$LINENO" >&2' ERR
mkdir "$scratch/socket"
run_id=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
db="fsusv2_nightly_$run_id"
due=$(python3 -c 'import time; print((int(time.time()) + 86400) * 1000)')
{
    printf 'run_id=%s\nprofile=%s\nstarted=%s\ndue_unix_ms=%s\n' "$run_id" "$profile" "$(date -u +%FT%TZ)" "$due"
    git rev-parse HEAD
    "$dotnet" --version
    psql --version
    uname -a
    df -k "$scratch"
    shasum -a 256 "$migrate_dll" "$test_dll" tests/Performance/{seed.py,nightly-run.sh,nightly-plan.py,nightly-comments.sql,nightly-verify.sql}
} > "$evidence/run.txt"

phase() {
    local step=$1 started=$SECONDS
    shift
    printf 'begin %s\n' "$step" | tee -a "$evidence/phases.txt"
    /usr/bin/time -p "$@" > "$evidence/$step.log" 2>&1
    printf 'end %s %ss\n' "$step" "$((SECONDS - started))" | tee -a "$evidence/phases.txt"
}

record_filesystem() {
    {
        printf 'filesystem_phase=%s\n' "$1"
        df -Pk "$scratch"
        du -sk "$scratch"
        du -sk "$data_dir/pg_wal"
    } >> "$evidence/run.txt"
}

unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGPASSFILE PGSSLMODE PGDATABASE
export LC_ALL=C PGHOST="$scratch/socket" PGPORT=54936 PGUSER=fsusv2_nightly_qa
initdb -D "$data_dir" -U "$PGUSER" --auth-local=trust --auth-host=reject --locale=C -E UTF8 > "$evidence/init.log"
pg_ctl -D "$data_dir" -l "$evidence/postgres.log" -w -t 20 \
    -o "-c listen_addresses='' -p $PGPORT -k $PGHOST -c unix_socket_permissions=0700" start
maintenance=(psql -X -qAt --no-password -v ON_ERROR_STOP=1 -d postgres)
"${maintenance[@]}" -c "CREATE DATABASE $db TEMPLATE template0"
export PGDATABASE="$db"
export FSUSBLOG_DB="Host=$PGHOST;Port=$PGPORT;Username=$PGUSER;Database=$db;SSL Mode=Disable;Command Timeout=150"
sql=(psql -X -qAt --no-password -v ON_ERROR_STOP=1)
migrate=("$dotnet" "$migrate_dll")
"${migrate[@]}" plan > "$scratch/bootstrap.json"
phase schema "${migrate[@]}" apply "$scratch/bootstrap.json"
"${migrate[@]}" verify >> "$evidence/schema.log"
site=$("${sql[@]}" -c 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')
[[ $site =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
printf 'database=%s\nsite=%s\n' "$db" "$site" >> "$evidence/run.txt"
shasum -a 256 "$scratch/bootstrap.json" >> "$evidence/run.txt"

"${sql[@]}" <<'SQL'
BEGIN;
INSERT INTO public.category (id,name)
SELECT id,'Nightly category '||lpad(id::text,2,'0') FROM generate_series(1,32) AS s(id);
INSERT INTO public.tag (id,name)
SELECT id,'Nightly tag '||lpad(id::text,3,'0') FROM generate_series(1,128) AS s(id);
INSERT INTO public.tag_url_name(name_key,tag_id) SELECT upper(name),id FROM public.tag;
ALTER SEQUENCE public.category_id_seq RESTART WITH 33;
ALTER SEQUENCE public.tag_id_seq RESTART WITH 129;
COMMIT;
SQL
phase generate python3 -B tests/Performance/nightly-plan.py "$profile" "$due" "$scratch"
cp "$scratch/plan.json" "$evidence/plan.json"
record_filesystem before-articles

before=$("${sql[@]}" -c 'SELECT pg_current_wal_lsn()')
export FSUSBLOG_NIGHTLY_FIXTURE=1 FSUSBLOG_NIGHTLY_FIXTURE_DB="$FSUSBLOG_DB"
export FSUSBLOG_NIGHTLY_FIXTURE_SITE="$site" FSUSBLOG_NIGHTLY_FIXTURE_ARTICLES="$scratch/articles.tsv"
export FSUSBLOG_NIGHTLY_FIXTURE_COUNT="$articles" FSUSBLOG_NIGHTLY_FIXTURE_DUE_UNIX_MS="$due"
export FSUSBLOG_NIGHTLY_FIXTURE_DATA_DIR="$data_dir"
phase write-articles "$dotnet" vstest "$test_dll" '--TestCaseFilter:FullyQualifiedName~NightlyFixturePostgresTests.WritePlannedArticles' \
    '--logger:console;verbosity=detailed'
unset FSUSBLOG_NIGHTLY_FIXTURE FSUSBLOG_NIGHTLY_FIXTURE_DB FSUSBLOG_NIGHTLY_FIXTURE_SITE FSUSBLOG_NIGHTLY_FIXTURE_ARTICLES
unset FSUSBLOG_NIGHTLY_FIXTURE_COUNT FSUSBLOG_NIGHTLY_FIXTURE_DUE_UNIX_MS FSUSBLOG_NIGHTLY_FIXTURE_DATA_DIR
after_articles=$("${sql[@]}" -c 'SELECT pg_current_wal_lsn()')
record_filesystem after-articles
"${sql[@]}" -c "SELECT pg_sleep(greatest(0,extract(epoch FROM max(published_at)+interval '1 second'-clock_timestamp()))) FROM public.article_publication" >/dev/null
phase write-comments "${sql[@]}" -v database_name="$db" -v data_directory="$data_dir" -v site_id="$site" \
    -v profile="$profile" -f tests/Performance/nightly-comments.sql
after_comments=$("${sql[@]}" -c 'SELECT pg_current_wal_lsn()')
record_filesystem after-comments

phase verify-operators "${migrate[@]}" verify
phase verify-publications "${migrate[@]}" publication-canonical verify
phase verify-rows "${sql[@]}" -v database_name="$db" -v data_directory="$data_dir" -v site_id="$site" \
    -v nightly="$nightly" -v due_unix_ms="$due" -f tests/Performance/nightly-verify.sql
python3 - "$evidence" "$scratch/articles.tsv" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
plan = json.loads((path / "plan.json").read_text())
digest = hashlib.sha256()
with Path(sys.argv[2]).open("rb") as stream:
    for block in iter(lambda: stream.read(65536), b""):
        digest.update(block)
assert digest.hexdigest() == plan["articlePlanSha256"]
rows = [json.loads(line) for line in (path / "verify-rows.log").read_text().splitlines() if line.startswith("{")]
articles, = [row["actual"] for row in rows if row["kind"] == "article-graph"]
comments, = [row["actual"] for row in rows if row["kind"] == "comment-graph"]
thread, = [row for row in rows if row["kind"] == "thread-case"]
for actual, expected in {
    "articles": "articles", "active": "activePublications", "revisions": "revisions", "commands": "authorCommands",
    "archive_receipts": "archivedReleases", "publication_history": "publicationHistory",
    "publication_canonical": "canonicalPublications", "publication_rights": "retainedReleaseRights",
    "responsibility_snapshots": "responsibilitySnapshots", "schedules": "scheduled",
}.items():
    assert articles[actual] == plan[expected], (actual, articles[actual], plan[expected])
assert [comments[key] for key in ("rows", "roots", "replies", "visible_content", "structural_nodes")] == [
    plan["comments"][key] for key in ("rows", "roots", "replies", "visibleContent", "structuralNodes")
]
assert thread["ancestors"] == thread["depth"] == 32
assert thread["root"] == plan["comments"]["deepRoot"] and thread["target"] == plan["comments"]["deepTarget"]
cases = [row for row in rows if row["kind"] == "article-case"]
assert len(cases) == len(plan["articleCases"])
for row, expected in zip(cases, plan["articleCases"]):
    assert row["revision"] == expected["currentRevision"]
    for key in ("id", "publicRevision", "publicationId", "historicalFirstPublicationId", "category", "tag",
                "originalTitle", "originalBodySha256", "currentBodySha256", "archiveSupersededReleaseId",
                "archivedReleaseId", "archiveInterimBodySha256"):
        assert row[key] == expected[key], (key, row, expected)
    assert row["publicBodySha256"] == (expected["originalBodySha256"] if expected["publicationId"] else None)
canonical = json.dumps(rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"
(path / "readback.json").write_bytes(canonical)
(path / "readback.sha256").write_text(hashlib.sha256(canonical).hexdigest() + "\n")
PY
"${sql[@]}" -v before="$before" -v after_articles="$after_articles" -v after_comments="$after_comments" <<'SQL' > "$evidence/database-resources.json"
SELECT jsonb_build_object('articleWalBytes',pg_wal_lsn_diff(:'after_articles',:'before'),
    'commentWalBytes',pg_wal_lsn_diff(:'after_comments',:'after_articles'),
    'databaseBytes',pg_database_size(current_database()),'tempFileBytes',temp_bytes,'tempFiles',temp_files)
FROM pg_stat_database WHERE datname=current_database();
SQL
record_filesystem after-readback
printf 'Verified %s PostgreSQL fixture data and selected coordinates. HTTP/nightly acceptance is separate.\n' "$profile"
