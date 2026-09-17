#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [[ "$#" -ne 0 ]]; then
  echo "backend-qps arguments are retired; invoke runtime-cache-evidence.sh with current arguments" >&2
  exit 64
fi

exec "$ROOT_DIR/tools/test/lanes/runtime-cache-evidence.sh"
