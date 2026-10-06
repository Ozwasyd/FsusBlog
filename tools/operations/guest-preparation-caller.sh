#!/usr/bin/env bash
# The Node owner validates the frozen plan before its sole original CLI call.
set -eu
set -o pipefail
umask 077
scriptRoot=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec node "$scriptRoot/guest-preparation-caller.mjs" "$@"
