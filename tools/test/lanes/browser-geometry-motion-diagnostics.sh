#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT_DIR/tools/test/lanes/_lane-collect-support.sh"

if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" ]]; then
    printf '[browser-geometry-motion-diagnostics] diagnostics-only lane requires FSUSBLOG_BROWSER_DIAGNOSTICS=1\n' >&2
    exit 2
fi
if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS:-1}" != "1" ||
    "${FSUSBLOG_PLAYWRIGHT_WORKERS:-1}" != "1" ]]; then
    printf '[browser-geometry-motion-diagnostics] exactly one browser worker is required\n' >&2
    exit 2
fi

CLIENT_DIR="$ROOT_DIR/src/frontend"
HARNESS_ROOT="$ROOT_DIR/tests/browser-diagnostics/harness"
CANONICAL_EVIDENCE_ROOT="$ROOT_DIR/.tmp/browser-diagnostics-runtime/geometry-motion-focus"
EVIDENCE_ROOT="${FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT:-$CANONICAL_EVIDENCE_ROOT}"
SUMMARY_FILE="$CANONICAL_EVIDENCE_ROOT/geometry-motion-focus-summary.json"
HARNESS_LOG="$EVIDENCE_ROOT/isolated-public-shell-vite.log"
HARNESS_PID=''
ISOLATED_STATUS='not-run'
ISOLATED_EXIT_CODE=''
ARCHIVE_STATUS='not-run'
ARCHIVE_EXIT_CODE=''

mkdir -p "$EVIDENCE_ROOT" "$CANONICAL_EVIDENCE_ROOT"

StopHarness() {
    if [[ -n "$HARNESS_PID" ]] && kill -0 "$HARNESS_PID" >/dev/null 2>&1; then
        kill "$HARNESS_PID" >/dev/null 2>&1 || true
        wait "$HARNESS_PID" >/dev/null 2>&1 || true
    fi
    HARNESS_PID=''
}

WriteSummary() {
    env \
        FSUSBLOG_GEOMETRY_SUMMARY_FILE="$SUMMARY_FILE" \
        FSUSBLOG_GEOMETRY_ISOLATED_STATUS="$ISOLATED_STATUS" \
        FSUSBLOG_GEOMETRY_ISOLATED_EXIT_CODE="$ISOLATED_EXIT_CODE" \
        FSUSBLOG_GEOMETRY_ARCHIVE_STATUS="$ARCHIVE_STATUS" \
        FSUSBLOG_GEOMETRY_ARCHIVE_EXIT_CODE="$ARCHIVE_EXIT_CODE" \
        "${FSUSBLOG_NODE:-node}" --input-type=module <<'NODE' >/dev/null 2>&1
      import fs from "node:fs"
      import path from "node:path"

      const exitCode = (value) => value === "" ? null : Number(value)
      const probes = [
        {
          id: "public-mobile-menu",
          scope: "isolated-component-harness",
          status: process.env.FSUSBLOG_GEOMETRY_ISOLATED_STATUS,
          exitCode: exitCode(process.env.FSUSBLOG_GEOMETRY_ISOLATED_EXIT_CODE),
          dependsOn: ["local-fsusui-source", "local-fsusui-css", "chromium"],
          excludes: ["fsusblog-backend", "postgresql", "redis", "release-preview"]
        },
        {
          id: "archive-sticky-hash-geometry",
          scope: "release-preview-integration",
          status: process.env.FSUSBLOG_GEOMETRY_ARCHIVE_STATUS,
          exitCode: exitCode(process.env.FSUSBLOG_GEOMETRY_ARCHIVE_EXIT_CODE),
          dependsOn: ["fsusblog-release-preview", "archive-runtime", "chromium"]
        }
      ]
      const statuses = probes.map((probe) => probe.status)
      const status = statuses.every((value) => value === "success")
        ? "success"
        : statuses.some((value) => value === "failure" || value === "infra-failure")
          ? "failure"
          : "incomplete"
      const output = process.env.FSUSBLOG_GEOMETRY_SUMMARY_FILE
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, `${JSON.stringify({
        schema: "fsusblog.browser-geometry-motion-focus-diagnostics.v1",
        evidenceClass: "diagnostic",
        affectsCorrectness: false,
        status,
        probes
      }, null, 2)}\n`)
NODE
}

