#!/usr/bin/env bash
set -euo pipefail

container="fsusblog-perception-v3-redis-$$"
Cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap Cleanup EXIT
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
redis_image="$(node "$root_dir/tools/test/execution-envelope-services.mjs" --image-reference redis)"
docker image inspect "$redis_image" >/dev/null 2>&1 || {
    printf 'pinned Redis image is not present locally; restore it before correctness execution: %s\n' "$redis_image" >&2
    exit 1
}
docker run --rm -d --name "$container" -p 127.0.0.1::6379 "$redis_image" redis-server --save '' --appendonly no >/dev/null
port="$(docker port "$container" 6379/tcp | sed 's/.*://')"
for _ in $(seq 1 40); do
    if docker exec "$container" redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
    sleep 0.1
done
FSUSBLOG_TEST_REDIS="127.0.0.1:${port},abortConnect=true" dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter 'Fixture=LocalRedis&FullyQualifiedName~PerceptionCharacterV3' --logger 'console;verbosity=minimal'
