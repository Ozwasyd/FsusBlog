#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"

CURRENT_TIER="security-runtime-reset"
ResetSecurityRuntimeState "${1:-pre isolated runtime cohort}"
