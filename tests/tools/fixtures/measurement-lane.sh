#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
inner_evidence="$1"
duration_file="$2"

"${FSUSBLOG_NODE:-node}" "$root_dir/tools/test/performance-admission.mjs" \
    --window-id real-inner-lane-owner \
    --evidence "$inner_evidence" \
    -- \
    "${FSUSBLOG_NODE:-node}" "$root_dir/tests/tools/fixtures/measurement-task.mjs" \
    timed 300 "$duration_file"
