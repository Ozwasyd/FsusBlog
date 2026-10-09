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
exec {NODE_FD}<"$NODE_BIN"
NODE_FD_PATH="/proc/$$/fd/$NODE_FD"
if [[ ! -e "$NODE_FD_PATH" ]]; then
    echo "release-final cannot pin the sealed Node executable" >&2
    exit 1
fi
mapfile -t actualNodeIdentity < <(
    "$NODE_FD_PATH" -e 'const crypto = require("node:crypto"); const fs = require("node:fs"); const target = process.argv[1]; console.log(fs.realpathSync(target)); console.log(`sha256:${crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`); console.log(process.version);' "$NODE_FD_PATH"
)
if [[ "${actualNodeIdentity[0]:-}" != "$NODE_REALPATH" || "${actualNodeIdentity[1]:-}" != "$NODE_SHA256" || "${actualNodeIdentity[2]:-}" != "$NODE_VERSION" ]]; then
    echo "release-final Node toolchain identity drifted" >&2
    exit 1
fi
releaseFinalSpawnSealDigest="${FSUSBLOG_RELEASE_FINAL_SPAWN_SEAL_DIGEST:-}"
releaseFinalDecision="${FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION:-fsusblog.release-finalizer-spawn-decision.v1|missing|0}"
case "$releaseFinalDecision" in
    fsusblog.release-finalizer-spawn-decision.v1\|accepted\|1\|"$releaseFinalSpawnSealDigest")
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
    "${FSUSBLOG_RELEASE_FINAL_BINDING_INPUTS_PATH:-}"
    "${FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_PATH:-}"
    "${FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_HANDOFF_PATH:-}"
    "${FSUSBLOG_RELEASE_FINAL_COMMITTED_CHECKPOINT:-}"
)
for evidencePath in "${releaseFinalEvidencePaths[@]}"; do
    if [[ -z "$evidencePath" || ! -f "$evidencePath" || ! -s "$evidencePath" || -L "$evidencePath" ]]; then
        echo "release-final requires existing non-empty context and evidence files" >&2
        exit 1
    fi
done
releaseFinalArgs=()
releaseFinalArgs+=(--current-run-context "$FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT")
releaseFinalArgs+=(--inputs "$FSUSBLOG_RELEASE_FINAL_BINDING_INPUTS_PATH")
releaseFinalArgs+=(--inputs-digest "${FSUSBLOG_RELEASE_FINAL_BINDING_INPUTS_DIGEST:-}")
releaseFinalArgs+=(--checkpoint "$FSUSBLOG_RELEASE_FINAL_COMMITTED_CHECKPOINT")
releaseFinalArgs+=(--committed-revision "${FSUSBLOG_RELEASE_FINAL_COMMITTED_REVISION:-}")
releaseFinalArgs+=(--reference "$FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_PATH")
releaseFinalArgs+=(--reference-digest "${FSUSBLOG_RELEASE_FINAL_REFERENCE_DIGEST:-}")
releaseFinalArgs+=(--handoff "$FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_HANDOFF_PATH")
releaseFinalArgs+=(--handoff-digest "${FSUSBLOG_RELEASE_FINAL_HANDOFF_DIGEST:-}")
exec "$NODE_FD_PATH" "$ROOT_DIR/tools/release/check-release-final.mjs" "${releaseFinalArgs[@]}"
