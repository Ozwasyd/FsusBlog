#!/usr/bin/env bash
set -euo pipefail

label="${1:-noop}"
printf '[test:%s] noop composite tier\n' "$label"
