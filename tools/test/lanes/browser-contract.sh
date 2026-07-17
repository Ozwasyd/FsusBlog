#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
CONTRACT_TIMEOUT="${FSUSBLOG_BROWSER_CONTRACT_TIMEOUT:-9m}"

if [[ ! "$CONTRACT_TIMEOUT" =~ ^([1-9][0-9]*)(s|m)$ ]]; then
  printf '[browser-contract] FSUSBLOG_BROWSER_CONTRACT_TIMEOUT must be a positive s/m duration\n' >&2
  exit 2
fi

cd "$ROOT_DIR"
"$NODE_BIN" --test "$ROOT_DIR/tests/tools/browser-contract.test.mjs"

exec timeout --signal=TERM --kill-after=15s "$CONTRACT_TIMEOUT" \
  "$NODE_BIN" "$ROOT_DIR/tests/browser-contract/run.mjs"
