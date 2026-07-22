#!/usr/bin/env bash
set -euo pipefail

workers="${FSUSBLOG_CONSOLE_VISUAL_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-$(node ../../tools/test/resolve-playwright-workers.mjs visual-console)}}"
playwright_config="${FSUSBLOG_PLAYWRIGHT_CONFIG:-playwright.config.ts}"
shard_args=()
if [[ -n "${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-}" ]]; then
    shard_args+=("$FSUSBLOG_PLAYWRIGHT_SHARD_ARG")
fi
groups=(
    'console visual \(desktop, light\)'
    'console visual \(desktop, dark\)'
    'console visual \(mobile, light\)'
    'console visual \(mobile, dark\)'
    'console visual \(narrow-mobile, light\)'
    'console visual \(narrow-mobile, dark\)'
    'console visual \(short-mobile, light\)'
    'console visual \(short-mobile, dark\)'
    'console visual \(mobile-landscape, light\)'
    'console visual \(mobile-landscape, dark\)'
    'console visual \(tablet, light\)'
    'console visual \(tablet, dark\)'
    'console visual \(tablet-landscape, light\)'
    'console visual \(tablet-landscape, dark\)'
)

for group in "${groups[@]}"; do
    echo "[console-visual] group=${group}"
    env -u NO_COLOR NODE_PATH=./node_modules npx playwright test --config="${playwright_config}" "${shard_args[@]}" visual/console-visual.spec.ts --grep "${group}" --workers="${workers}"
done

echo "[console-visual] group=admin-dashboard-workload-matrix"
env -u NO_COLOR NODE_PATH=./node_modules npx playwright test --config="${playwright_config}" "${shard_args[@]}" visual/admin-dashboard-workbench.spec.ts --workers="${workers}"

echo "[console-visual] group=admin-inline-empty-state-correctness"
env -u NO_COLOR NODE_PATH=./node_modules npx playwright test --config="${playwright_config}" "${shard_args[@]}" admin-inline-empty-state.spec.ts --workers="${workers}"

echo "[console-visual] group=admin-inline-empty-state-representatives"
env -u NO_COLOR NODE_PATH=./node_modules npx playwright test --config="${FSUSBLOG_VISUAL_DIAGNOSTICS_CONFIG:-playwright.diagnostics.config.ts}" "${shard_args[@]}" visual/admin-inline-empty-state.spec.ts --workers="${workers}"
