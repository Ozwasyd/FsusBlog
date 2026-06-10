#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_FILE="$ROOT_DIR/.tmp/perf/browser-performance.json"
mkdir -p "$(dirname "$OUT_FILE")" "$ROOT_DIR/.tmp/release-evidence"

ROUTE_PRESSURE="$ROOT_DIR/.tmp/frontend/route-render-pressure.json"
DOM_BUDGET="$ROOT_DIR/.tmp/frontend/dom-budget.json"

if [[ -f "$ROUTE_PRESSURE" ]]; then
  if [[ ! -f "$DOM_BUDGET" ]]; then
    DOM_BUDGET="$ROOT_DIR/.tmp/perf/browser-dom-budget-empty.json"
    jq -n '{routes: []}' > "$DOM_BUDGET"
  fi
  jq -n \
    --slurpfile route "$ROUTE_PRESSURE" \
    --slurpfile dom "$DOM_BUDGET" \
    '
    ($route[0].routes // []) as $routes
    | {
      status: (if ($routes | length) > 0 then "ok" else "blocked" end),
      reason: (if ($routes | length) > 0 then null else "frontend render-pressure artifact has no route samples" end),
      source: "frontend-render-pressure",
      routeCount: ($route[0].routeCount // ($routes | length)),
      warningCount: ($route[0].warningCount // 0),
      metrics: {
        maxRouteTransitionTimeMs: ([$routes[]?.routeTransitionTimeMs] | max // null),
        maxLongTaskCount: ([$routes[]?.longTaskCount] | max // null),
        maxJsHeapBytes: ([$routes[]?.jsHeapBytes | select(. != null)] | max // null),
        maxDomNodeCount: ([$dom[0].routes[]?.nodeCount] | max // null)
      },
      artifacts: {
        routeRenderPressure: ".tmp/frontend/route-render-pressure.json",
        domBudget: ".tmp/frontend/dom-budget.json"
      },
      generatedAt: now | todate
    }' > "$OUT_FILE"
  status="$(jq -r '.status' "$OUT_FILE")"
  jq -n --arg status "$status" '{status:$status, browserPerformance:".tmp/perf/browser-performance.json", generatedAt: now | todate}' > "$ROOT_DIR/.tmp/release-evidence/perf-summary.json"
else
  jq -n '{
    status: "blocked",
    reason: "missing frontend render-pressure runtime artifact",
    requiredArtifact: ".tmp/frontend/route-render-pressure.json",
    generatedAt: now | todate
  }' > "$OUT_FILE"
  jq -n '{status:"blocked", browserPerformance:".tmp/perf/browser-performance.json", generatedAt: now | todate}' > "$ROOT_DIR/.tmp/release-evidence/perf-summary.json"
fi
printf '[browser-performance] wrote %s\n' "$OUT_FILE"
