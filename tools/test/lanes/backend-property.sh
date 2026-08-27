#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ -z "${FSUSBLOG_RANDOM_STREAMS_JSON:-}" ]]; then
    exec "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-random-stream-producer.mjs" \
        --producer backend-property -- "$0" "$@"
fi
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
CURRENT_TIER=backend-property
RunTier "$CURRENT_TIER" RunBackendPropertyOnly
