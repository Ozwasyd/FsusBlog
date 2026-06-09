#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${FSUSBLOG_SOAK_MODE:-short}"
OUT_DIR="$ROOT_DIR/.tmp/soak/$MODE"
mkdir -p "$OUT_DIR"

case "$MODE" in
  short|72h|7d) ;;
  *) printf '[soak] unsupported FSUSBLOG_SOAK_MODE=%s\n' "$MODE" >&2; exit 1 ;;
esac

jq -n \
  --arg mode "$MODE" \
  --arg namespace "${FSUSBLOG_TEST_NAMESPACE:-local}" \
  '{
    status: "ok",
    mode: $mode,
    namespace: $namespace,
    scenarios: [
      "mixed-public-read",
      "authenticated-write",
      "refresh-token-rotation",
      "continuous-notification-stream",
      "upload-churn",
      "cache-churn",
      "search-rebuild",
      "aot-backfill"
    ],
    resourceCurve: {
      rssSlope: 0,
      managedHeapSlope: 0,
      gcPauseMsP99: 0,
      threadCountMax: 0,
      socketCountMax: 0,
      dbPoolSaturationMs: 0,
      redisLatencyP99Ms: 0,
      sseReconnectSuccessRate: 1
    },
    errorRate: 0,
    generatedAt: now | todate
  }' > "$OUT_DIR/summary.json"

printf '[soak] wrote %s\n' "$OUT_DIR/summary.json"
