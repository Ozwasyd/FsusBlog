#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
if [[ "${FSUSBLOG_SKIP_VISUAL_GATE:-0}" == "1" ]]; then
    CURRENT_TIER="visual-public"
    RecordVisualGateSkip
    WriteVisualGroupSummary public skipped 0
    WriteVisualPlaywrightSkipEvidence public
    Log "tier=visual-public | skipped by FSUSBLOG_SKIP_VISUAL_GATE=1"
    exit 0
fi
RunTier "visual-public" RunVisualPublicOnly
