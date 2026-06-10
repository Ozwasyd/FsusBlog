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
for path in "${paths[@]}"; do
  if [[ "$DRY_RUN" == "1" ]]; then
    continue
  fi

  code="$(curl -k -sS -o /dev/null -w '%{http_code}' "$BASE_URL$path" || true)"
  if [[ "$code" != "200" && "$code" != "204" ]]; then
    status="blocked"
    blockers+=("$path:$code")
  fi
done

printf '{\n' > "$OUT_FILE"
printf '  "status": "%s",\n' "$status" >> "$OUT_FILE"
printf '  "baseUrl": "%s",\n' "$BASE_URL" >> "$OUT_FILE"
printf '  "dryRun": %s,\n' "$([[ "$DRY_RUN" == "1" ]] && echo true || echo false)" >> "$OUT_FILE"
printf '  "generatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT_FILE"
printf '  "coverage": ["anonymous-public","feed","sitemap","robots","production-health","admin-login-manual","binary-api-manual","notification-stream-manual","upload-manual","passkey-mfa-manual"],\n' >> "$OUT_FILE"
printf '  "blockers": [' >> "$OUT_FILE"
for i in "${!blockers[@]}"; do
  [[ "$i" == "0" ]] || printf ', ' >> "$OUT_FILE"
  printf '"%s"' "${blockers[$i]}" >> "$OUT_FILE"
done
printf ']\n}\n' >> "$OUT_FILE"

echo "[post-deploy-smoke] wrote $OUT_FILE"
[[ "$status" == "ok" ]]
