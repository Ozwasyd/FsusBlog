#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_FILE="${FSUSBLOG_BROWSER_PERFORMANCE_OUT_FILE:-$ROOT_DIR/.tmp/perf/browser-performance.json}"
RELEASE_SUMMARY_FILE="${FSUSBLOG_BROWSER_PERFORMANCE_RELEASE_SUMMARY_FILE:-$ROOT_DIR/.tmp/perf/release-summaries/browser-performance-regression.json}"
RELEASE_SUMMARY_DIR="$(dirname "$RELEASE_SUMMARY_FILE")"
mkdir -p "$(dirname "$OUT_FILE")" "$RELEASE_SUMMARY_DIR"

ROUTE_PRESSURE="${FSUSBLOG_BROWSER_PERFORMANCE_ROUTE_PRESSURE_FILE:-$ROOT_DIR/.tmp/frontend/route-render-pressure.json}"
DOM_BUDGET="${FSUSBLOG_BROWSER_PERFORMANCE_DOM_BUDGET_FILE:-$ROOT_DIR/.tmp/frontend/dom-budget.json}"

if [[ -f "$ROUTE_PRESSURE" ]]; then
    if [[ ! -f "$DOM_BUDGET" ]]; then
        DOM_BUDGET="$ROOT_DIR/.tmp/perf/browser-dom-budget-empty.json"
        jq -n '{routes: []}' >"$DOM_BUDGET"
    fi
    jq -n \
        --slurpfile route "$ROUTE_PRESSURE" \
        --slurpfile dom "$DOM_BUDGET" \
        '
    ($route[0].routes // []) as $routes
    | {
      status: (if ($routes | length) > 0 then "ok" else "blocked" end),
      evidenceClass: "diagnostic",
      affectsCorrectness: false,
      executionBoundary: "real-browser-performance-diagnostics",
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
    }' >"$OUT_FILE"
    status="$(jq -r '.status' "$OUT_FILE")"
    jq -n --arg status "$status" '{
    status:$status,
    evidenceClass:"diagnostic",
    affectsCorrectness:false,
    executionBoundary:"real-browser-performance-diagnostics",
    browserPerformance:".tmp/perf/browser-performance.json",
    generatedAt: now | todate
  }' >"$RELEASE_SUMMARY_FILE"
else
    printf '[browser-performance] infra-failure: missing frontend render-pressure runtime artifact %s\n' "$ROUTE_PRESSURE" >&2
    jq -n '{
    status: "blocked",
    evidenceClass: "diagnostic",
    affectsCorrectness: false,
    executionBoundary: "real-browser-performance-diagnostics",
    reason: "missing frontend render-pressure runtime artifact",
    requiredArtifact: ".tmp/frontend/route-render-pressure.json",
    generatedAt: now | todate
  }' >"$OUT_FILE"
    jq -n '{
    status:"blocked",
    evidenceClass:"diagnostic",
    affectsCorrectness:false,
    executionBoundary:"real-browser-performance-diagnostics",
    browserPerformance:".tmp/perf/browser-performance.json",
    generatedAt: now | todate
  }' >"$RELEASE_SUMMARY_FILE"
fi
printf '[browser-performance] wrote %s\n' "$OUT_FILE"
if [[ "$(jq -r '.status' "$OUT_FILE")" != "ok" ]]; then
    printf '[browser-performance] diagnostic blocked; see %s\n' "$OUT_FILE" >&2
    exit 1
fi
