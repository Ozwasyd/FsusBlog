#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
export FSUSBLOG_VITEST_LANE="frontend-unit-shard-$(NamespaceSlug "${FSUSBLOG_TEST_RUN_ID:-direct}")"
RunTier "frontend-unit-shard" RunFrontendUnitShardLane
if [[ -z "${FSUSBLOG_TEST_SHARD_TOTAL:-}" || "${FSUSBLOG_TEST_SHARD_TOTAL}" == "1" ]]; then
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/write-release-domain-assertion-report.mjs" --producer frontend-unit-shard
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/produce-release-domain-receipt.mjs" --producer frontend-unit-shard
fi
