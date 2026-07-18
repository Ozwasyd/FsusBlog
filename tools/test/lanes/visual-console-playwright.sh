#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"
if [[ "${FSUSBLOG_SKIP_VISUAL_GATE:-0}" == "1" ]]; then
    CURRENT_TIER="visual-console"
    record_visual_gate_skip
    write_visual_group_summary console skipped 0
    write_visual_playwright_skip_evidence console
    log "tier=visual-console | skipped by FSUSBLOG_SKIP_VISUAL_GATE=1"
    exit 0
fi
run_tier "visual-console" run_visual_console_only
