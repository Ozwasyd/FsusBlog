#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EVENT_NAME="${FSUSBLOG_PR_EVENT_NAME:-${GITHUB_EVENT_NAME:-local}}"
BASE_REF="${FSUSBLOG_PR_BASE_REF:-${FSUSBLOG_BASE_REF:-${GITHUB_BASE_REF:-origin/master}}}"
CHANGED_FILES="${FSUSBLOG_CHANGED_FILES_FILE:-$ROOT_DIR/.tmp/pr-changed-files.txt}"
PLAN="${FSUSBLOG_PR_PLAN_OUT:-$ROOT_DIR/.tmp/pr-plan.json}"

mkdir -p "$(dirname "$CHANGED_FILES")" "$(dirname "$PLAN")"
git -C "$ROOT_DIR" diff --name-only --no-renames "$BASE_REF...HEAD" >"$CHANGED_FILES"

ARGS=(
    ci-pr-plan
    --changed-files "$CHANGED_FILES"
    --event-name "$EVENT_NAME"
    --base-ref "$BASE_REF"
    --out "$PLAN"
)
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    ARGS+=(--github-output "$GITHUB_OUTPUT")
fi

exec node "$ROOT_DIR/tools/run-test-matrix.mjs" "${ARGS[@]}"
