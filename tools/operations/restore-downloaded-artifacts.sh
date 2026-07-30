#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOWNLOADED_DIR="${1:-$ROOT_DIR/.tmp/downloaded-artifacts}"
RESTORED_TMP_ROOT="${2:-$ROOT_DIR/.tmp}"
EVIDENCE_NAMES=(gate-logs release-evidence release-reliability docs frontend ux perf security coverage fault-injection fuzz soak operations)

[[ -d "$DOWNLOADED_DIR" ]] || exit 0

for artifact_dir in "$DOWNLOADED_DIR"/*; do
    [[ -d "$artifact_dir" ]] || continue
    for artifact_root in "$artifact_dir" "$artifact_dir/.tmp"; do
        [[ -d "$artifact_root" ]] || continue
        for name in "${EVIDENCE_NAMES[@]}"; do
            source_dir="$artifact_root/$name"
            [[ -d "$source_dir" ]] || continue
            mkdir -p "$RESTORED_TMP_ROOT/$name"
            cp -a "$source_dir/." "$RESTORED_TMP_ROOT/$name/"
        done
        if [[ -d "$artifact_root/jobs" ]]; then
            mkdir -p "$RESTORED_TMP_ROOT/release-evidence/jobs"
            cp -a "$artifact_root/jobs/." "$RESTORED_TMP_ROOT/release-evidence/jobs/"
        fi
    done
done
