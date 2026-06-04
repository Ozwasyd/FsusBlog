#!/usr/bin/env bash
set -euo pipefail

for name in $(env | sed -n 's/^\(SNAP[A-Z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

unset GTK_PATH
unset GTK_EXE_PREFIX
unset GTK_IM_MODULE_FILE
unset GIO_MODULE_DIR

if [[ -n "${XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG:-}" ]]; then
  export XDG_CONFIG_DIRS="$XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG"
fi

if [[ -n "${XDG_DATA_DIRS_VSCODE_SNAP_ORIG:-}" ]]; then
  export XDG_DATA_DIRS="$XDG_DATA_DIRS_VSCODE_SNAP_ORIG"
fi

exec "$@"
