#!/usr/bin/env bash
# fixture-catalog: producer scale-data
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIER="${1:-scale-xs}"
if [[ "${FSUSBLOG_DATA_SCALE_OUT_DIR+x}" == "x" ]]; then
    [[ -n "$FSUSBLOG_DATA_SCALE_OUT_DIR" ]] || {
        printf '[data-scale:probe] FSUSBLOG_DATA_SCALE_OUT_DIR must not be empty\n' >&2
        exit 1
    }
    case "$FSUSBLOG_DATA_SCALE_OUT_DIR" in
        /*) ;;
        *)
            printf '[data-scale:probe] FSUSBLOG_DATA_SCALE_OUT_DIR must be an absolute path\n' >&2
            exit 1
            ;;
    esac
    case "/$FSUSBLOG_DATA_SCALE_OUT_DIR/" in
        */../* | */./*)
            printf '[data-scale:probe] FSUSBLOG_DATA_SCALE_OUT_DIR must not traverse directories\n' >&2
            exit 1
            ;;
    esac
    command -v readlink >/dev/null 2>&1 || {
        printf '[data-scale:probe] readlink is required to validate FSUSBLOG_DATA_SCALE_OUT_DIR\n' >&2
        exit 1
    }
    OUT_DIR="$(readlink -m -- "$FSUSBLOG_DATA_SCALE_OUT_DIR")"
    repository_tmp="$(readlink -m -- "$ROOT_DIR/.tmp")"
    system_tmp="$(readlink -m -- "${TMPDIR:-/tmp}")"
    [[ "$system_tmp" != "/" ]] || {
        printf '[data-scale:probe] TMPDIR must not resolve to the filesystem root\n' >&2
        exit 1
    }
    if [[ "$OUT_DIR" != "$repository_tmp/"* && "$OUT_DIR" != "$system_tmp/"* ]]; then
        printf '[data-scale:probe] FSUSBLOG_DATA_SCALE_OUT_DIR must stay under %s or %s\n' "$repository_tmp" "$system_tmp" >&2
        exit 1
    fi
else
    OUT_DIR="${FSUSBLOG_DATA_SCALE_ROOT:-$ROOT_DIR/.tmp/scale}/$TIER"
fi
mkdir -p "$OUT_DIR"

export FSUSBLOG_DATA_SCALE_ARTIFACT_EVIDENCE="$OUT_DIR/artifact-rebuild.json"
set +e
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" data-scale "$TIER" "$OUT_DIR/summary.json"
semanticStatus=$?
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/data-scale/run-query-matrix.mjs" --tier "$TIER" --summary "$OUT_DIR/summary.json"
matrixStatus=$?
set -e
if [[ "$semanticStatus" -ne 0 || "$matrixStatus" -ne 0 ]]; then
    exit 1
fi
printf '[data-scale:probe] wrote %s\n' "$OUT_DIR/summary.json"
printf '[data-scale:probe] updated %s\n' "$OUT_DIR/artifact-rebuild.json"
