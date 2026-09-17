#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
if [[ "${FSUSBLOG_SKIP_VISUAL_GATE:-0}" == "1" ]]; then
    CURRENT_TIER="visual-console"
    RecordVisualGateSkip
    WriteVisualGroupSummary console skipped 0
    WriteVisualPlaywrightSkipEvidence console
    Log "tier=visual-console | skipped by FSUSBLOG_SKIP_VISUAL_GATE=1"
    exit 0
fi
RunTier "visual-console" RunVisualConsoleOnly
