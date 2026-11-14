#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"
export PG_TOOLS_DIR=${PG_TOOLS_DIR:-/opt/homebrew/opt/postgresql@18/bin}
export FSUSBLOG_TEST_CHROME=${FSUSBLOG_TEST_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
export FSUSBLOG_TEST_REQUIRE_NATIVE=${FSUSBLOG_TEST_REQUIRE_NATIVE:-1}
for command in initdb pg_ctl psql; do
  [[ -x "$PG_TOOLS_DIR/$command" ]] || { printf 'Missing %s\n' "$PG_TOOLS_DIR/$command" >&2; exit 1; }
done

scratch=$(mktemp -d /tmp/fsusv2-e2e.XXXXXX)
evidence=${FSUSBLOG_TEST_EVIDENCE:-$repo/artifacts/native-e2e-$(basename "$scratch")}
mkdir -p "$evidence" "$scratch/socket"
evidence=$(cd -- "$evidence" && pwd)
export FSUSBLOG_TEST_EVIDENCE="$evidence"
server_pid=
pg_started=0
cleanup() {
  local code=$? cleanup_ok=1
  trap - EXIT
  if [[ -n "$server_pid" ]]; then
    if kill -0 "$server_pid" 2>/dev/null; then kill "$server_pid"; fi
    wait "$server_pid" 2>/dev/null || true
    if kill -0 "$server_pid" 2>/dev/null; then cleanup_ok=0; fi
  fi
  if (( pg_started )); then
    if ! "$PG_TOOLS_DIR/pg_ctl" -D "$scratch/data" -m fast -w stop >> "$evidence/postgres.log" 2>&1; then
      cleanup_ok=0
    fi
    if "$PG_TOOLS_DIR/pg_ctl" -D "$scratch/data" status >/dev/null 2>&1; then cleanup_ok=0; fi
  fi
  if (( cleanup_ok )); then rm -rf -- "$scratch" || cleanup_ok=0; fi
  if (( ! cleanup_ok && code == 0 )); then code=1; fi
  {
    printf 'ended=%s\n' "$(date -u +%FT%TZ)"
    printf 'exit=%s\ncleanup=%s\n' "$code" "$cleanup_ok"
  } >> "$evidence/run.txt"
  printf 'Evidence: %s\n' "$evidence"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

server_source=${FSUSBLOG_NATIVE_SERVER_BUILD:-$repo/src/Server/bin/Release/net10.0}
migrate_source=${FSUSBLOG_NATIVE_MIGRATE_BUILD:-$repo/src/Migrate/bin/Release/net10.0}
web_source=${FSUSBLOG_WEB_DIST:-$repo/src/Web/dist}
mkdir -p "$scratch/server" "$scratch/migrate" "$scratch/web"
cp -R "$server_source/." "$scratch/server"
cp -R "$migrate_source/." "$scratch/migrate"
cp -R "$web_source/." "$scratch/web"
export FSUSBLOG_WEB_DIST="$scratch/web"

{
  printf 'started=%s\n' "$(date -u +%FT%TZ)"
  git rev-parse HEAD
  git status --porcelain
  dotnet --version
  node --version
  "$PG_TOOLS_DIR/postgres" --version
  shasum -a 256 src/Web/pnpm-lock.yaml src/Server/packages.lock.json
  (cd "$scratch" && shasum -a 256 web/index.html server/FsusBlog.V2.Server.dll migrate/FsusBlogV2.Migrate.dll)
} > "$evidence/run.txt"

"$PG_TOOLS_DIR/initdb" -D "$scratch/data" -U fsusqa --auth-local=trust --auth-host=reject --locale=C -E UTF8 > "$evidence/initdb.log"
pg_started=1
"$PG_TOOLS_DIR/pg_ctl" -D "$scratch/data" -l "$evidence/postgres.log" \
  -o "-c listen_addresses='' -k $scratch/socket -p 54930 -c unix_socket_permissions=0700" -w start
export FSUSBLOG_DB="Host=$scratch/socket;Port=54930;Username=fsusqa;Database=postgres;SSL Mode=Disable"

migrate=(dotnet "$scratch/migrate/FsusBlogV2.Migrate.dll")
"${migrate[@]}" plan > "$evidence/schema-plan.json"
"${migrate[@]}" apply "$evidence/schema-plan.json" > "$evidence/schema.log"
"${migrate[@]}" verify >> "$evidence/schema.log"
FSUSBLOG_TEST_TICKET=$("${migrate[@]}" operator browser-author)
export FSUSBLOG_TEST_TICKET
if [[ ${FSUSBLOG_TEST_PUBLIC_FIXTURE:-1} == 1 ]]; then
  "$PG_TOOLS_DIR/psql" -X -v ON_ERROR_STOP=1 -h "$scratch/socket" -p 54930 -U fsusqa -d postgres \
    -f tests/EndToEnd/public-fixture.sql > "$evidence/public-fixture.log"
  shasum -a 256 tests/EndToEnd/public-fixture.sql >> "$evidence/run.txt"
  export FSUSBLOG_TEST_PUBLIC_FIXTURE=1
fi

dotnet "$scratch/server/FsusBlog.V2.Server.dll" --urls http://127.0.0.1:0 > "$evidence/server.log" 2>&1 &
server_pid=$!
url=
for (( attempt=0; attempt<100; attempt++ )); do
  url=$(sed -nE 's/^[[:space:]]*Now listening on: (http:\/\/127\.0\.0\.1:[0-9]+)$/\1/p' "$evidence/server.log")
  if [[ -n "$url" ]] && curl --silent --fail "$url/health/ready" >/dev/null; then break; fi
  kill -0 "$server_pid"
  sleep 0.2
done
[[ -n "$url" ]] && curl --silent --fail "$url/health/ready" >/dev/null
export FSUSBLOG_TEST_URL="$url"
node tests/EndToEnd/blog-flow.mjs
