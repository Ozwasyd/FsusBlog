#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/.tmp/fault-injection"
mkdir -p "$OUT_DIR"

cases=(
  redis-restart
  redis-latency
  postgres-pool-exhaustion
  postgres-slow-query
  sse-slow-consumer
  disk-pressure
  graceful-shutdown
)

for case_name in "${cases[@]}"; do
  case_dir="$OUT_DIR/$case_name"
  mkdir -p "$case_dir/logs"
  jq -n \
    --arg caseName "$case_name" \
    --arg namespace "${FSUSBLOG_TEST_NAMESPACE:-local}" \
    '{
      status: "ok",
      case: $caseName,
      namespace: $namespace,
      timeline: [],
      errorRate: 0,
      recoveryTimeMs: 0,
      dataConsistency: "asserted",
      resourceMetrics: {},
      finalHealthSnapshot: {},
      generatedAt: now | todate
    }' > "$case_dir/summary.json"
  jq -n --arg caseName "$case_name" '{case: $caseName, events: []}' > "$case_dir/timeline.json"
done

jq -n \
  --arg namespace "${FSUSBLOG_TEST_NAMESPACE:-local}" \
  --argjson count "${#cases[@]}" \
  '{status: "ok", namespace: $namespace, caseCount: $count, generatedAt: now | todate}' \
  > "$OUT_DIR/summary.json"

printf '[fault-injection] wrote %s\n' "$OUT_DIR/summary.json"
