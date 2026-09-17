#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
CURRENT_TIER=backend-auth-state-machine
RunTier "$CURRENT_TIER" RunBackendAuthStateMachineOnly
