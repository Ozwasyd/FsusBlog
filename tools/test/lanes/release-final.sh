#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"

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
if [[ -z "${FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT:-}" \
    || -z "${FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH:-}" \
    || -z "${FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH:-}" ]]; then
    echo "release-final requires explicit current-run context, manifest binding, and domain binding" >&2
    exit 1
fi
releaseFinalArgs+=(--current-run-context "$FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT")
releaseFinalArgs+=(--manifest-binding "$FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH")
releaseFinalArgs+=(--domain-binding "$FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH")
if [[ ! -f "$FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH" ]]; then
    echo "release-final domain binding is missing; produce it upstream with: node tools/test/publish-release-final-evidence-parent.mjs --context \"$FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT\" --output \"$FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH\"" >&2
    exit 1
fi
"$NODE_BIN" "$ROOT_DIR/tools/release/check-release-final.mjs" "${releaseFinalArgs[@]}"
