#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"
run_tier "frontend-property-model-perf" run_frontend_property_model_perf_lane
