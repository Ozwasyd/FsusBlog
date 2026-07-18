#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${FSUSBLOG_SMOKE_OUTPUT_DIR:-$ROOT_DIR/.tmp/operations}"
BASE_URL="${FSUSBLOG_SMOKE_BASE_URL:-http://127.0.0.1:8080}"
DRY_RUN="${FSUSBLOG_SMOKE_DRY_RUN:-0}"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/post-deploy-smoke.json"

paths=(
    "/"
    "/feed/rss.xml"
    "/feed/atom.xml"
    "/feed/feed.json"
    "/sitemap.xml"
    "/robots.txt"
    "/health/live"
    "/health/ready"
)

status="ok"
blockers=()
verified_coverage=()
manual_checklist=(
    "admin-login"
    "binary-api"
    "notification-stream"
    "upload"
    "passkey-mfa"
)

json_array() {
    if (("$#" == 0)); then
        printf '[]'
        return
    fi

    printf '%s\n' "$@" | jq -R . | jq -s .
}

if [[ "$DRY_RUN" == "1" ]]; then
    status="scheduled"
    blockers+=("dry-run")
fi

for path in "${paths[@]}"; do
    if [[ "$DRY_RUN" == "1" ]]; then
        continue
    fi

    code="$(curl -k -sS -o /dev/null -w '%{http_code}' "$BASE_URL$path" || true)"
    if [[ "$code" != "200" && "$code" != "204" ]]; then
        status="blocked"
        blockers+=("$path:$code")
    else
        case "$path" in
            "/") verified_coverage+=("anonymous-public") ;;
            "/feed/rss.xml") verified_coverage+=("feed-rss") ;;
            "/feed/atom.xml") verified_coverage+=("feed-atom") ;;
            "/feed/feed.json") verified_coverage+=("feed-json") ;;
            "/sitemap.xml") verified_coverage+=("sitemap") ;;
            "/robots.txt") verified_coverage+=("robots") ;;
            "/health/live") verified_coverage+=("health-live") ;;
            "/health/ready") verified_coverage+=("health-ready") ;;
        esac
    fi
done

verified_coverage_json="$(json_array "${verified_coverage[@]}")"
manual_checklist_json="$(json_array "${manual_checklist[@]}")"
blockers_json="$(json_array "${blockers[@]}")"

jq -n \
    --arg status "$status" \
    --arg baseUrl "$BASE_URL" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson dryRun "$([[ "$DRY_RUN" == "1" ]] && echo true || echo false)" \
    --argjson manualChecklistCompleted "$([[ "${FSUSBLOG_SMOKE_MANUAL_CHECKLIST_COMPLETED:-0}" == "1" ]] && echo true || echo false)" \
    --argjson verifiedCoverage "$verified_coverage_json" \
    --argjson manualChecklist "$manual_checklist_json" \
    --argjson blockers "$blockers_json" \
    '{
    status: $status,
    baseUrl: $baseUrl,
    dryRun: $dryRun,
    generatedAt: $generatedAt,
    verifiedCoverage: $verifiedCoverage,
    manualChecklist: $manualChecklist,
    manualChecklistCompleted: $manualChecklistCompleted,
    blockers: $blockers
  }' >"$OUT_FILE"

echo "[post-deploy-smoke] wrote $OUT_FILE"
[[ "$status" == "ok" || "$status" == "scheduled" ]]
