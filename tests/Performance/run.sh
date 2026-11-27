#!/usr/bin/env bash
# Local native PostgreSQL, one Kestrel process, and the client all belong to this attempt.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
repo=$PWD

mode=${1:-}
output_arg=${2:-}
launch_rate=
case "$mode" in
  launch-direct|proxy-launch|proxy-launch-soak)
    if [[ $# != 3 || ! "${3:-}" =~ ^[1-9][0-9]{0,3}0$ ]] || (( $3 > 11000 )); then
      echo 'Launch modes require NEW_EVIDENCE_DIRECTORY and a QPS multiple of 10 in 10..11000.' >&2
      exit 2
    fi
    launch_rate=$3
    ;;
  smoke|direct|soak|cold|proxy-smoke|proxy|peak|proxy-peak|supplier|proxy-supplier)
    [[ $# == 2 ]] || { echo 'Legacy modes require NEW_EVIDENCE_DIRECTORY only.' >&2; exit 2; }
    ;;
  *)
    echo 'Usage: tests/Performance/run.sh {smoke|direct|soak|cold|proxy-smoke|proxy|peak|proxy-peak|supplier|proxy-supplier|launch-direct|proxy-launch|proxy-launch-soak} NEW_EVIDENCE_DIRECTORY [QPS]' >&2
    exit 2
    ;;
esac
release=${FSUSBLOG_PERF_RELEASE:-}
if [[ -n "$release" ]]; then
  [[ -n "$launch_rate" && "$release" = /* && -d "$release" && -z "$(git status --porcelain)" ]] || {
    echo 'A sealed release requires a launch mode, an absolute release directory, and a clean checkout.' >&2
    exit 2
  }
fi
proxy_mode=false
runtime_evidence=false
slow_requests=false
if [[ "$mode" == *peak ]]; then slow_requests=true; fi
if [[ "$mode" == soak || "$mode" == proxy-launch-soak || "$slow_requests" == true || ( "$mode" == *smoke && "${FSUSBLOG_PERF_RUNTIME:-}" == 1 ) ]]; then runtime_evidence=true; fi
shared_warmup=false
if [[ -n "$launch_rate" && "${FSUSBLOG_PERF_REUSE_CONNECTIONS:-}" == 1 ]]; then
  echo 'Launch modes use a separate warmup at the requested rate.' >&2
  exit 2
fi
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
  [[ ${FSUSBLOG_TEST_CHROME:-} = /* && -x $FSUSBLOG_TEST_CHROME ]] || {
    echo 'Set FSUSBLOG_TEST_CHROME to an absolute Chromium executable for the TLS Passkey check.' >&2
    exit 2
  }
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

stop_graceful() {
  local rc=0
  terminate_child "$1" || rc=$?
  [[ $rc != 2 ]] || clean=forced
}

cleanup() {
  local status=$? clean=yes server_exit=not-started pid
  trap - EXIT INT TERM
  set +e
  for pid in "$load_pid" "$sampler_pid"; do
    own_child "$pid" && { kill -TERM "$pid"; wait "$pid" 2>/dev/null; }
  done
  stop_graceful "$proxy_pid"
  [[ -z "$proxy_pid" ]] || wait "$proxy_pid" 2>/dev/null
  stop_graceful "$server_pid"
  if [[ -n "$server_pid" ]]; then
    wait "$server_pid" 2>/dev/null
    server_exit=$?
    [[ "$server_exit" == 0 || "$status" != 0 ]] || status=1
  fi
  if [[ -e "$run/pg/postmaster.pid" ]]; then
    pg_ctl -w -t 15 -D "$run/pg" stop -m fast > "$evidence/postgres-stop.log" 2>&1 || clean=no
  fi
  [[ ! -e "$run/pg/postmaster.pid" && ! -S "$run/.s.PGSQL.$pg_port" ]] || clean=no
  check_residual() {
    [[ -n "$1" ]] && lsof -n -P -iTCP@127.0.0.1:"${1##*:}" -sTCP:LISTEN > "$evidence/$2" 2>&1 && clean=no
  }
  check_residual "$origin" residual-listener.txt
  [[ -z "$proxy_pid" ]] || check_residual "$target" residual-proxy-listener.txt
  if [[ "$clean" != no ]]; then
    rm -rf -- "$run" && [[ ! -e "$run" ]] || clean=no
  fi
  [[ "$clean" == yes || "$status" != 0 ]] || status=1
  printf '%s\n' \
    "started_at=$started" "finished_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    "run_id=$run_id" "invocation_id=$invocation_id" "attempt_id=$attempt_id" \
    "owner_pid=$$" "server_pid=$server_pid" "server_exit_code=$server_exit" \
    "origin=$origin" "proxy_pid=$proxy_pid" "target=$target" "database=$database" \
    "scratch=$run" "exit_code=$status" "last_stage=$stage" "cleanup=$clean" > "$evidence/outcome.txt"
  printf 'P2 native %s: %s, exit=%d, cleanup=%s\n' "$mode" "$evidence" "$status" "$clean" >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Capture the exact files used by the build, including tracked changes and new candidate code.
source_hash() {
  git ls-files -c -o --exclude-standard -z -- src tests/Performance tests/EndToEnd tests/Fixtures/publication-rights.sql deploy 'Directory.Build.*' NuGet.Config global.json | python3 -c '
import hashlib, os, sys
from pathlib import Path
h = hashlib.sha256()
for path in sorted(set(sys.stdin.buffer.read().split(b"\0")) - {b""}):
    item = Path(os.fsdecode(path))
    data = os.fsencode(os.readlink(item)) if item.is_symlink() else item.read_bytes() if item.is_file() else None
    h.update(path + b"\0" + (b"absent" if data is None else hashlib.sha256(data).digest()) + b"\0")
print(h.hexdigest())'
}
commit=$(git rev-parse HEAD)
candidate=$(source_hash)
ui_pkg="$repo/src/Web/node_modules/@ozwasyd/element-plus"
ui_package=$(node -p "const p = require('$ui_pkg/package.json'); p.name + '@' + p.version")
{
  printf 'command=tests/Performance/run.sh %q %q' "$mode" "$output_arg"
  if [[ -n "$launch_rate" ]]; then printf ' %q' "$launch_rate"; fi
  printf '\n'
  if [[ -n "$launch_rate" ]]; then
    printf 'launch_mode=%s\nlaunch_rate=%s\n' "$mode" "$launch_rate"
    if [[ -r /proc/meminfo ]]; then
      getconf _NPROCESSORS_ONLN
      grep '^MemTotal:' /proc/meminfo
    fi
  fi
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
if [[ "$proxy_mode" == true ]]; then
  mkdir "$run/source/tests/EndToEnd"
  cp tests/EndToEnd/{isolated-browser-fixture,response-status-fixture,response-wait-fixture,role-locators,web-package-fixture,webauthn-fixture}.mjs \
    "$run/source/tests/EndToEnd/"
fi
if [[ -n "$launch_rate" ]]; then
  cp tests/Performance/{launch_gate.py,capacity.py} "$run/source/tests/Performance/"
fi
cp tests/Fixtures/publication-rights.sql "$run/source/tests/Fixtures/"
cp deploy/Caddyfile "$run/source/deploy/"
shasum -a 256 "$run/source/deploy/Caddyfile" > "$evidence/caddyfile.sha256"
ln -s "$repo/src/Web/node_modules" "$run/source/src/Web/node_modules"
[[ "$(source_hash)" == "$candidate" && "$(git rev-parse HEAD)" == "$commit" ]] || { echo 'Candidate changed while copying inputs.' >&2; exit 1; }
{
  cd "$run/source"
  if [[ -n "$release" ]]; then
    mkdir "$run/sealed"
    cp -- "$release"/{SHA256SUMS,payload.sha256,fsusui-wasm.sha256,fsusblog-v2.tar.gz,history.bundle} "$run/sealed/"
    python3 -B "$repo/tools/verify-release.py" "$run/sealed" > "$evidence/release-verification.json"
    (cd "$run/sealed" && shasum -a 256 fsusblog-v2.tar.gz payload.sha256 "$repo/tools/verify-release.py") > "$evidence/release-inputs.sha256"
    mkdir "$run/sealed/payload"
    payload="$run/sealed/payload"
    tar -xzf "$run/sealed/fsusblog-v2.tar.gz" -C "$payload"
    grep -Fxq "fsusblog_commit=$commit" "$payload/release.txt"
    grep -Fxq "fsusui_package=$ui_package" "$payload/release.txt"
    [[ -s "$payload/server/FsusBlog.V2.Server.dll" && -s "$payload/cli/FsusBlog.V2.Cli.dll" ]]
    cmp "$payload/Caddyfile" "$run/source/deploy/Caddyfile"
    mv -- "$payload/server" "$payload/web" "$run/"
    mv -- "$payload/cli" "$run/migrate"
    find "$run/sealed" -depth -delete
  else
    "$dotnet" restore src/Server/FsusBlog.V2.Server.csproj --locked-mode
    "$dotnet" restore src/Cli/FsusBlog.V2.Cli.csproj --locked-mode
    "$dotnet" build src/Server/FsusBlog.V2.Server.csproj -c Release --no-restore --output "$run/server"
    "$dotnet" build src/Cli/FsusBlog.V2.Cli.csproj -c Release --no-restore --output "$run/migrate"
    (cd src/Web && node node_modules/vite/bin/vite.js build --outDir "$run/web")
  fi
  go build -trimpath -o "$run/load" tests/Performance/{load,cold}.go
  cd "$repo"
} > "$evidence/build.log" 2>&1
ui_inputs | cmp -s "$evidence/fsusui-inputs.sha256" - || { echo 'FsusUI package artifacts changed during build.' >&2; exit 1; }
if [[ -n "$release" ]]; then
  [[ "$(source_hash)" == "$candidate" && "$(git rev-parse HEAD)" == "$commit" && -z "$(git status --porcelain)" ]] || {
    echo 'Candidate changed while verifying release inputs.' >&2
    exit 1
  }
fi
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
  target="https://localhost:$(choose_loopback_port)"
  export FSUSBLOG_PASSKEY_ORIGIN=$target FSUSBLOG_PASSKEY_RP_ID=localhost
fi
env FSUSBLOG_WEB_DIST="$run/web" ASPNETCORE_ENVIRONMENT=Production ASPNETCORE_URLS= \
  FSUSBLOG_TRUST_LOOPBACK_PROXY="$proxy_mode" \
  "${runtime_env[@]}" \
  Logging__LogLevel__Microsoft=Warning 'Logging__LogLevel__Microsoft.Hosting.Lifetime=Information' \
  "Logging__LogLevel__FsusBlog.V2.Server.Publications=$cache_level" \
  "$dotnet" "$server" --urls http://127.0.0.1:0 > "$evidence/server.log" 2>&1 &
server_pid=$!
startup_started=$SECONDS
while (( SECONDS - startup_started < 120 )); do
  own_child "$server_pid" || { echo 'Owned Kestrel exited before readiness.' >&2; exit 1; }
  url=$(sed -nE 's/.*Now listening on: (http:\/\/127\.0\.0\.1:[0-9]+).*/\1/p' "$evidence/server.log" | head -n1)
  if [[ -n "$url" ]] && lsof -n -P -a -p "$server_pid" -iTCP@127.0.0.1:"${url##*:}" -sTCP:LISTEN >/dev/null; then
    origin=$url
    break
  fi
  sleep 0.2
done
[[ -n "$origin" ]] || { echo 'Owned Kestrel did not bind within 120 seconds.' >&2; exit 1; }
printf 'listener_started_after_seconds=%s\n' "$((SECONDS - startup_started))" >> "$evidence/environment.txt"
if [[ "$proxy_mode" == true ]]; then
  stage=proxy-startup
  start_proxy
  stage=proxy-boundary
  "$dotnet" "$run/migrate/FsusBlog.V2.Cli.dll" operator proxy-check |
    node "$run/source/tests/Performance/proxy-boundary.mjs" "$target" "$origin" "$proxy_ca" "$FSUSBLOG_TLS_CERTIFICATE" \
      > "$evidence/proxy-boundary.log" 2>&1
  [[ "$(readiness)" == 204 ]]
else
  target=$origin
  wait_for_direct_readiness "$((startup_started + 120))" || {
    echo 'Owned Kestrel did not return readiness 204 within 120 seconds.' >&2
    exit 1
  }
  printf 'ready_after_seconds=%s\n' "$((SECONDS - startup_started))" >> "$evidence/environment.txt"
fi
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

sample_proc() {
  ps -o pid=,rss=,%cpu= -p "$1" | awk -v date="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" '{ print date "," $1 "," $2 "," $3 }'
}
(
  printf 'utc,pid,rss_kib,pcpu\n'
  if [[ -n "$proxy_pid" ]]; then printf 'utc,pid,rss_kib,pcpu\n' > "$evidence/proxy-process.csv"; fi
  if [[ -n "$launch_rate" ]]; then
    printf 'utc,pid,rss_kib,pcpu\n' > "$evidence/postgres-process.csv"
    printf 'utc,pid,rss_kib,pcpu\n' > "$evidence/supplier-process.csv"
  fi
  while kill -0 "$server_pid" 2>/dev/null; do
    sample_proc "$server_pid"
    if [[ -n "$proxy_pid" ]]; then sample_proc "$proxy_pid" >> "$evidence/proxy-process.csv"; fi
    if [[ -n "$launch_rate" ]]; then
      ps -axo pid=,ppid=,rss=,%cpu= | awk -v parent="$postgres_pid" -v date="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
        '$1 == parent || $2 == parent { print date "," $1 "," $3 "," $4 }' >> "$evidence/postgres-process.csv"
      if [[ -s "$run/supplier.pid" ]]; then
        supplier_pid=$(cat "$run/supplier.pid" 2>/dev/null || true)
        if [[ "$supplier_pid" =~ ^[1-9][0-9]*$ ]]; then
          sample_proc "$supplier_pid" >> "$evidence/supplier-process.csv" || true
        fi
      fi
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
  if [[ -n "$launch_rate" ]]; then printf '%s\n' "$load_pid" > "$run/supplier.pid"; fi
  wait "$load_pid"
  if [[ -n "$launch_rate" ]]; then rm -f -- "$run/supplier.pid"; fi
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
    measure "$warmup_name" "${launch_rate:-2000}" "$warmup_seconds"
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
  launch-direct|proxy-launch|proxy-launch-soak)
    seconds=60
    if [[ "$mode" == proxy-launch-soak ]]; then seconds=900; fi
    measure_with_warmup "$mode-$launch_rate" "$launch_rate" "$seconds" "warmup-$launch_rate" 30
    stage=launch-gate
    python3 -B "$run/source/tests/Performance/launch_gate.py" "$mode" "$launch_rate" "$evidence" \
      > "$evidence/launch-gate.json"
    ;;
  soak)
    measure_with_warmup direct-soak 8000 900 warmup-soak 30
    ;;
esac
stage=finished
