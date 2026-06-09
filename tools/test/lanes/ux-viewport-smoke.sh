#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

npm --prefix "$ROOT_DIR/src/frontend" run check:ux:viewport-smoke
