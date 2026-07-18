#!/usr/bin/env bash
set -euo pipefail

PrintValue()
{
    local sampleValue="${1:?value is required}"
    export FSUSBLOG_STYLE_FIXTURE="${sampleValue}"
    printf '%s\n' "${FSUSBLOG_STYLE_FIXTURE}"
}

PrintValue "${1:-fixture}"
