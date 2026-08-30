#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
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
"$NODE_BIN" "$ROOT_DIR/tools/release/check-release-final.mjs" "${releaseFinalArgs[@]}"
