#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${FSUSBLOG_OPENAPI_OUT_DIR:-$ROOT_DIR/.tmp/contracts/openapi}"
OUT_FILE="$OUT_DIR/fsusblog.openapi.json"
SNAPSHOT_FILE="$ROOT_DIR/src/shared/Contracts/Validation/fsusblog.openapi.json"
mkdir -p "$OUT_DIR"

if [[ "${FSUSBLOG_OPENAPI_BUILD:-1}" == "1" ]]; then
  dotnet build "$ROOT_DIR/src/backend/FsusBlog.Server.csproj" \
    -p:OpenApiGenerateDocumentsOnBuild=true \
    -p:OpenApiDocumentsDirectory="$OUT_DIR" \
    -p:PublishClientAssets=false \
    -p:SkipClientDependenciesForPublish=true \
    -p:SkipClientReleaseBuild=true \
    -v minimal >/dev/null || true
fi

candidate="$(find "$OUT_DIR" -maxdepth 1 -type f \( -name '*.json' -o -name '*.openapi.json' \) -print -quit 2>/dev/null || true)"
if [[ -n "$candidate" && "$candidate" != "$OUT_FILE" ]]; then
  cp "$candidate" "$OUT_FILE"
fi

if [[ ! -f "$OUT_FILE" ]]; then
  if command -v "${FSUSBLOG_NODE:-node}" >/dev/null 2>&1; then
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/contracts/generate-cross-stack-contract.mjs" --write-openapi "$OUT_FILE"
  elif [[ -f "$SNAPSHOT_FILE" ]]; then
    cp "$SNAPSHOT_FILE" "$OUT_FILE"
  else
    printf '[openapi] no generated OpenAPI, no node fallback, and no committed snapshot\n' >&2
    exit 1
  fi
fi

cp "$OUT_FILE" "$SNAPSHOT_FILE"
printf '[openapi] wrote %s and %s\n' "$OUT_FILE" "$SNAPSHOT_FILE"
