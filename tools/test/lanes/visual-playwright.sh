#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"
if [[ "${FSUSBLOG_SKIP_VISUAL_GATE:-0}" == "1" ]]; then
    CURRENT_TIER="visual"
    RecordVisualGateSkip
    WriteVisualGroupSummary public skipped 0
    WriteVisualGroupSummary console skipped 0
    Log "tier=visual | skipped by FSUSBLOG_SKIP_VISUAL_GATE=1"
    exit 0
fi
RunTier "visual" RunVisualOnly
