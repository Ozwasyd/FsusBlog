#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_suite-support.sh"
EnsureFrontendFsusUiBaseline
RunTier "frontend-perf-regression" RunInClientMeasurement frontend-perf-regression \
    "$ROOT_DIR/.tmp/frontend/frontend-perf-regression.measurement-noise.json" \
    npm run check:frontend-perf-regression
