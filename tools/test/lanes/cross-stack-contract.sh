#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
CURRENT_TIER=cross-stack-contract
RunTier "$CURRENT_TIER" RunCrossStackContractOnly "${1:-static}"
