#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${FSUSBLOG_ZAP_OUT_DIR:-$ROOT_DIR/.tmp/security/zap}"
CONFIG_FILE="${FSUSBLOG_ZAP_CONFIG:-$ROOT_DIR/tools/security/zap-baseline.conf}"
ZAP_IMAGE="${FSUSBLOG_ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}"
SPIDER_MINUTES="${FSUSBLOG_ZAP_SPIDER_MINUTES:-2}"

DEBUG_BACKEND_URL="${FSUSBLOG_BASE_URL:-${FSUSBLOG_DEBUG_BACKEND_URL:-http://127.0.0.1:5000}}"
TARGETS="${FSUSBLOG_ZAP_TARGETS:-$DEBUG_BACKEND_URL}"

log() {
  printf '[zap-baseline] %s\n' "$1"
}

sanitize_target() {
  printf '%s' "$1" | sed -E 's#^https?://##; s#[^A-Za-z0-9_.-]+#-#g; s#^-|-$##g'
}

if ! command -v docker >/dev/null 2>&1; then
  log 'docker is required for OWASP ZAP baseline scan'
  exit 1
fi

"$ROOT_DIR/tools/security/check-zap-warn-policy.mjs"

mkdir -p "$OUT_DIR"
RUN_DIR="${FSUSBLOG_ZAP_RUN_DIR:-$OUT_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
mkdir -p "$RUN_DIR"
chmod 0777 "$RUN_DIR"
log "reports dir=$RUN_DIR"

overall_status=0
for target in $TARGETS; do
  label="$(sanitize_target "$target")"
  json_report="${label}.json"
  html_report="${label}.html"
  markdown_report="${label}.md"

  log "scan target=$target"
  set +e
  docker run --rm --network host \
    -v "$RUN_DIR:/zap/wrk:rw" \
    -v "$CONFIG_FILE:/zap/fsusblog-zap-baseline.conf:ro" \
    "$ZAP_IMAGE" \
    zap-baseline.py \
      -t "$target" \
      -m "$SPIDER_MINUTES" \
      -J "$json_report" \
      -r "$html_report" \
      -w "$markdown_report" \
      -c /zap/fsusblog-zap-baseline.conf
  status=$?
  set -e

  case "$status" in
    0)
      log "target passed without alerts: $target"
      ;;
    2)
      log "target completed with WARN alerts; see $RUN_DIR/$markdown_report"
      ;;
    *)
      log "target failed with FAIL alerts or scanner error: $target (exit $status)"
      overall_status=1
      ;;
  esac
done

exit "$overall_status"
