#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

releaseEvidenceManifestArgs=()
if [[ -n "${FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT:-}" ]]; then
    releaseEvidenceManifestArgs+=("$FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT/release-evidence/release-evidence/manifest.json")
fi
"$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" --require-ok ${releaseEvidenceManifestArgs[@]+"${releaseEvidenceManifestArgs[@]}"}
