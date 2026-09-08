#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

redis_host="${FSUSBLOG_TEST_REDIS_HOST:-127.0.0.1}"
case "$redis_host" in
    127.0.0.1 | host.docker.internal) ;;
    *)
        echo "[perception-redis-fixture] ERROR: Redis host must identify the local Docker host" >&2
        exit 1
        ;;
esac

command -v docker >/dev/null 2>&1 || {
    echo "[perception-redis-fixture] ERROR: docker is required but not installed or not found in PATH" >&2
    exit 1
}

docker info >/dev/null 2>&1 || {
    echo "[perception-redis-fixture] ERROR: docker daemon is not accessible" >&2
    exit 1
}

run_suffix="${FSUSBLOG_TEST_RUN_ID:-$$}-${RANDOM:-0}"
container="fsusblog-perception-v3-redis-${run_suffix}"
redis_prefix="test:perception-v3-local-redis:${run_suffix}:"

Cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
}
trap Cleanup EXIT

redis_image="$(node "$ROOT_DIR/tools/test/execution-envelope-services.mjs" --image-reference redis)"
docker image inspect "$redis_image" >/dev/null 2>&1 || {
    printf 'pinned Redis image is not present locally; restore it before correctness execution: %s\n' "$redis_image" >&2
    exit 1
}

docker run --rm -d --name "$container" -p 127.0.0.1::6379 "$redis_image" redis-server --save '' --appendonly no >/dev/null

port="$(docker port "$container" 6379/tcp 2>/dev/null | head -n 1 | sed -E 's/.*:([0-9]+)$/\1/')"
if [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]]; then
    echo "[perception-redis-fixture] ERROR: failed to resolve published port for container $container" >&2
    exit 1
fi

ready=0
for _ in $(seq 1 40); do
    if docker exec "$container" redis-cli ping 2>/dev/null | grep -q PONG; then
        ready=1
        break
    fi
    sleep 0.1
done

if [[ "$ready" -ne 1 ]]; then
    echo "[perception-redis-fixture] ERROR: Redis container $container failed to respond to PING within timeout" >&2
    exit 1
fi

trx_dir="$ROOT_DIR/.tmp/test-results/backend"
trx_file="$trx_dir/perception-character-v3-redis-${run_suffix}.trx"
redis_lua_case_evidence="$trx_dir/perception-character-v3-redis-lua-cases-${run_suffix}.json"
redis_budget_evidence="$trx_dir/perception-character-v3-budget-cases-${run_suffix}.json"
mkdir -p "$trx_dir"
rm -f "$trx_file" "$redis_lua_case_evidence" "$redis_budget_evidence"

output_receipt="$ROOT_DIR/.tmp/test-results/backend/perception-character-v3-redis-producer.json"
configuration="${FSUSBLOG_TEST_CONFIGURATION:-Release}"
test_assembly="$ROOT_DIR/tests/backend/bin/$configuration/net10.0/FsusBlog.Server.Tests.dll"
source_commit="${FSUSBLOG_TEST_SOURCE_COMMIT:-$(git rev-parse HEAD)}"
source_fingerprint="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-$(node --input-type=module -e 'import { snapshotGitWorktree } from "./tools/test-matrix/scheduler.mjs"; process.stdout.write((await snapshotGitWorktree(process.argv[1])).fingerprint)' "$ROOT_DIR")}"

filter="$("${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/perception-redis-producer.mjs" --print-filter)"

if ! initial_keys="$(docker exec "$container" redis-cli --raw --scan --pattern "${redis_prefix}*")"; then
    echo "[perception-redis-fixture] ERROR: failed to inspect the Redis prefix" >&2
    exit 1
fi
if [[ -n "$initial_keys" ]]; then
    echo "[perception-redis-fixture] ERROR: Redis prefix is polluted before the test: $redis_prefix" >&2
    exit 1
fi

RedisLuaCalls() {
    docker exec "$container" redis-cli --raw info commandstats |
        awk -F'[:,=]' '/^cmdstat_eval(sha)?:/ { for (field = 1; field <= NF; field += 1) if ($field == "calls") total += $(field + 1) } END { print total + 0 }'
}

redis_lua_calls_before="$(RedisLuaCalls)"
test_status=0

FSUSBLOG_TEST_REDIS="${redis_host}:${port},abortConnect=true" \
    FSUSBLOG_TEST_REDIS_PREFIX="$redis_prefix" \
    FSUSBLOG_TEST_LOCAL_REDIS_RUN_ID="$run_suffix" \
    FSUSBLOG_TEST_REDIS_CASE_EVIDENCE="$redis_lua_case_evidence" \
    FSUSBLOG_TEST_REDIS_BUDGET_EVIDENCE="$redis_budget_evidence" \
    dotnet test "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj" \
    --configuration "$configuration" \
    -m:1 \
    --no-restore \
    --filter "$filter" \
    --logger "trx;LogFileName=$trx_file" \
    --logger 'console;verbosity=minimal' || test_status=$?

redis_lua_calls_after="$(RedisLuaCalls)"
cleanup_verified=true
if ! remaining_keys="$(docker exec "$container" redis-cli --raw --scan --pattern "${redis_prefix}*")"; then
    cleanup_verified=false
elif [[ -n "$remaining_keys" ]]; then
    cleanup_verified=false
fi

producer_status=0
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/perception-redis-producer.mjs" \
    --trx "$trx_file" \
    --container "$container" \
    --endpoint "${redis_host}:${port}" \
    --assembly "$test_assembly" \
    --filter "$filter" \
    --prefix "$redis_prefix" \
    --run-id "$run_suffix" \
    --source-commit "$source_commit" \
    --source-fingerprint "$source_fingerprint" \
    --redis-lua-calls-before "$redis_lua_calls_before" \
    --redis-lua-calls-after "$redis_lua_calls_after" \
    --redis-lua-case-evidence "$redis_lua_case_evidence" \
    --redis-budget-evidence "$redis_budget_evidence" \
    --cleanup-verified "$cleanup_verified" \
    --output "$output_receipt" || producer_status=$?

if ((test_status != 0 || producer_status != 0)); then
    echo "[perception-redis-fixture] ERROR: LocalRedis execution failed test_status=$test_status producer_status=$producer_status" >&2
    exit 1
fi
