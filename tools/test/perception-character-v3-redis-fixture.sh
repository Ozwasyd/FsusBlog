#!/usr/bin/env bash
set -euo pipefail

container="fsusblog-perception-v3-redis-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --rm -d --name "$container" -p 127.0.0.1::6379 redis:7-alpine redis-server --save '' --appendonly no >/dev/null
port="$(docker port "$container" 6379/tcp | sed 's/.*://')"
for _ in $(seq 1 40); do
  if docker exec "$container" redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
  sleep 0.1
done
FSUSBLOG_TEST_REDIS="127.0.0.1:${port},abortConnect=true" dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter 'FullyQualifiedName~PerceptionCharacterV3Tests.RedisLua' --logger 'console;verbosity=minimal'
