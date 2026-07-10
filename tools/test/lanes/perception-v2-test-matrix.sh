#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/security/check-security-matrices.mjs"
dotnet_args=()
if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]; then
  dotnet_args+=(--no-build --no-restore)
fi
FSUSBLOG_REPO_ROOT="$ROOT_DIR" "$ROOT_DIR/tools/build-with-data-env.sh" dotnet test \
  "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj" \
  -c Debug \
  -v minimal \
  "${dotnet_args[@]}" \
  --filter "FullyQualifiedName~PerceptionSealedV2TestMatrixTests|FullyQualifiedName~PerceptionChallengeV2E2eTests"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/security/check-perception-v2-e2e-evidence.mjs"
