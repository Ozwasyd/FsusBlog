#!/usr/bin/env bash
# Local native PostgreSQL, one Kestrel process, and the client all belong to this attempt.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
repo=$PWD

mode=${1:-}
output_arg=${2:-}
if [[ $# != 2 || ( "$mode" != smoke && "$mode" != direct && "$mode" != soak && "$mode" != cold &&
    "$mode" != proxy-smoke && "$mode" != proxy && "$mode" != peak && "$mode" != proxy-peak &&
    "$mode" != supplier && "$mode" != proxy-supplier ) ]]; then
  echo 'Usage: tests/Performance/run.sh {smoke|direct|soak|cold|proxy-smoke|proxy|peak|proxy-peak|supplier|proxy-supplier} NEW_EVIDENCE_DIRECTORY' >&2
  exit 2
fi
proxy_mode=false
runtime_evidence=false
slow_requests=false
if [[ "$mode" == *peak ]]; then slow_requests=true; fi
if [[ "$mode" == soak || "$slow_requests" == true || ( "$mode" == *smoke && "${FSUSBLOG_PERF_RUNTIME:-}" == 1 ) ]]; then runtime_evidence=true; fi
shared_warmup=false
if [[ "$slow_requests" == true || "$mode" == *supplier || "${FSUSBLOG_PERF_REUSE_CONNECTIONS:-}" == 1 ]]; then
  if [[ "$mode" == cold || ( "$mode" == *smoke && "$runtime_evidence" != true ) || "${FSUSBLOG_PERF_PRECONNECT_TLS:-}" == 1 ]]; then
    echo 'Connection reuse requires a hot stage with its own warmup and no serial preconnection.' >&2
    exit 2
  fi
  shared_warmup=true
fi
caddy=${CADDY_BIN:-caddy}
if [[ "$mode" == proxy* ]]; then
  proxy_mode=true
  command -v "$caddy" >/dev/null || { echo "Missing local executable: $caddy" >&2; exit 2; }
fi
# shellcheck source=tests/Performance/proxy.sh
source tests/Performance/proxy.sh
# shellcheck source=tests/Performance/runtime.sh
source tests/Performance/runtime.sh
pg_dir=${PG_TOOLS_DIR:-}
if [[ -n "$pg_dir" ]]; then
  export PATH="$pg_dir:$PATH"
fi
dotnet=${DOTNET_BIN:-dotnet}
for executable in go python3 node openssl curl git psql initdb pg_ctl postgres shasum rsync lsof "$dotnet"; do
  command -v "$executable" >/dev/null || { echo "Missing local executable: $executable" >&2; exit 2; }
done
[[ -f src/Web/node_modules/vite/bin/vite.js ]] || { echo 'Restore the locked Web dependencies offline first.' >&2; exit 2; }
supplier_env=(env)
supplier_procs=${FSUSBLOG_PERF_SUPPLIER_PROCS:-}
if [[ -n "$supplier_procs" ]]; then
  [[ "$supplier_procs" =~ ^[1-9][0-9]?$ ]] || { printf '%s\n' 'Invalid load supplier processor count.' >&2; exit 2; }
  supplier_env+=("GOMAXPROCS=$supplier_procs")
fi
mkdir "$output_arg"
evidence=$(cd "$output_arg" && pwd -P)
run=$(mktemp -d /tmp/fsusv2-p.XXXXXXXX)
run_id=$(openssl rand -hex 16)
invocation_id=$(openssl rand -hex 16)
attempt_id=$(openssl rand -hex 16)
database="fsusv2_perf_$run_id"
pg_port=5432
server_pid=
proxy_pid=
sampler_pid=
load_pid=
origin=
target=
proxy_ca=
curl_flags=(--http1.1)
load_flags=()
started=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
stage=preparing
export PGHOST="$run" PGPORT="$pg_port" PGUSER=perf PGDATABASE=postgres PGCONNECT_TIMEOUT=2
export PGSERVICEFILE="$run/service.conf" PGPASSFILE="$run/password.conf"
unset PGSERVICE PGPASSWORD PGOPTIONS PGHOSTADDR
export FSUSBLOG_DB="Host=$run;Port=$pg_port;Database=$database;Username=perf;Pooling=true"
export GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off

own_child() {
  [[ -n "$1" && "$(ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ')" == "$$" ]]
}

