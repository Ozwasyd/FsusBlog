#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

printf '[deprecated] FsusBlog.Client/scripts/full-regression.sh has been replaced by ./tools/test.sh ci\n' >&2
exec "$ROOT_DIR/tools/test.sh" ci