Cleanup() {
    local exitCode=$?
    local summaryExitCode=0
    trap - EXIT INT TERM ERR
    StopHarness
    WriteSummary || summaryExitCode=$?
    if ((summaryExitCode != 0)); then
        printf '[browser-geometry-motion-diagnostics] infra-failure: unable to write canonical summary %s\n' "$SUMMARY_FILE" >&2
        if ((exitCode == 0)); then
            exitCode=$summaryExitCode
        fi
    fi
    exit "$exitCode"
}
trap Cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export FSUSBLOG_BROWSER_DIAGNOSTICS=1
export FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS=1
export FSUSBLOG_PLAYWRIGHT_WORKERS=1
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_PLAYWRIGHT_CONFIG=playwright.diagnostics.config.ts
export FSUSBLOG_PLAYWRIGHT_RETRIES=0
export FSUSBLOG_PLAYWRIGHT_BROWSERS=chromium

HARNESS_PORT="$("${FSUSBLOG_NODE:-node}" -e '
  const server = require("node:net").createServer()
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(String(server.address().port))
    server.close()
  })
')"
HARNESS_URL="http://127.0.0.1:$HARNESS_PORT"

printf '[browser-geometry-motion-diagnostics] isolated component harness: FsusUI public-shell (no backend/database/cache)\n'
(
    cd "$CLIENT_DIR"
    exec npm exec -- vite "$HARNESS_ROOT" \
        --config "$HARNESS_ROOT/vite.config.ts" \
        --host 127.0.0.1 \
        --port "$HARNESS_PORT" \
        --strictPort
) >"$HARNESS_LOG" 2>&1 &
HARNESS_PID=$!

HARNESS_READY=0
for _ in $(seq 1 80); do
    if curl -fsS "$HARNESS_URL/" >/dev/null 2>&1; then
        HARNESS_READY=1
        break
    fi
    if ! kill -0 "$HARNESS_PID" >/dev/null 2>&1; then
        break
    fi
    sleep 0.25
done

if ((HARNESS_READY == 1)); then
    set +e
    RunInClient env -u NO_COLOR \
        PLAYWRIGHT_BASE_URL="$HARNESS_URL" \
        FSUSBLOG_PUBLIC_BASE_URL="$HARNESS_URL" \
        PLAYWRIGHT_OUTPUT_DIR="$EVIDENCE_ROOT/playwright/isolated-public-shell" \
        NODE_PATH=./node_modules \
        npx playwright test \
        --config=playwright.diagnostics.config.ts \
        --workers=1 \
        --retries=0 \
        diagnostics/public-mobile-menu-harness.spec.ts
    ISOLATED_EXIT_CODE=$?
    set -e
    if ((ISOLATED_EXIT_CODE == 0)); then
        ISOLATED_STATUS='success'
    else
        ISOLATED_STATUS='failure'
    fi
else
    ISOLATED_STATUS='infra-failure'
    ISOLATED_EXIT_CODE=1
    printf '[browser-geometry-motion-diagnostics] infra-failure: isolated harness failed to start; see %s\n' "$HARNESS_LOG" >&2
fi
StopHarness

printf '[browser-geometry-motion-diagnostics] release-preview integration: archive sticky/hash geometry\n'
PREVIEW_EXIT_CODE=0
if (RequireReleasePreview); then
    export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
    export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
    export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
    set +e
    RunInClient npm run ensure:wasm
    ENSURE_WASM_EXIT_CODE=$?
    if ((ENSURE_WASM_EXIT_CODE == 0)); then
        RunInClient env -u NO_COLOR \
            PLAYWRIGHT_OUTPUT_DIR="$EVIDENCE_ROOT/playwright/archive-integration" \
            NODE_PATH=./node_modules \
            npx playwright test \
            --config=playwright.diagnostics.config.ts \
            --workers=1 \
            --retries=0 \
            acceptance/archive-sticky-geometry.spec.ts
        ARCHIVE_EXIT_CODE=$?
    else
        ARCHIVE_EXIT_CODE=$ENSURE_WASM_EXIT_CODE
    fi
    set -e
    if ((ARCHIVE_EXIT_CODE == 0)); then
        ARCHIVE_STATUS='success'
    else
        ARCHIVE_STATUS='failure'
    fi
else
    PREVIEW_EXIT_CODE=$?
    ARCHIVE_STATUS='infra-failure'
    ARCHIVE_EXIT_CODE=$PREVIEW_EXIT_CODE
    printf '[browser-geometry-motion-diagnostics] infra-failure: release preview is unavailable\n' >&2
fi

if [[ "$ISOLATED_STATUS" != 'success' || "$ARCHIVE_STATUS" != 'success' ]]; then
    exit 1
fi
