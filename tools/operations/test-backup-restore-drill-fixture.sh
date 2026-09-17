#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

OUT_DIR="$TMP_ROOT/operations"
mkdir -p "$OUT_DIR"

FSUSBLOG_DRILL_OUTPUT_DIR="$OUT_DIR" \
    FSUSBLOG_DRILL_MODE=dry-run \
    "$ROOT_DIR/tools/operations/backup-restore-drill.sh"

jq -e '
  .status == "scheduled"
  and .mode == "dry-run"
  and (.checks | index("postgres:planned") != null)
' "$OUT_DIR/backup-restore-drill.json" >/dev/null

set +e
FSUSBLOG_DRILL_OUTPUT_DIR="$OUT_DIR" \
    FSUSBLOG_DRILL_MODE=real \
    FSUSBLOG_DRILL_RUN_ID=fixture-missing-inputs \
    "$ROOT_DIR/tools/operations/backup-restore-drill.sh"
status=$?
set -e

[[ "$status" != "0" ]]

jq -e '
  .status == "blocked"
  and .mode == "real"
  and (.blockers | index("postgres-backup-missing") != null)
  and (.blockers | index("redis-backup-missing") != null)
  and (.blockers | index("uploads-backup-missing") != null)
  and (.blockers | index("aot-backup-missing") != null)
  and (.blockers | index("search-backup-missing") != null)
' "$OUT_DIR/backup-restore-drill.json" >/dev/null

echo "[backup-restore-drill-fixture] ok"
