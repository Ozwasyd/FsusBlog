#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"
run_tier "backend-build-governance" run_backend_build_governance_lane