cleanup() {
  local status=$? clean=yes server_exit=not-started
  trap - EXIT INT TERM
  set +e
  if own_child "$load_pid"; then
    kill -TERM "$load_pid"
    wait "$load_pid" 2>/dev/null
  fi
  if own_child "$sampler_pid"; then
    kill -TERM "$sampler_pid"
    wait "$sampler_pid" 2>/dev/null
  fi
  if own_child "$proxy_pid"; then
    kill -TERM "$proxy_pid"
    for _ in {1..50}; do
      own_child "$proxy_pid" || break
      sleep 0.1
    done
    if own_child "$proxy_pid"; then
      kill -KILL "$proxy_pid"
      clean=forced
    fi
    wait "$proxy_pid" 2>/dev/null
  fi
  if own_child "$server_pid"; then
    kill -TERM "$server_pid"
    for _ in {1..50}; do
      own_child "$server_pid" || break
      sleep 0.1
    done
    if own_child "$server_pid"; then
      kill -KILL "$server_pid"
      clean=forced
    fi
  fi
  if [[ -n "$server_pid" ]]; then
    wait "$server_pid" 2>/dev/null
    server_exit=$?
    if [[ "$server_exit" != 0 && "$status" == 0 ]]; then status=1; fi
  fi
  if [[ -e "$run/pg/postmaster.pid" ]]; then
    pg_ctl -w -t 15 -D "$run/pg" stop -m fast > "$evidence/postgres-stop.log" 2>&1 || clean=no
  fi
  if [[ -e "$run/pg/postmaster.pid" || -S "$run/.s.PGSQL.$pg_port" ]]; then
    clean=no
  fi
  if [[ -n "$origin" ]]; then
    local port=${origin##*:}
    if lsof -n -P -iTCP@127.0.0.1:"$port" -sTCP:LISTEN > "$evidence/residual-listener.txt" 2>&1; then
      clean=no
    fi
  fi
  if [[ -n "$proxy_pid" ]]; then
    local port=${target##*:}
    if lsof -n -P -iTCP@127.0.0.1:"$port" -sTCP:LISTEN > "$evidence/residual-proxy-listener.txt" 2>&1; then
      clean=no
    fi
  fi
  if [[ "$clean" != no ]]; then
    rm -rf -- "$run" || clean=no
    [[ ! -e "$run" ]] || clean=no
  fi
  if [[ "$clean" != yes && "$status" == 0 ]]; then status=1; fi
  {
    echo "started_at=$started"
    echo "finished_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    echo "run_id=$run_id"
    echo "invocation_id=$invocation_id"
    echo "attempt_id=$attempt_id"
    echo "owner_pid=$$"
    echo "server_pid=$server_pid"
    echo "server_exit_code=$server_exit"
    echo "origin=$origin"
    echo "proxy_pid=$proxy_pid"
    echo "target=$target"
    echo "database=$database"
    echo "scratch=$run"
    echo "exit_code=$status"
    echo "last_stage=$stage"
    echo "cleanup=$clean"
  } > "$evidence/outcome.txt"
  printf 'P2 native %s: %s, exit=%d, cleanup=%s\n' "$mode" "$evidence" "$status" "$clean" >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Capture the exact files used by the build, including tracked changes and new candidate code.
source_hash() {
  git ls-files -c -o --exclude-standard -z -- src tests/Performance tests/Fixtures/publication-rights.sql deploy 'Directory.Build.*' NuGet.Config global.json | python3 -c '
import hashlib, os, sys
from pathlib import Path
h = hashlib.sha256()
for path in sorted(set(sys.stdin.buffer.read().split(b"\0")) - {b""}):
    item = Path(os.fsdecode(path))
    if item.is_symlink():
        digest = hashlib.sha256(os.fsencode(os.readlink(item))).digest()
    elif item.is_file():
        digest = hashlib.sha256(item.read_bytes()).digest()
    else:
        digest = b"absent"
    h.update(path + b"\0" + digest + b"\0")
print(h.hexdigest())'
}
commit=$(git rev-parse HEAD)
candidate=$(source_hash)
ui_pkg="$repo/src/Web/node_modules/@ozwasyd/element-plus"
ui_package=$(node -p "const p = require('$ui_pkg/package.json'); p.name + '@' + p.version")
{
  printf 'command=tests/Performance/run.sh %q %q\n' "$mode" "$output_arg"
  printf 'shared_warmup=%s\n' "$shared_warmup"
  printf 'commit=%s\nsource_sha256=%s\n' "$commit" "$candidate"
  printf 'fsusui_package=%s\n' "$ui_package"
  uname -srm
  if command -v sw_vers >/dev/null; then
    sw_vers
    sysctl hw.model hw.physicalcpu hw.logicalcpu hw.memsize machdep.cpu.brand_string || true
    pmset -g batt || true
  fi
  "$dotnet" --info
  node --version
  go version
  postgres --version
  printf 'dotnet_gc_conserve_memory=%s\n' "${DOTNET_GCConserveMemory:-unset}"
  printf 'dotnet_gc_heap_hard_limit=%s\n' "${DOTNET_GCHeapHardLimit:-unset}"
  printf 'supplier_gomaxprocs=%s\n' "${supplier_procs:-${GOMAXPROCS:-runtime-default}}"
  if [[ "$proxy_mode" == true ]]; then
    "$caddy" version
    printf 'topology=Caddy TLS -> Kestrel HTTP/1.1 loopback, native PostgreSQL over private Unix socket, same-host load client\n'
  else
    printf 'topology=Kestrel HTTP/1.1 loopback, native PostgreSQL over private Unix socket, same-host load client\n'
  fi
} > "$evidence/environment.txt"
git status --short > "$evidence/source-status.txt"
git ls-files -c -o --exclude-standard -z -- '*lock.json' '*lock.yaml' 'global.json' 'NuGet.Config' |
  xargs -0 shasum -a 256 > "$evidence/locks.sha256"
ui_inputs() {
  (
    cd "$ui_pkg"
    shasum -a 256 package.json es/wasm/dist/{ep_wasm.mjs,ep_wasm.wasm,markdown_basic.js,markdown_basic.wasm,markdown_simd.js,markdown_simd.wasm}
  )
}
ui_inputs > "$evidence/fsusui-inputs.sha256"

stage=build
mkdir -p "$run/source/src" "$run/source/tests/Performance" "$run/source/tests/Fixtures" "$run/source/deploy"
rsync -a --exclude bin --exclude obj --exclude dist --exclude node_modules --exclude .DS_Store src/ "$run/source/src/"
cp Directory.Build.* NuGet.Config global.json "$run/source/"
cp tests/Performance/{seed.py,load.go,cold.go,proxy-boundary.mjs,proxy.sh,runtime.py,runtime.sh} "$run/source/tests/Performance/"
cp tests/Fixtures/publication-rights.sql "$run/source/tests/Fixtures/"
cp deploy/Caddyfile "$run/source/deploy/"
shasum -a 256 "$run/source/deploy/Caddyfile" > "$evidence/caddyfile.sha256"
ln -s "$repo/src/Web/node_modules" "$run/source/src/Web/node_modules"
[[ "$(source_hash)" == "$candidate" && "$(git rev-parse HEAD)" == "$commit" ]] || { echo 'Candidate changed while copying inputs.' >&2; exit 1; }
{
  cd "$run/source"
  "$dotnet" restore src/Server/FsusBlog.V2.Server.csproj --locked-mode
  "$dotnet" restore src/Cli/FsusBlog.V2.Cli.csproj --locked-mode
  "$dotnet" build src/Server/FsusBlog.V2.Server.csproj -c Release --no-restore --output "$run/server"
  "$dotnet" build src/Cli/FsusBlog.V2.Cli.csproj -c Release --no-restore --output "$run/migrate"
  (cd src/Web && node node_modules/vite/bin/vite.js build --outDir "$run/web")
  go build -trimpath -o "$run/load" tests/Performance/{load,cold}.go
  cd "$repo"
} > "$evidence/build.log" 2>&1
ui_inputs | cmp -s "$evidence/fsusui-inputs.sha256" - || { echo 'FsusUI package artifacts changed during build.' >&2; exit 1; }
(cd "$run" && find server migrate web load -type f -print0 | xargs -0 shasum -a 256 | LC_ALL=C sort -k2) > "$evidence/build.sha256"

stage=database
admin_schema=$(sed -nE 's/^    internal const int AdminIdentityVersion = ([1-9][0-9]*);$/\1/p' \
  "$run/source/src/Storage/AdminIdentitySchema.cs")
[[ "$admin_schema" =~ ^[1-9][0-9]*$ ]] || { echo 'Expected an exact administrator schema revision in the frozen source.' >&2; exit 1; }
{
  initdb -D "$run/pg" --username perf --auth-local=trust --auth-host=reject --locale=C --encoding=UTF8 --no-sync
  pg_ctl -D "$run/pg" -l "$evidence/postgres.log" -w -t 20 start \
    -o "-c listen_addresses='' -c unix_socket_directories=$run -c unix_socket_permissions=0700 -p $pg_port"
  psql -X -w -v ON_ERROR_STOP=1 -c "CREATE DATABASE $database TEMPLATE template0"
  "$dotnet" "$run/migrate/FsusBlog.V2.Cli.dll" plan > "$evidence/migration-plan.json"
  "$dotnet" "$run/migrate/FsusBlog.V2.Cli.dll" apply "$evidence/migration-plan.json"
  python3 "$run/source/tests/Performance/seed.py" --database "$database" --admin-schema "$admin_schema" \
    --sql "$run/seed.sql" --manifest "$evidence/fixture.json"
  shasum -a 256 "$run/seed.sql" "$evidence/fixture.json" > "$evidence/fixture.sha256"
  psql -X -w -v ON_ERROR_STOP=1 -d "$database" -f "$run/seed.sql"
  psql -X -w -v ON_ERROR_STOP=1 -d "$database" -f "$run/source/tests/Fixtures/publication-rights.sql"
  shasum -a 256 "$run/source/tests/Fixtures/publication-rights.sql" > "$evidence/fixture-rights.sha256"
  "$dotnet" "$run/migrate/FsusBlog.V2.Cli.dll" verify
  psql -X -w -v ON_ERROR_STOP=1 -d "$database" -c 'SELECT current_database(),current_setting('"'"'server_version'"'"'),pg_backend_pid(),count(*) FROM public.article_publication'
} > "$evidence/database.log" 2>&1

stage=startup
server="$run/server/FsusBlog.V2.Server.dll"
cache_level=Information
if [[ "$mode" == cold ]]; then cache_level=Debug; fi
runtime_env=(FSUSBLOG_RUNTIME_EVIDENCE_CONTROL= FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT=)
if [[ "$runtime_evidence" == true ]]; then
  runtime_env=("FSUSBLOG_RUNTIME_EVIDENCE_CONTROL=$run" "FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT=$evidence/runtime.ndjson")
fi
runtime_env+=("FSUSBLOG_RUNTIME_SLOW_REQUESTS=$slow_requests")
unset FSUSBLOG_PASSKEY_ORIGIN FSUSBLOG_PASSKEY_RP_ID
if [[ "$proxy_mode" == true ]]; then
  target="https://127.0.0.1:$(choose_loopback_port)"
  export FSUSBLOG_PASSKEY_ORIGIN=$target FSUSBLOG_PASSKEY_RP_ID=127.0.0.1
fi
env FSUSBLOG_WEB_DIST="$run/web" ASPNETCORE_ENVIRONMENT=Production ASPNETCORE_URLS= \
  FSUSBLOG_TRUST_LOOPBACK_PROXY="$proxy_mode" \
  "${runtime_env[@]}" \
  Logging__LogLevel__Microsoft=Warning 'Logging__LogLevel__Microsoft.Hosting.Lifetime=Information' \
  "Logging__LogLevel__FsusBlog.V2.Server.Publications=$cache_level" \
  "$dotnet" "$server" --urls http://127.0.0.1:0 > "$evidence/server.log" 2>&1 &
server_pid=$!
for _ in {1..150}; do
  own_child "$server_pid" || { echo 'Owned Kestrel exited before readiness.' >&2; exit 1; }
  url=$(sed -nE 's/.*Now listening on: (http:\/\/127\.0\.0\.1:[0-9]+).*/\1/p' "$evidence/server.log" | head -n1)
  if [[ -n "$url" ]] && lsof -n -P -a -p "$server_pid" -iTCP@127.0.0.1:"${url##*:}" -sTCP:LISTEN >/dev/null; then
    origin=$url
    break
  fi
  sleep 0.2
done
[[ -n "$origin" ]] || { echo 'Owned Kestrel did not become ready.' >&2; exit 1; }
if [[ "$proxy_mode" == true ]]; then
  stage=proxy-startup
  start_proxy
  stage=proxy-boundary
  "$dotnet" "$run/migrate/FsusBlog.V2.Cli.dll" operator proxy-check |
    node "$run/source/tests/Performance/proxy-boundary.mjs" "$target" "$origin" "$proxy_ca" \
      > "$evidence/proxy-boundary.log" 2>&1
else
  target=$origin
fi
[[ "$(readiness)" == 204 ]]
read -r postgres_pid < "$run/pg/postmaster.pid"
{
  printf 'owner_pid=%s\npostgres_pid=%s\nserver_pid=%s\norigin=%s\n' "$$" "$postgres_pid" "$server_pid" "$origin"
  printf 'run_id=%s\ninvocation_id=%s\nattempt_id=%s\ndatabase=%s\n' "$run_id" "$invocation_id" "$attempt_id" "$database"
  printf 'socket=%s\nready_at=%s\n' "$run/.s.PGSQL.$pg_port" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  ps -o pid=,ppid=,lstart=,command= -p "$$,$postgres_pid,$server_pid"
  if [[ -n "$proxy_pid" ]]; then
    printf 'proxy_pid=%s\ntarget=%s\n' "$proxy_pid" "$target"
    ps -o pid=,ppid=,lstart=,command= -p "$proxy_pid"
  fi
  echo 'readiness=204'
} > "$evidence/owner.txt"

(
  printf 'utc,pid,rss_kib,pcpu\n'
  if [[ -n "$proxy_pid" ]]; then printf 'utc,pid,rss_kib,pcpu\n' > "$evidence/proxy-process.csv"; fi
  while kill -0 "$server_pid" 2>/dev/null; do
    ps -o pid=,rss=,%cpu= -p "$server_pid" | awk -v date="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" '{ print date "," $1 "," $2 "," $3 }'
    if [[ -n "$proxy_pid" ]]; then
      ps -o pid=,rss=,%cpu= -p "$proxy_pid" | awk -v date="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" '{ print date "," $1 "," $2 "," $3 }' >> "$evidence/proxy-process.csv"
    fi
    sleep 5
  done
) > "$evidence/server-process.csv" &
sampler_pid=$!

run_load() {
  printf '%q ' "${supplier_env[@]}" load "$@" >> "$evidence/commands.txt"
  printf '\n' >> "$evidence/commands.txt"
  "${supplier_env[@]}" "$run/load" "$@" > "$evidence/$stage.log" 2>&1 &
  load_pid=$!
  wait "$load_pid"
  load_pid=
}

measure() {
  stage=$1
  local rate=$2 seconds=$3 warm_seconds=${4:-0}
  own_child "$server_pid"
  if [[ -n "$proxy_pid" ]]; then own_child "$proxy_pid"; fi
  pg_ctl -D "$run/pg" status >> "$evidence/owner.txt"
  [[ "$(readiness)" == 204 ]]
  printf '%s: %s requests/s for %s seconds\n' "$stage" "$rate" "$seconds" >&2
  local args=(-target "$target" -fixture "$evidence/fixture.json" -wire "$run/source/src/Contracts/wire.schema.json"
    -rate "$rate" -seconds "$seconds" -out "$evidence/$stage.json")
  args+=("${load_flags[@]+"${load_flags[@]}"}")
  if ((warm_seconds != 0)); then args+=(-shared-warmup-seconds "$warm_seconds"); fi
  if [[ "$runtime_evidence" == true && "$stage" != warmup-* ]]; then args+=(-runtime-control "$run"); fi
  if [[ "$slow_requests" == true ]]; then args+=(-slow-requests); fi
  run_load "${args[@]}"
  if [[ "$runtime_evidence" == true && "$stage" != warmup-* ]]; then runtime_report "$stage"; fi
}

measure_with_warmup() {
  local name=$1 rate=$2 seconds=$3 warmup_name=$4 warmup_seconds=$5
  if [[ "$shared_warmup" == true ]]; then
    measure "$name" "$rate" "$seconds" "$warmup_seconds"
  else
    measure "$warmup_name" 2000 "$warmup_seconds"
    measure "$name" "$rate" "$seconds"
  fi
}

if [[ "$runtime_evidence" == true ]]; then
  stage=runtime-positive-control
  runtime_positive_control
fi
case "$mode" in
  smoke|proxy-smoke)
    if [[ "$runtime_evidence" == true ]]; then
      measure_with_warmup "$mode" 2000 10 warmup-runtime-smoke 3
    else
      measure "$mode" 100 3
    fi
    ;;
  cold)
    stage=cold
    own_child "$server_pid"
    pg_ctl -D "$run/pg" status >> "$evidence/owner.txt"
    cold_args=(-target "$origin" -fixture "$evidence/fixture.json" -wire "$run/source/src/Contracts/wire.schema.json"
      -cold-log "$evidence/server.log" -out "$evidence/cold.json")
    if [[ "${FSUSBLOG_PERF_COLD_PRESSURE:-}" == 1 ]]; then cold_args+=(-cold-pressure); fi
    run_load "${cold_args[@]}"
    ;;
  direct|proxy)
    first=1
    for rate in 2000 5000 8000 10500; do
      if ((first)); then first=0; else sleep 15; fi
      measure_with_warmup "$mode-$rate" "$rate" 60 "warmup-$rate" 30
    done
    ;;
  peak|proxy-peak)
    measure "$mode-10500" 10500 60 30
    ;;
  supplier|proxy-supplier)
    measure "$mode-11000" 11000 60 30
    ;;
  soak)
    measure_with_warmup direct-soak 8000 900 warmup-soak 30
    ;;
esac
stage=finished
