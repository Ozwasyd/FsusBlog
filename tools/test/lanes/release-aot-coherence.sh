#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
MODE="${1:-}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:8080}"

run_client() {
    (
        cd "$CLIENT_DIR"
        PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL" "$@"
    )
}

case "$MODE" in
    generation)
        run_client npm run check:public-page-manifest-sync
        run_client npm run check:public-aot-contracts
        ;;
    consumption)
        run_client npm run check:pow-runtime
        run_client npm run check:public-hydration
        run_client npm run check:distribution-version-coherence
        ;;
    static-asset-digest)
        "$ROOT_DIR/tools/operations/check-publish-artifact-slimness.mjs"
        run_client npm run check:public-distribution-contract
        ;;
    *)
        printf '[release-aot-coherence] unknown mode: %s\n' "$MODE" >&2
        exit 1
        ;;
esac
