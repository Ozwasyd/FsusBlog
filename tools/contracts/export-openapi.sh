#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${FSUSBLOG_OPENAPI_OUT_DIR:-$ROOT_DIR/.tmp/contracts/openapi}"
OUT_FILE="$OUT_DIR/fsusblog.openapi.json"
SNAPSHOT_FILE="$ROOT_DIR/src/shared/Contracts/Validation/fsusblog.openapi.json"
mkdir -p "$OUT_DIR"

if [[ "${FSUSBLOG_OPENAPI_BUILD:-1}" == "1" ]]; then
  ASPNETCORE_ENVIRONMENT="${ASPNETCORE_ENVIRONMENT:-Development}" \
  CORS_ALLOWED_HOSTS="${CORS_ALLOWED_HOSTS:-http://localhost:3000,http://127.0.0.1:3000}" \
  ConnectionStrings__DefaultConnection="${ConnectionStrings__DefaultConnection:-Host=127.0.0.1;Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev}" \
  ConnectionStrings__Redis="${ConnectionStrings__Redis:-127.0.0.1:6379,abortConnect=false}" \
  RedisOptions__InstanceName="${RedisOptions__InstanceName:-FsusBlog_OpenApi_}" \
  Jwt__SecretKey="${Jwt__SecretKey:-openapi-export-secret-key-with-at-least-32-chars}" \
  Jwt__Issuer="${Jwt__Issuer:-FsusBlog.OpenApi}" \
  Jwt__Audience="${Jwt__Audience:-FsusBlog.OpenApi}" \
  FSUSBLOG_DATA_ROOT="${FSUSBLOG_DATA_ROOT:-$ROOT_DIR/.tmp/openapi-data}" \
  FSUSBLOG_OPENAPI_EXPORT=1 \
  dotnet build "$ROOT_DIR/src/backend/FsusBlog.Server.csproj" \
    -p:OpenApiGenerateDocumentsOnBuild=true \
    -p:OpenApiDocumentsDirectory="$OUT_DIR" \
    -p:PublishClientAssets=false \
    -p:SkipClientDependenciesForPublish=true \
    -p:SkipClientReleaseBuild=true \
    -v minimal
fi

candidate="$(find "$OUT_DIR" -maxdepth 1 -type f \( -name '*.json' -o -name '*.openapi.json' \) -print -quit 2>/dev/null || true)"
if [[ -n "$candidate" && "$candidate" != "$OUT_FILE" ]]; then
  cp "$candidate" "$OUT_FILE"
fi

if [[ ! -f "$OUT_FILE" ]]; then
  if [[ "${FSUSBLOG_OPENAPI_ALLOW_MATRIX_FALLBACK:-0}" == "1" ]] && command -v "${FSUSBLOG_NODE:-node}" >/dev/null 2>&1; then
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/contracts/generate-cross-stack-contract.mjs" --write-openapi "$OUT_FILE"
  elif [[ "${FSUSBLOG_OPENAPI_ALLOW_SNAPSHOT_FALLBACK:-0}" == "1" && -f "$SNAPSHOT_FILE" ]]; then
    cp "$SNAPSHOT_FILE" "$OUT_FILE"
  else
    printf '[openapi] backend OpenAPI generation did not produce %s; matrix/snapshot fallback is disabled\n' "$OUT_FILE" >&2
    exit 1
  fi
fi

cp "$OUT_FILE" "$SNAPSHOT_FILE"
printf '[openapi] wrote %s and %s\n' "$OUT_FILE" "$SNAPSHOT_FILE"
