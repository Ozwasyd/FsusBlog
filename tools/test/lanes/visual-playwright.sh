#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"
if [[ "${FSUSBLOG_SKIP_VISUAL_GATE:-0}" == "1" ]]; then
  CURRENT_TIER="visual"
  record_visual_gate_skip
  log "tier=visual | skipped by FSUSBLOG_SKIP_VISUAL_GATE=1"
  exit 0
fi
run_tier "visual" run_visual_only
