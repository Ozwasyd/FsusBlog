#!/usr/bin/env bash
# Prepare and independently read back the selected C11 PostgreSQL fixture.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
repo=$PWD
if [[ ( $# != 2 && ( $# != 6 || ${3:-} != --http ) ) || ( ${1:-} != pilot && ${1:-} != nightly ) ]]; then
    printf 'Usage: %s {pilot|nightly} NEW_EVIDENCE_DIRECTORY [--http SERVER_DLL WEB_DIST PAYLOAD_MANIFEST]\n' "$0" >&2
    exit 2
fi
profile=$1
http_probe=false
if [[ $# == 6 ]]; then http_probe=true; fi
checkpoint_pilot=false
case "${FSUSBLOG_TEST_C11_CHECKPOINT_PILOT:-0}" in
    0) ;;
    1)
        [[ $profile == pilot && $http_probe == false ]] || {
            printf 'The checkpoint witness requires pilot without --http.\n' >&2; exit 2;
        }
        checkpoint_pilot=true
        ;;
    *) printf 'Set FSUSBLOG_TEST_C11_CHECKPOINT_PILOT to 0 or 1.\n' >&2; exit 2 ;;
esac
wide_browser=false
case "${FSUSBLOG_TEST_C11_WIDE_BROWSER:-0}" in
    0) ;;
    1)
        [[ $profile == nightly && $http_probe == true ]] || {
            printf 'The wide browser witness requires nightly with --http.\n' >&2; exit 2;
        }
        wide_browser=true
        ;;
    *) printf 'Set FSUSBLOG_TEST_C11_WIDE_BROWSER to 0 or 1.\n' >&2; exit 2 ;;
esac
list_taxonomy=false
case "${FSUSBLOG_TEST_C11_LIST_TAXONOMY:-0}" in
    0) ;;
    1)
        [[ $profile == nightly && $http_probe == true ]] || {
            printf 'The list/taxonomy witness requires nightly with --http.\n' >&2; exit 2;
        }
        list_taxonomy=true
        ;;
    *) printf 'Set FSUSBLOG_TEST_C11_LIST_TAXONOMY to 0 or 1.\n' >&2; exit 2 ;;
esac
comment_probe=false
case "${FSUSBLOG_TEST_C11_COMMENTS:-0}" in
    0) ;;
    1)
        [[ $profile == nightly && $http_probe == true ]] || {
            printf 'The comment witness requires nightly with --http.\n' >&2; exit 2;
        }
        comment_probe=true
        ;;
    *) printf 'Set FSUSBLOG_TEST_C11_COMMENTS to 0 or 1.\n' >&2; exit 2 ;;
esac
if [[ $profile == nightly ]]; then articles=100000 nightly=true; else articles=20 nightly=false; fi
if [[ -n ${PG_TOOLS_DIR:-} ]]; then export PATH="$PG_TOOLS_DIR:$PATH"; fi
dotnet=$(command -v "${DOTNET_BIN:-dotnet}")
if [[ $http_probe == true ]]; then
    dotnet=$(cd -- "$(dirname "$dotnet")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$dotnet")")
fi
migrate_dll=${FSUSBLOG_MIGRATE_DLL:-$repo/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}
test_dll=${FSUSBLOG_NIGHTLY_TEST_DLL:-$repo/tests/Integration/bin/Release/net10.0/FsusBlog.V2.Integration.Tests.dll}
artifacts=("$test_dll")
if [[ $http_probe == false ]]; then artifacts+=("$migrate_dll"); fi
for artifact in "${artifacts[@]}"; do
    [[ -f $artifact ]] || { printf 'Missing built fixture artifact %s\n' "$artifact" >&2; exit 2; }
done
for executable in initdb pg_ctl psql python3 git shasum; do command -v "$executable" >/dev/null; done
if [[ $http_probe == true ]]; then
    for executable in curl lsof node; do command -v "$executable" >/dev/null; done
