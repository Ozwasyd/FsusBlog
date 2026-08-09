#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
CORRECTNESS_RECEIPT="$ROOT_DIR/.tmp/release-evidence/browserless-correctness-receipt.json"

"$ROOT_DIR/tools/test/run-matrix-governance-once.sh" release-final-evidence-plan
rm -f "$CORRECTNESS_RECEIPT"
"$NODE_BIN" "$ROOT_DIR/tools/release/test-evidence-receipts-cli.mjs" create-correctness
"$NODE_BIN" "$ROOT_DIR/tools/ci/check-job-summaries.mjs" --require-plan --tier release-final --include-manual --include-nightly --strict-shards
"$NODE_BIN" "$ROOT_DIR/tools/ci/check-flaky-registry.mjs" --release-final
"$NODE_BIN" "$ROOT_DIR/tools/ci/check-flaky-evidence.mjs" --release-final
releaseEvidenceManifestArgs=()
if [[ -n "${FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT:-}" ]]; then
    releaseEvidenceManifestArgs+=("$FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT/release-evidence/release-evidence/manifest.json")
fi
"$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" --require-ok ${releaseEvidenceManifestArgs[@]+"${releaseEvidenceManifestArgs[@]}"}
for authority in \
    application-static-governance \
    test-asset-governance \
    workflow-lint \
    document-governance \
    community-governance; do
    "$NODE_BIN" "$ROOT_DIR/tools/governance/repository-governance-authority.mjs" verify "$authority"
done
releaseFinalArgs=()
if [[ -n "${FSUSBLOG_LOCAL_PROFILE_CHECKPOINT:-}" ]]; then
    releaseFinalArgs+=(--local-profile-checkpoint "$FSUSBLOG_LOCAL_PROFILE_CHECKPOINT")
fi
"$NODE_BIN" "$ROOT_DIR/tools/release/check-release-final.mjs" "${releaseFinalArgs[@]}"
