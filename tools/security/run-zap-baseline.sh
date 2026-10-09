#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${FSUSBLOG_ZAP_OUT_DIR:-$ROOT_DIR/.tmp/security/zap}"
CONFIG_FILE="${FSUSBLOG_ZAP_CONFIG:-$ROOT_DIR/tools/security/zap-baseline.conf}"
ZAP_IMAGE="${FSUSBLOG_ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}"
SPIDER_MINUTES="${FSUSBLOG_ZAP_SPIDER_MINUTES:-2}"

DEBUG_BACKEND_URL="${FSUSBLOG_BASE_URL:-${FSUSBLOG_DEBUG_BACKEND_URL:-http://127.0.0.1:7568}}"
TARGETS="${FSUSBLOG_ZAP_TARGETS:-$DEBUG_BACKEND_URL}"

Log() {
    printf '[zap-baseline] %s\n' "$1"
}

SanitizeTarget() {
    printf '%s' "$1" | sed -E 's#^https?://##; s#[^A-Za-z0-9_.-]+#-#g; s#^-|-$##g'
}

if ! command -v docker >/dev/null 2>&1; then
    Log 'docker is required for OWASP ZAP baseline scan'
    exit 1
fi

"$ROOT_DIR/tools/security/check-zap-warn-policy.mjs"

mkdir -p "$OUT_DIR"
RUN_DIR="${FSUSBLOG_ZAP_RUN_DIR:-$OUT_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
mkdir -p "$RUN_DIR"
chmod 0777 "$RUN_DIR"
Log "reports dir=$RUN_DIR"

overall_status=0
for target in $TARGETS; do
    label="$(SanitizeTarget "$target")"
    json_report="${label}.json"
    html_report="${label}.html"
    markdown_report="${label}.md"

    Log "scan target=$target"
    docker_labels=()
    if [[ -n "${FSUSBLOG_TEST_RUN_ID:-}" ]]; then
        docker_labels+=(
            --label "fsusblog.test-run=$FSUSBLOG_TEST_RUN_ID"
            --label "fsusblog.step-id=${FSUSBLOG_STEP_ID:-zap-baseline}"
        )
    fi
    set +e
    docker run --rm --network host "${docker_labels[@]}" \
        -v "$RUN_DIR:/zap/wrk:rw" \
        -v "$CONFIG_FILE:/zap/fsusblog-zap-baseline.conf:ro" \
        "$ZAP_IMAGE" \
        zap-baseline.py \
        -t "$target" \
        -m "$SPIDER_MINUTES" \
        -J "$json_report" \
        -r "$html_report" \
        -w "$markdown_report" \
        -c /zap/fsusblog-zap-baseline.conf \
        --autooff
    status=$?
    set -e

    if node "$ROOT_DIR/tools/security/zap-baseline-result-outlet.mjs" \
        "$RUN_DIR/zap-baseline-results.jsonl" "$target" "$status" \
        "$RUN_DIR/$json_report" "$RUN_DIR/$html_report" "$RUN_DIR/$markdown_report"; then
        :
    else
        outletStatus=$?
        Log "result outlet failed: $target (outlet exit $outletStatus; scanner exit $status)"
        overall_status=1
    fi

    case "$status" in
        0)
            Log "target passed without alerts: $target"
            ;;
        2)
            Log "target completed with WARN alerts; see $RUN_DIR/$markdown_report"
            ;;
        *)
            Log "target failed with FAIL alerts or scanner error: $target (exit $status)"
            overall_status=1
            ;;
    esac
done

exit "$overall_status"
