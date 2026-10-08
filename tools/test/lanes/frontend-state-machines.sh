#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_suite-support.sh"
EnsureFrontendFsusUiBaseline
RunTier "frontend-state-machines" RunVitestScriptUnsharded check:frontend-state-machines
