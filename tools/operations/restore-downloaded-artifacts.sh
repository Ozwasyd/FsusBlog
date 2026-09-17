#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOWNLOADED_DIR="${1:-$ROOT_DIR/.tmp/downloaded-artifacts}"
RESTORED_TMP_ROOT="${2:-$ROOT_DIR/.tmp}"

if [[ -n "${FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST:-}" ]]; then
    WORK_ROOT="${FSUSBLOG_REPOSITORY_ROOT:-$ROOT_DIR}"
    node "$ROOT_DIR/tools/test/run-current-run-evidence-transport.mjs" extract \
        --root "$WORK_ROOT" \
        --manifest "$FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST" \
        --extract-root "$RESTORED_TMP_ROOT"
    exit 0
fi

if [[ -d "$DOWNLOADED_DIR" ]] && [[ -n "$(ls -A "$DOWNLOADED_DIR" 2>/dev/null || true)" ]]; then
    echo "downloaded artifacts exist without a transport manifest" >&2
    exit 2
fi
