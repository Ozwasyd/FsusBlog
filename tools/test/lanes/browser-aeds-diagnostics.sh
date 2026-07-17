#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" ]]; then
  printf '[browser-aeds-diagnostics] diagnostics-only lane requires FSUSBLOG_BROWSER_DIAGNOSTICS=1\n' >&2
  exit 2
fi
if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS:-1}" != "1" \
    || "${FSUSBLOG_PLAYWRIGHT_WORKERS:-1}" != "1" ]]; then
  printf '[browser-aeds-diagnostics] exactly one outer browser worker is required\n' >&2
  exit 2
fi

export FSUSBLOG_BROWSER_DIAGNOSTICS=1
export FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS=1
export FSUSBLOG_PLAYWRIGHT_WORKERS=1
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_PLAYWRIGHT_CONFIG=playwright.diagnostics.config.ts
export FSUSBLOG_PLAYWRIGHT_RETRIES=0
export FSUSBLOG_AEDS_BROWSERS=chromium,firefox,webkit

exec "${FSUSBLOG_NODE:-node}" \
  "$ROOT_DIR/tests/frontend/checks/wasm/check-aeds-tier-browser.mjs"
