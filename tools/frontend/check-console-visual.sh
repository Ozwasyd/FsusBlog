#!/usr/bin/env bash
set -euo pipefail

workers="${FSUSBLOG_CONSOLE_VISUAL_WORKERS:-1}"
groups=(
  'console visual \(desktop, light\)'
  'console visual \(desktop, dark\)'
  'console visual \(mobile, light\)'
  'console visual \(mobile, dark\)'
  'console visual \(narrow-mobile, light\)'
  'console visual \(narrow-mobile, dark\)'
)

for group in "${groups[@]}"; do
  echo "[console-visual] group=${group}"
  env -u NO_COLOR NODE_PATH=./node_modules npx playwright test visual/console-visual.spec.ts --grep "${group}" --workers="${workers}"
done
