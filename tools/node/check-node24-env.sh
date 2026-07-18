#!/usr/bin/env bash
set -euo pipefail

REQUIRED_MAJOR="${1:-20}"

log() {
    printf '[node:check] %s\n' "$1"
}

warn() {
    printf '[node:check] warning: %s\n' "$1" >&2
}

if ! command -v node >/dev/null 2>&1; then
    warn 'node is not available on PATH'
    exit 2
fi

current_node="$(command -v node)"
current_version="$(node --version 2>/dev/null || printf 'unknown')"
current_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"

log "current node: $current_node ($current_version)"
log "shell: ${SHELL:-unknown}"
log "cwd: $(pwd)"

if [[ "${TERM_PROGRAM:-}" == "vscode" ]]; then
    log 'terminal context: vscode'
fi

if [[ "${current_major}" =~ ^[0-9]+$ ]] && ((current_major >= REQUIRED_MAJOR)); then
    log "node major satisfies requirement >= ${REQUIRED_MAJOR}"
    exit 0
fi

warn "node major ${current_major} does not satisfy >= ${REQUIRED_MAJOR}"

for candidate in \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME/.volta/bin/node" \
    "/usr/local/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/opt/node@24/bin/node"; do
    if [[ -x "$candidate" ]]; then
        version="$("$candidate" --version 2>/dev/null || printf 'unknown')"
        log "candidate node: $candidate ($version)"
    fi
done

warn 'run tools/node/fix-vscode-node24.sh from a shell where node -v is already v24.x'
exit 1
