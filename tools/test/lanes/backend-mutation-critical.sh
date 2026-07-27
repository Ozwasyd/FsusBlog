#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
CURRENT_TIER=backend-mutation-critical
RunTier "$CURRENT_TIER" RunBackendMutationCriticalOnly

# Release-final consumes a second, isolated Release mutation execution.  The
# scheduler reruns the very same sealed critical authority scope in Release;
# accepting changed-critical selection or ambient development bin/obj would
# invalidate mutant identity parity.
if [[ "${FSUSBLOG_RELEASE_MUTATION_PARITY:-0}" == "1" ]]; then
    : "${FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY:?release mutation parity requires fixed subset policy path}"
    : "${FSUSBLOG_TEST_RUN_ID:?release mutation parity requires scheduler run id}"
    Run node "$ROOT_DIR/tools/test/run-release-mutation-parity-build.mjs" \
        --authority "$ROOT_DIR/.tmp/mutation/backend-critical/authority.json" \
        --policy "$FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY" \
        --output-root "$ROOT_DIR/.tmp/mutation/backend-critical/release-parity" \
        --run-id "$FSUSBLOG_TEST_RUN_ID"
    Run node "$ROOT_DIR/tools/test/run-release-mutation-parity.mjs" \
        --authority "$ROOT_DIR/.tmp/mutation/backend-critical/authority.json" \
        --release "$ROOT_DIR/.tmp/mutation/backend-critical/release-parity/$FSUSBLOG_TEST_RUN_ID/release-parity-receipt.json" \
        --policy "$FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY"
fi
