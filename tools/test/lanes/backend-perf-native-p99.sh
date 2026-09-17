#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=_suite-support.sh
source "$ROOT_DIR/tools/test/lanes/_suite-support.sh"

CURRENT_TIER=backend-perf
CURRENT_STAGE=backend-native-p99
export FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release
RunBackendPerfNativeP99Only backend-perf
