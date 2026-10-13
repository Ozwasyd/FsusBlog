#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLAN_FILE=""
MODE=normal
RUN_ID=""
declare -A SEEN_ARGUMENTS=()

Usage() {
    printf '%s\n' \
        'Usage: zero-downtime-rehearsal.sh --plan <current-v2-plan> [--mode normal|resume] [--run-id <id>]' \
        'Consumes explicit current receipts in an already isolated current topology.' \
        'Runs fresh pinned Server read-only admission and the original complete release entry.' \
        'Never executes offline plan/apply/verify, schema upgrades, or an old-image rollback.' \
        'Provider/offline/crash/backup qualification is a separate evidence domain.'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plan | --mode | --run-id)
            [[ $# -ge 2 && "$2" != --* ]] || { printf 'missing value: %s\n' "$1" >&2; exit 2; }
            [[ ! -v "SEEN_ARGUMENTS[$1]" ]] || { printf 'duplicate argument: %s\n' "$1" >&2; exit 2; }
            SEEN_ARGUMENTS["$1"]=1
            case "$1" in
                --plan) PLAN_FILE="$2" ;;
                --mode) MODE="$2" ;;
                --run-id) RUN_ID="$2" ;;
            esac
            shift 2
            ;;
        -h | --help) Usage; exit 0 ;;
        *) printf 'legacy or unknown rehearsal argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done
[[ "$MODE" == normal || "$MODE" == resume ]] || {
    printf 'legacy image rollback/all/SIGKILL qualification is retired; select an explicit current normal or resume run\n' >&2
    exit 2
}
[[ -n "$PLAN_FILE" && -f "$PLAN_FILE" && ! -L "$PLAN_FILE" ]] || { printf 'explicit regular current plan required\n' >&2; exit 2; }
[[ -n "$RUN_ID" ]] || RUN_ID="run-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
exec node "$SCRIPT_DIR/zero-downtime-rehearsal-plan.mjs" run-current \
    --plan "$(realpath "$PLAN_FILE")" --repo-root "$ROOT_DIR" --mode "$MODE" --run-id "$RUN_ID"
