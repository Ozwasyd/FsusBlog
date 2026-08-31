#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ -n "${FSUSBLOG_NODE:-}" ]]; then
    echo "release-final rejects ambient FSUSBLOG_NODE overrides" >&2
    exit 1
fi
NODE_BIN="${FSUSBLOG_RELEASE_FINAL_NODE_BIN:-}"
NODE_REALPATH="${FSUSBLOG_RELEASE_FINAL_NODE_REALPATH:-}"
NODE_SHA256="${FSUSBLOG_RELEASE_FINAL_NODE_SHA256:-}"
NODE_VERSION="${FSUSBLOG_RELEASE_FINAL_NODE_VERSION:-}"
if [[ -z "$NODE_BIN" || -z "$NODE_REALPATH" || -z "$NODE_SHA256" || -z "$NODE_VERSION" || ! -f "$NODE_BIN" || ! -x "$NODE_BIN" || -L "$NODE_BIN" ]]; then
    echo "release-final requires sealed Node toolchain identity" >&2
    exit 1
fi
if [[ "$NODE_BIN" != "$NODE_REALPATH" || "$($NODE_BIN --version)" != "$NODE_VERSION" ]]; then
    echo "release-final Node toolchain identity drifted" >&2
    exit 1
fi
releaseFinalDecision="${FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION:-fsusblog.release-finalizer-spawn-decision.v1|missing|0}"
case "$releaseFinalDecision" in
    fsusblog.release-finalizer-spawn-decision.v1\|accepted\|1)
        ;;
    fsusblog.release-finalizer-spawn-decision.v1\|failed\|0|fsusblog.release-finalizer-spawn-decision.v1\|missing\|0|fsusblog.release-finalizer-spawn-decision.v1\|stale\|0)
        echo "release-final seal rejected: $releaseFinalDecision" >&2
        exit 1
        ;;
    *)
        echo "release-final seal decision is invalid: $releaseFinalDecision" >&2
        exit 1
        ;;
esac
releaseFinalEvidencePaths=(
    "${FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT:-}"
    "${FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH:-}"
    "${FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH:-}"
)
for evidencePath in "${releaseFinalEvidencePaths[@]}"; do
    if [[ -z "$evidencePath" || ! -f "$evidencePath" || ! -s "$evidencePath" || -L "$evidencePath" ]]; then
        echo "release-final requires existing non-empty context and evidence files" >&2
        exit 1
    fi
done
releaseFinalArgs=()
if [[ -n "${FSUSBLOG_LOCAL_PROFILE_CHECKPOINT:-}" ]]; then
    releaseFinalArgs+=(--local-profile-checkpoint "$FSUSBLOG_LOCAL_PROFILE_CHECKPOINT")
fi
releaseFinalArgs+=(--current-run-context "$FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT")
releaseFinalArgs+=(--manifest-binding "$FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH")
releaseFinalArgs+=(--domain-binding "$FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH")
"$NODE_BIN" "$ROOT_DIR/tools/release/check-release-final.mjs" "${releaseFinalArgs[@]}"
