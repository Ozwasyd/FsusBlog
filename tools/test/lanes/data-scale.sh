#!/usr/bin/env bash
# fixture-catalog: consumer data-scale-lane matrix
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TIER="${FSUSBLOG_SCALE_TIER:-${1:-scale-xs}}"
DATA_SCALE_ROOT="${FSUSBLOG_DATA_SCALE_ROOT:-$ROOT_DIR/.tmp/scale}"
OUT_DIR="$DATA_SCALE_ROOT/$TIER"
RELEASE_SUMMARY_DIR="$DATA_SCALE_ROOT/release-summaries"
PROVISION_MODE="${FSUSBLOG_DATA_SCALE_PROVISION_MODE:-full}"
PROVISIONER_SCRIPT="${FSUSBLOG_DATA_SCALE_PROVISIONER_SCRIPT:-$ROOT_DIR/tools/data-scale/runtime-provisioner.mjs}"
NODE_BIN="${FSUSBLOG_NODE:-node}"

# Fail closed: never *use* shared/dev/candidate containers. Clear ambient injected
# names so DataScaleRuntimeProvisioner is the only source of runtime identity.
clear_if_shared_container() {
    local var_name="$1"
    local value="${!var_name:-}"
    if [[ -z "$value" ]]; then
        return 0
    fi
    case "$value" in
        fsusblog-dev-postgres|fsusblog-dev-redis|fsusblog-dev-*|fsusblog-test-postgres-*|fsusblog-test-redis-*|fsusblog-candidate-*)
            printf '[data-scale] ignoring shared/development container %s from %s; provisioning dedicated-scenario runtime\n' "$value" "$var_name" >&2
            unset "$var_name"
            ;;
    esac
}
clear_if_shared_container FSUSBLOG_POSTGRES_CONTAINER_NAME
clear_if_shared_container FSUSBLOG_PG_CONTAINER
clear_if_shared_container FSUSBLOG_REDIS_CONTAINER_NAME

mkdir -p "$OUT_DIR"
mkdir -p "$RELEASE_SUMMARY_DIR"
# Measurement owns only its current probe and release projection. Dedicated
# runtime/seed setup and teardown are lifecycle-owner receipts, not lane output.
rm -f -- "$OUT_DIR/summary.json" "$RELEASE_SUMMARY_DIR/$TIER.json"

case "$TIER" in
    scale-xs)
        articles=1
        comments=0
        ;;
    scale-s)
        articles=100
        comments=1000
        ;;
    scale-m)
        articles=10000
        comments=100000
        ;;
    scale-l-nightly)
        articles=100000
        comments=1000000
        ;;
    *)
        printf '[data-scale] unknown tier %s\n' "$TIER" >&2
        exit 1
        ;;
esac

PROVISION_ENV="$OUT_DIR/dedicated-runtime.env"
PROVISION_ARGS=(
    "$PROVISIONER_SCRIPT"
    provision
    --tier "$TIER"
    --mode "$PROVISION_MODE"
    --emit-env "$PROVISION_ENV"
    --repository-root "$ROOT_DIR"
)
if [[ -n "${FSUSBLOG_TEST_RUN_ID:-}" ]]; then
    PROVISION_ARGS+=(--parent-scheduler-run-id "$FSUSBLOG_TEST_RUN_ID")
fi
if [[ -n "${FSUSBLOG_TEST_NAMESPACE:-}" ]]; then
    PROVISION_ARGS+=(--namespace "$FSUSBLOG_TEST_NAMESPACE")
fi
if [[ -n "${FSUSBLOG_DATA_SCALE_RUN_ID:-}" ]]; then
    PROVISION_ARGS+=(--data-scale-run-id "$FSUSBLOG_DATA_SCALE_RUN_ID")
fi

printf '[data-scale] provisioning dedicated-scenario runtime via DataScaleRuntimeProvisioner mode=%s\n' "$PROVISION_MODE"
"$NODE_BIN" "${PROVISION_ARGS[@]}"
# shellcheck disable=SC1090
set -a
# Source only the provisioner-emitted dedicated identity; do not re-read local.env.
source "$PROVISION_ENV"
set +a

if [[ -z "${FSUSBLOG_POSTGRES_CONTAINER_NAME:-}" || -z "${FSUSBLOG_REDIS_CONTAINER_NAME:-}" ]]; then
    printf '[data-scale] provisioner did not emit dedicated postgres/redis identity\n' >&2
    exit 1
fi
case "${FSUSBLOG_POSTGRES_CONTAINER_NAME}" in
    fsusblog-dev-postgres|fsusblog-dev-*|fsusblog-test-postgres-*|fsusblog-candidate-*)
        printf '[data-scale] provisioner emitted forbidden postgres container %s\n' "$FSUSBLOG_POSTGRES_CONTAINER_NAME" >&2
        exit 1
        ;;
esac

set +e
bash "${FSUSBLOG_DATA_SCALE_PROBE_SCRIPT:-$ROOT_DIR/tools/data-scale/probe.sh}" "$TIER"
probe_status=$?
set -e

ReadJsonOrNull() {
    local file="$1"
    if [[ -f "$file" ]] && jq -e . "$file" >/dev/null 2>&1; then
        jq -c . "$file"
        return
    fi

    printf 'null'
}

summary_json="$(ReadJsonOrNull "$OUT_DIR/summary.json")"
summary_status="$(jq -r '.status // "failed"' <<<"$summary_json")"
summary_schema="$(jq -r '.schema // empty' <<<"$summary_json")"
release_status="ok"
if [[ "$summary_schema" != "fsusblog.data-scale-semantic-proof.v2" ]]; then
    printf '[data-scale] summary.json schema must be fsusblog.data-scale-semantic-proof.v2, got %s\n' "${summary_schema:-<empty>}" >&2
    release_status="failed"
fi
if [[ "$probe_status" -ne 0 || "$summary_status" != "ok" ]]; then
    release_status="failed"
fi

jq -n \
    --arg status "$release_status" \
    --arg tier "$TIER" \
    --arg file "$(realpath --relative-to="$ROOT_DIR" "$OUT_DIR/summary.json")" \
    --argjson articles "$articles" \
    --argjson comments "$comments" \
    --argjson observed "$summary_json" \
    '({schema:"fsusblog.data-scale-tier-summary.v1", status:$status, tier:$tier, summary:$file, expectedSeed:{articles:$articles, comments:$comments}, sampling:$observed.sampling, observed:$observed, generatedAt: now | todate} + (if $observed.releaseReliability == null then {} else {releaseReliability:$observed.releaseReliability} end))' \
    >"$RELEASE_SUMMARY_DIR/$TIER.json"

if [[ "$release_status" != "ok" ]]; then
    printf '[data-scale] failed tier=%s probe=%s summary=%s\n' "$TIER" "$probe_status" "$summary_status" >&2
    exit 1
fi

printf '[data-scale] wrote %s\n' "$OUT_DIR/summary.json"
