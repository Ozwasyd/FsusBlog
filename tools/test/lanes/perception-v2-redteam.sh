#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE="${1:-pr}"

case "$PROFILE" in
  pr)
    DEFAULT_SAMPLES=96
    ;;
  nightly)
    DEFAULT_SAMPLES=960
    ;;
  *)
    echo "usage: $0 pr|nightly" >&2
    exit 2
    ;;
esac

SAMPLES="${FSUSBLOG_PERCEPTION_V2_SAMPLES:-$DEFAULT_SAMPLES}"
SEED="${FSUSBLOG_PERCEPTION_V2_SEED:-521}"
OUT="${FSUSBLOG_PERCEPTION_V2_OUT:-$ROOT_DIR/.tmp/security/perception-v2/$PROFILE}"

node "$ROOT_DIR/benchmarks/security/perception-v2/run.mjs" \
  --profile "$PROFILE" \
  --samples "$SAMPLES" \
  --seed "$SEED" \
  --out "$OUT"
