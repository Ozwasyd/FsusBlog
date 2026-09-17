#!/usr/bin/env bash
set -euo pipefail
exec "${FSUSBLOG_NODE:-node}" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-bundle.mjs" build-static
