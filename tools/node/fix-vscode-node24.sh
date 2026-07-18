#!/usr/bin/env bash
set -euo pipefail

TARGET_MAJOR="${1:-24}"
BASHRC="$HOME/.bashrc"

log() {
    printf '[node:fix] %s\n' "$1"
}

fail() {
    printf '[node:fix] fatal: %s\n' "$1" >&2
    exit 1
}

if ! command -v node >/dev/null 2>&1; then
    fail 'node is not available in this shell'
fi

current_version="$(node --version 2>/dev/null || printf 'unknown')"
current_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"

if [[ ! "$current_major" =~ ^[0-9]+$ ]] || ((current_major != TARGET_MAJOR)); then
    fail "run this script in a shell already using node v${TARGET_MAJOR}.x (current: ${current_version})"
fi

node_bin="$(dirname "$(command -v node)")"
export_line="export PATH=\"$node_bin:\$PATH\""
marker="# FsusBlog VSCode Node ${TARGET_MAJOR} pin"

if [[ ! -f "$BASHRC" ]]; then
    touch "$BASHRC"
fi

if ! rg -Fq "$marker" "$BASHRC"; then
    {
        printf '\n%s\n' "$marker"
        printf '%s\n' "$export_line"
    } >>"$BASHRC"
    log "added PATH pin to $BASHRC"
else
    log "marker already exists in $BASHRC"
fi

log "node pinned to: $node_bin"
log 'fully restart VSCode, then verify in integrated terminal: which node && node -v'