fi
if [[ $wide_browser == true ]]; then
    command -v "${CADDY_BIN:?Set CADDY_BIN for the wide browser witness}" >/dev/null
    [[ ${FSUSBLOG_TEST_CHROME:-} == /* && -x $FSUSBLOG_TEST_CHROME ]]
fi
if [[ $comment_probe == true ]]; then
    pg_lib=$(pg_config --pkglibdir)
    [[ -r $pg_lib/auto_explain.dylib || -r $pg_lib/auto_explain.so ]] || {
        printf 'The comment witness requires the selected PostgreSQL auto_explain module.\n' >&2; exit 2;
    }
    node tests/Performance/nightly-comment-plans.mjs --self-test
fi

mkdir -- "$2"
evidence=$(cd -- "$2" && pwd -P)
scratch=$(mktemp -d /tmp/fsusv2-nightly.XXXXXXXX)
scratch=$(cd -- "$scratch" && pwd -P)
data_dir="$scratch/data"
pg_port=54936
stage=preparing
server_pid=
http_port=

own_http_child() {
    [[ -n "$server_pid" && "$(ps -o ppid= -p "$server_pid" 2>/dev/null | tr -d ' ')" == "$$" ]]
}

stop_http_server() {
    [[ -n "$server_pid" ]] || return 0
    local result=0 forced=no server_exit
    if own_http_child; then
        kill -TERM "$server_pid" || result=1
        for _ in {1..50}; do
            own_http_child || break
            sleep 0.1
        done
        if own_http_child; then
            kill -KILL "$server_pid" || result=1
            forced=yes
        fi
    fi
    if wait "$server_pid"; then server_exit=0; else server_exit=$?; result=1; fi
    if [[ -n "$http_port" ]] && lsof -n -P -iTCP@127.0.0.1:"$http_port" -sTCP:LISTEN > "$evidence/http-residual-listener.txt" 2>&1; then
        result=1
    fi
    printf 'server_exit=%s\nforced=%s\nserver_cleanup=%s\n' "$server_exit" "$forced" "$result" >> "$evidence/http-server.txt"
    server_pid=
    [[ "$forced" == no && "$result" == 0 ]]
}

cleanup() {
    local result=$? cleaned=yes
    trap - EXIT
    stop_http_server || cleaned=no
    if pg_ctl -D "$data_dir" status >/dev/null 2>&1; then
        pg_ctl -D "$data_dir" -m fast -w -t 20 stop >> "$evidence/postgres.log" 2>&1 || cleaned=no
    fi
    if pg_ctl -D "$data_dir" status >/dev/null 2>&1 || [[ -S "$scratch/socket/.s.PGSQL.$pg_port" ]]; then cleaned=no; fi
    if [[ $cleaned == yes ]]; then find "$scratch" -depth -delete || cleaned=no; fi
    if [[ $cleaned != yes ]]; then result=1; fi
    printf 'stop_stage=%s\nexit=%s\ncleanup=%s\nfinished=%s\n' "$stage" "$result" "$cleaned" "$(date -u +%FT%TZ)" >> "$evidence/run.txt"
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'printf "Nightly fixture preparation failed at line %s.\n" "$LINENO" >&2' ERR

stage_http_release() {
    python3 -B - "$1" "$2" "$3" "$scratch/release" "$source_commit" "$wide_browser" <<'PY'
import json
import os
import re
import runpy
import shutil
import sys
from pathlib import Path

server, web, manifest = [Path(value).resolve(strict=True) for value in sys.argv[1:4]]
stage = Path(sys.argv[4])
commit = sys.argv[5]
root = server.parent.parent
server_name = "server/FsusBlog.V2.Server.dll"
migrate_name = "migrate/FsusBlogV2.Migrate.dll"
if server != root / server_name or web != root / "web":
    raise SystemExit("Server and web must belong to one extracted release payload.")
verify = runpy.run_path("tools/verify-release.py")
stage.mkdir()
sealed_manifest = stage / "payload.sha256"
shutil.copyfile(manifest, sealed_manifest)
entries = verify["read_manifest"](sealed_manifest, "./")
trees = ("server", "migrate", "web")
metadata = {"release.txt"}
if sys.argv[6] == "true":
    metadata.add("Caddyfile")
expected = {name for name in entries if name.startswith(tuple(tree + "/" for tree in trees))}
expected.update(metadata)
required = {server_name, migrate_name, "web/index.html"} | metadata
if not required <= entries.keys():
    raise SystemExit("Payload manifest is missing a required server, migrate, web, or release entry.")
present = metadata.copy()
for tree in trees:
    directory = root / tree
    if directory.is_symlink() or not directory.is_dir():
        raise SystemExit(f"Expected a real release directory: {tree}")
    for parent, directories, files in os.walk(directory, followlinks=False):
        for leaf in directories + files:
            entry = Path(parent) / leaf
            if entry.is_symlink() or not (entry.is_file() or entry.is_dir()):
                raise SystemExit(f"Unexpected entry in release: {entry.relative_to(root)}")
        present.update((Path(parent) / name).relative_to(root).as_posix() for name in files)
if present != expected:
    raise SystemExit("Extracted server, migrate and web files differ from the release manifest.")
for name in sorted(expected):
    source = root / name
    if source.is_symlink() or not source.is_file():
        raise SystemExit(f"Expected a regular release file: {name}")
    copy = stage / name
    copy.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, copy)
    with copy.open("rb") as data:
        if verify["file_sha256"](data) != entries[name]:
            raise SystemExit(f"Extracted release checksum differs: {name}")
coordinates = {}
release = stage / "release.txt"
if release.stat().st_size > 4096:
    raise SystemExit("Release coordinates exceed the size limit.")
for line in release.read_text(encoding="ascii").splitlines():
    key, separator, value = line.partition("=")
    if not key or not separator or key in coordinates:
        raise SystemExit("Invalid release coordinate.")
    coordinates[key] = value
if (coordinates.get("fsusblog_commit") != commit or coordinates.get("server") != server_name
    or coordinates.get("migrate") != migrate_name or coordinates.get("web") != "web/"
    or not re.fullmatch(r"[0-9a-f]{40}", coordinates.get("fsusui_commit", ""))):
    raise SystemExit("The extracted release does not match the nightly source or expected layout.")
with sealed_manifest.open("rb") as data:
    manifest_digest = verify["file_sha256"](data)
print(json.dumps({"fsusblogCommit": commit, "fsusuiCommit": coordinates["fsusui_commit"],
                  "payloadManifestSha256": manifest_digest, "verifiedFiles": len(expected),
                  "serverSha256": entries[server_name], "migrateSha256": entries[migrate_name]}, sort_keys=True))
PY
}

mkdir "$scratch/socket"
run_id=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
db="fsusv2_nightly_$run_id"
due=$(python3 -c 'import time; print((int(time.time()) + 86400) * 1000)')
source_commit=$(git rev-parse HEAD)
{
    printf 'run_id=%s\nprofile=%s\nhttp_probe=%s\nlist_taxonomy=%s\nstarted=%s\ndue_unix_ms=%s\n' \
        "$run_id" "$profile" "$http_probe" "$list_taxonomy" "$(date -u +%FT%TZ)" "$due"
    if [[ $comment_probe == true ]]; then printf 'comment_probe=true\n'; fi
    printf '%s\n' "$source_commit"
    "$dotnet" --version
    psql --version
    uname -a
    df -k "$scratch"
} > "$evidence/run.txt"
if [[ $http_probe == true ]]; then
    stage=http-release-binding
    decoders=(src/Contracts/{aeds,binary,public-articles,wire.generated}.ts)
    if ! git diff --quiet "$source_commit" -- "${decoders[@]}" tools/verify-release.py; then
        printf 'HTTP decoders and release manifest reader must match the selected source commit.\n' >&2
        exit 1
    fi
    if [[ $list_taxonomy == true ]]; then
        list_inputs=(tests/Performance/nightly-list-taxonomy-{oracle.sql,probe.mjs})
        for input in "${list_inputs[@]}"; do
            git cat-file -e "$source_commit:$input" || {
                printf 'List/taxonomy inputs must exist in the selected source commit.\n' >&2; exit 1;
            }
        done
        if ! git diff --quiet "$source_commit" -- "${list_inputs[@]}"; then
            printf 'List/taxonomy inputs must match the selected source commit.\n' >&2; exit 1
        fi
        shasum -a 256 "${list_inputs[@]}" >> "$evidence/run.txt"
    fi
    if [[ $comment_probe == true ]]; then
        comment_inputs=(tests/Performance/nightly-comment-{oracle.sql,probe.mjs,plans.mjs}
            src/Contracts/{client,comment-read}.ts src/Server/{Store.cs,Comments/CommentReadStore.cs})
        for input in "${comment_inputs[@]}"; do
            git cat-file -e "$source_commit:$input" || {
                printf 'Comment witness inputs must exist in the selected source commit.\n' >&2; exit 1;
            }
        done
        if ! git diff --quiet "$source_commit" -- "${comment_inputs[@]}"; then
            printf 'Comment witness inputs must match the selected source commit.\n' >&2; exit 1;
        fi
        shasum -a 256 "${comment_inputs[@]}" >> "$evidence/run.txt"
    fi
    stage_http_release "$4" "$5" "$6" > "$evidence/http-release-binding.json" 2> "$evidence/http-release-binding.log"
    migrate_dll="$scratch/release/migrate/FsusBlogV2.Migrate.dll"
    shasum -a 256 "${decoders[@]}" tests/Performance/nightly-http-{oracle.sql,probe.mjs} >> "$evidence/run.txt"
    if [[ $wide_browser == true ]]; then
        shasum -a 256 "$scratch/release/Caddyfile" tests/Performance/proxy.sh \
            tests/Performance/nightly-wide-search-{oracle.sql,tls.sh,probe.mjs} >> "$evidence/run.txt"
    fi
fi
shasum -a 256 "$migrate_dll" "$test_dll" \
    tests/Performance/{seed.py,nightly-run.sh,nightly-plan.py,nightly-comments.sql,nightly-verify.sql,nightly-verify-article-bytes.py} >> "$evidence/run.txt"

phase() {
    local step=$1 started=$SECONDS
    stage=$step
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
stage=postgres-start
export LC_ALL=C PGHOST="$scratch/socket" PGPORT="$pg_port" PGUSER=fsusv2_nightly_qa
initdb -D "$data_dir" -U "$PGUSER" --auth-local=trust --auth-host=reject --locale=C -E UTF8 > "$evidence/init.log"
if [[ $comment_probe == true ]]; then
    mkdir "$evidence/comment-postgres"
    ln -s -- "$evidence/comment-postgres" "$data_dir/c11-comment-log"
    cat >> "$data_dir/postgresql.conf" <<'CONF'
shared_preload_libraries = 'auto_explain'
logging_collector = on
log_destination = 'jsonlog'
log_directory = 'c11-comment-log'
log_filename = 'comments'
log_file_mode = 0600
log_rotation_age = 0
log_rotation_size = 0
log_parameter_max_length = 0
log_parameter_max_length_on_error = 0
auto_explain.log_analyze = on
auto_explain.log_buffers = on
auto_explain.log_timing = off
auto_explain.log_format = 'json'
auto_explain.log_parameter_max_length = 128
auto_explain.sample_rate = 1
include = 'c11-comments.conf'
CONF
    printf "auto_explain.log_min_duration = -1\nlog_statement = 'none'\n" > "$data_dir/c11-comments.conf"
fi
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
article_input="$scratch/articles.tsv"
generate_options=("$profile" "$due" "$scratch")
if [[ $checkpoint_pilot == true ]]; then
    article_input="$scratch/plan.json"
    generate_options+=(--sharded)
fi
phase generate python3 -B tests/Performance/nightly-plan.py "${generate_options[@]}"
cp "$scratch/plan.json" "$evidence/plan.json"
record_filesystem before-articles

before=$("${sql[@]}" -c 'SELECT pg_current_wal_lsn()')
export FSUSBLOG_NIGHTLY_FIXTURE=1 FSUSBLOG_NIGHTLY_FIXTURE_DB="$FSUSBLOG_DB"
export FSUSBLOG_NIGHTLY_FIXTURE_SITE="$site" FSUSBLOG_NIGHTLY_FIXTURE_ARTICLES="$article_input"
export FSUSBLOG_NIGHTLY_FIXTURE_COUNT="$articles" FSUSBLOG_NIGHTLY_FIXTURE_DUE_UNIX_MS="$due"
export FSUSBLOG_NIGHTLY_FIXTURE_DATA_DIR="$data_dir"
unset FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_PILOT FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_PLAN_SHA256
unset FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_MANIFEST_SHA256
if [[ $checkpoint_pilot == true ]]; then
    checkpoint_plan_sha=$(python3 -B -c 'import json,sys; print(json.load(sys.stdin)["articlePlanSha256"])' < "$article_input")
    checkpoint_manifest_sha=$(shasum -a 256 -- "$article_input")
    checkpoint_manifest_sha=${checkpoint_manifest_sha%% *}
    [[ $checkpoint_plan_sha =~ ^[0-9a-f]{64}$ && $checkpoint_manifest_sha =~ ^[0-9a-f]{64}$ ]]
    export FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_PILOT=1 FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_PLAN_SHA256="$checkpoint_plan_sha"
    export FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_MANIFEST_SHA256="$checkpoint_manifest_sha"
    printf 'checkpoint_pilot=true\ncheckpoint_plan_sha256=%s\n' "$checkpoint_plan_sha" >> "$evidence/run.txt"
    printf 'checkpoint_manifest_sha256=%s\n' "$checkpoint_manifest_sha" >> "$evidence/run.txt"
fi
phase write-articles "$dotnet" vstest "$test_dll" '--TestCaseFilter:FullyQualifiedName~NightlyFixturePostgresTests.WritePlannedArticles' \
    '--logger:console;verbosity=detailed'
unset FSUSBLOG_NIGHTLY_FIXTURE FSUSBLOG_NIGHTLY_FIXTURE_DB FSUSBLOG_NIGHTLY_FIXTURE_SITE FSUSBLOG_NIGHTLY_FIXTURE_ARTICLES
unset FSUSBLOG_NIGHTLY_FIXTURE_COUNT FSUSBLOG_NIGHTLY_FIXTURE_DUE_UNIX_MS FSUSBLOG_NIGHTLY_FIXTURE_DATA_DIR
unset FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_PILOT FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_PLAN_SHA256
unset FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_MANIFEST_SHA256
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
phase verify-article-bytes python3 -B tests/Performance/nightly-verify-article-bytes.py \
    "$profile" "$article_input" "$evidence/plan.json" "$db" "$data_dir" "$site" "$evidence/article-bytes.json"
shasum -a 256 "$evidence/article-bytes.json" >> "$evidence/run.txt"
python3 - "$evidence" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
plan = json.loads((path / "plan.json").read_text())
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

if [[ $http_probe == true ]]; then
    stage=http-oracle-before
    read -r fixture_sha _ <<< "$(shasum -a 256 "$evidence/plan.json")"
    read -r readback_sha < "$evidence/readback.sha256"
    oracle=("${sql[@]}" -v database_name="$db" -v data_directory="$data_dir" -v site_id="$site"
        -v profile="$profile" -v due_unix_ms="$due" -v fixture_sha256="$fixture_sha" -v readback_sha256="$readback_sha")
    "${oracle[@]}" -f tests/Performance/nightly-http-oracle.sql > "$evidence/http-oracle.json" 2> "$evidence/http-oracle.log"
    if [[ $list_taxonomy == true ]]; then
        stage=http-list-taxonomy-oracle-before
        "${oracle[@]}" -f tests/Performance/nightly-list-taxonomy-oracle.sql \
            > "$evidence/list-taxonomy-oracle.ndjson" 2> "$evidence/list-taxonomy-oracle.log"
    fi
    if [[ $comment_probe == true ]]; then
        stage=http-comment-oracle-before
        "${oracle[@]}" -f tests/Performance/nightly-comment-oracle.sql \
            > "$evidence/comment-oracle.ndjson" 2> "$evidence/comment-oracle.log"
    fi

    stage=http-start
    mkdir "$scratch/http-cwd" "$evidence/http-responses"
    http_db=$FSUSBLOG_DB
    if [[ $comment_probe == true ]]; then http_db="$http_db;Application Name=fsus-c11-http-$run_id"; fi
    (
        cd -- "$scratch/http-cwd"
        exec env -i PATH="$PATH" LC_ALL=C TZ=UTC ASPNETCORE_ENVIRONMENT=Production \
            FSUSBLOG_DB="$http_db" FSUSBLOG_WEB_DIST="$scratch/release/web" \
            Logging__LogLevel__Microsoft=Warning Logging__LogLevel__Microsoft.Hosting.Lifetime=Information \
            "$dotnet" "$scratch/release/server/FsusBlog.V2.Server.dll" --urls http://127.0.0.1:0
    ) > "$evidence/http-server.log" 2>&1 &
    server_pid=$!
    read -r postgres_pid < "$data_dir/postmaster.pid"
    printf 'owner_pid=%s\npostgres_pid=%s\nserver_pid=%s\npostgres_socket=%s\nstarted=%s\n' \
        "$$" "$postgres_pid" "$server_pid" "$PGHOST/.s.PGSQL.$PGPORT" "$(date -u +%FT%TZ)" > "$evidence/http-server.txt"

    stage=http-ready
    finish=$((SECONDS + 120))
    ready=
    while (( SECONDS < finish )); do
        own_http_child || { printf 'Owned Kestrel exited before HTTP readiness.\n' >&2; exit 1; }
        port=$(sed -nE 's/.*Now listening on: http:\/\/127\.0\.0\.1:([0-9]{1,5})[[:space:]]*$/\1/p' "$evidence/http-server.log" | head -n 1)
        if [[ -n $port ]] && lsof -n -P -a -p "$server_pid" -iTCP@127.0.0.1:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
            http_port=$port
            origin="http://127.0.0.1:$port"
            ready=$(curl --disable --noproxy '*' --silent --max-time 2 -o /dev/null -w '%{http_code}' "$origin/health/ready") || ready=
            [[ $ready != 204 ]] || break
        fi
        sleep 0.2
    done
    [[ $ready == 204 ]] || { printf 'Owned Kestrel did not become ready within 120 seconds.\n' >&2; exit 1; }
    printf 'origin=%s\nreadiness=%s\nready_at=%s\n' "$origin" "$ready" "$(date -u +%FT%TZ)" >> "$evidence/http-server.txt"

    phase http-probe env -i PATH="$PATH" LC_ALL=C TZ=UTC node tests/Performance/nightly-http-probe.mjs \
        "$origin" "$evidence/http-oracle.json" "$evidence/plan.json" "$evidence/article-bytes.json" \
        "$evidence/http-actual.ndjson" "$evidence/http-responses"
    if [[ $list_taxonomy == true ]]; then
        phase http-list-taxonomy env -i PATH="$PATH" LC_ALL=C TZ=UTC node tests/Performance/nightly-list-taxonomy-probe.mjs "$evidence"
    fi
    if [[ $comment_probe == true ]]; then
        phase http-comment env -i PATH="$PATH" LC_ALL=C TZ=UTC node tests/Performance/nightly-comment-probe.mjs "$evidence"
    fi
    stage=http-stop
    stop_http_server
    if [[ $comment_probe == true ]]; then
        stage=http-comment-oracle-after
        "${oracle[@]}" -f tests/Performance/nightly-comment-oracle.sql \
            > "$evidence/comment-oracle-after.ndjson" 2> "$evidence/comment-oracle-after.log"
        cmp "$evidence"/comment-oracle{,-after}.ndjson
        shasum -a 256 "$evidence"/comment-oracle{,-after}.ndjson "$evidence/comments/actual.ndjson" \
            "$evidence"/comments/{sql-*.json,native-*.ndjson,*.aeds} > "$evidence/comment-proof.sha256"
    fi
    if [[ $list_taxonomy == true ]]; then
        stage=http-list-taxonomy-oracle-after
        "${oracle[@]}" -f tests/Performance/nightly-list-taxonomy-oracle.sql \
            > "$evidence/list-taxonomy-oracle-after.ndjson" 2> "$evidence/list-taxonomy-oracle-after.log"
        cmp "$evidence"/list-taxonomy-oracle{,-after}.ndjson
        shasum -a 256 "$evidence"/list-taxonomy-oracle{,-after}.ndjson "$evidence/http-actual.ndjson" \
            "$evidence/http-responses/001-article-list-first-page.aeds" \
            "$evidence/http-responses/002-article-list-continuation-page-2.aeds" \
            "$evidence/list-taxonomy/actual.ndjson" "$evidence"/list-taxonomy/*.aeds > "$evidence/list-taxonomy-proof.sha256"
    fi
    if [[ $wide_browser == true ]]; then
        stage=wide-browser-oracle
        "${oracle[@]}" -f tests/Performance/nightly-wide-search-oracle.sql > "$evidence/wide-search-oracle.json" 2> "$evidence/wide-search-oracle.log"
        mkdir "$evidence/wide-browser"
        phase wide-browser bash tests/Performance/nightly-wide-search-tls.sh \
            "$dotnet" "$scratch/release" "$scratch" "$evidence/wide-browser" "$evidence/wide-search-oracle.json"
    fi
    stage=http-oracle-after
    "${oracle[@]}" -f tests/Performance/nightly-http-oracle.sql > "$evidence/http-oracle-after.json" 2> "$evidence/http-oracle-after.log"
    cmp "$evidence/http-oracle.json" "$evidence/http-oracle-after.json"
    shasum -a 256 "$evidence"/http-oracle{,-after}.json "$evidence/plan.json" "$evidence/article-bytes.json" \
        "$evidence/http-actual.ndjson" > "$evidence/http-proof.sha256"
    printf 'Verified the selected same-database HTTP cases with the sealed PostgreSQL oracle.\n'
fi
stage=complete
