#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1
# shellcheck source=../legacy-test.sh
source "$ROOT_DIR/tools/test/legacy-test.sh"
