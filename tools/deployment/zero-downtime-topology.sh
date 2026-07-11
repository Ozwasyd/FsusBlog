#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

ACTION="${1:-}"
[[ -n "$ACTION" ]] || slot_fail "usage: zero-downtime-topology.sh <up|down|status> [options]"
shift

SOURCE_MANIFEST=""
SOURCE_SLOT="blue"
WORK_DIR="${FSUSBLOG_REHEARSAL_WORK_DIR:-$ROOT_DIR/.tmp/zero-downtime-rehearsal}"
PUBLIC_PORT="${FSUSBLOG_REHEARSAL_PUBLIC_PORT:-18080}"
INFRA_COMPOSE="$ROOT_DIR/ops/docker/docker-compose.zero-downtime.yml"
STATE_FILE_EXPLICIT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || slot_fail "--env-file requires a path"; PRODUCTION_ENV_FILE="$2"; shift 2 ;;
    --source-manifest) [[ $# -ge 2 ]] || slot_fail "--source-manifest requires a path"; SOURCE_MANIFEST="$2"; shift 2 ;;
    --source-slot) [[ $# -ge 2 ]] || slot_fail "--source-slot requires blue or green"; SOURCE_SLOT="$2"; shift 2 ;;
    --work-dir) [[ $# -ge 2 ]] || slot_fail "--work-dir requires a path"; WORK_DIR="$2"; shift 2 ;;
    --public-port) [[ $# -ge 2 ]] || slot_fail "--public-port requires a value"; PUBLIC_PORT="$2"; shift 2 ;;
    --state-file) [[ $# -ge 2 ]] || slot_fail "--state-file requires a path"; SLOT_STATE_FILE="$2"; STATE_FILE_EXPLICIT=1; shift 2 ;;
    *) slot_fail "unknown argument: $1" ;;
  esac
done

slot_require "$SOURCE_SLOT"
[[ "$PUBLIC_PORT" =~ ^[0-9]+$ && "$PUBLIC_PORT" -ge 1024 && "$PUBLIC_PORT" -le 65535 ]] || slot_fail "public port is invalid"
WORK_DIR="$(realpath -m "$WORK_DIR")"
if [[ "$STATE_FILE_EXPLICIT" == "0" && -z "${FSUSBLOG_REHEARSAL_SLOT_STATE_FILE:-}" ]]; then
  SLOT_STATE_FILE="$WORK_DIR/slots.json"
fi
work_identity="$(node -e 'const { createHash } = require("node:crypto"); process.stdout.write(createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 16))' "$WORK_DIR")"
release_asset_store="${FSUSBLOG_REHEARSAL_RELEASE_ASSET_STORE:-$WORK_DIR/release-assets}"
release_derived_volume="${FSUSBLOG_REHEARSAL_RELEASE_DERIVED_VOLUME:-fsusblog-zdt-derived-$work_identity}"
gateway_dir="$WORK_DIR/gateway"
gateway_config="$gateway_dir/openresty.conf"
active_upstream="$gateway_dir/active-upstream.conf"
admin_header="$WORK_DIR/secrets/admin-header.txt"

export FSUSBLOG_REHEARSAL_GATEWAY_DIR="$gateway_dir"
export FSUSBLOG_REHEARSAL_GATEWAY_CONFIG="$gateway_config"
export FSUSBLOG_GATEWAY_ACTIVE_UPSTREAM="$active_upstream"
export FSUSBLOG_GATEWAY_CONFIG_FILE="$gateway_config"
export FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL="http://127.0.0.1:$PUBLIC_PORT/health/ready"
export FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE=1
export FSUSBLOG_OPENRESTY_BIN="$ROOT_DIR/tools/deployment/rehearsal-openresty.sh"
export FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN="http://127.0.0.1:$PUBLIC_PORT"
export FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE="$admin_header"
export FSUSBLOG_SLOT_STATE_FILE="$SLOT_STATE_FILE"
export FSUSBLOG_DEPLOYMENT_LOCK_FILE="$WORK_DIR/deployment.lock"
export FSUSBLOG_GATEWAY_EVIDENCE_DIR="$WORK_DIR/gateway-evidence"
export FSUSBLOG_RELEASE_ASSET_STORE="$release_asset_store"
export FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME="$release_derived_volume"

infra_compose() {
  docker compose --env-file "$PRODUCTION_ENV_FILE" -f "$INFRA_COMPOSE" -p fsusblog-zdt "$@"
}

case "$ACTION" in
  up)
    [[ -f "$PRODUCTION_ENV_FILE" ]] || slot_fail "rehearsal env file is missing"
    [[ -f "$SOURCE_MANIFEST" ]] || slot_fail "source manifest is required"
    [[ "$WORK_DIR" == "$ROOT_DIR/.tmp/"* ]] || slot_fail "rehearsal work dir must stay under repository .tmp"
    [[ "$(slot_env_optional_value SITE_BASEURL "$PRODUCTION_ENV_FILE")" =~ ^http://(127\.0\.0\.1|localhost):$PUBLIC_PORT$ ]] \
      || slot_fail "rehearsal SITE_BASEURL must be the local public port"
    mkdir -p "$gateway_dir" "$WORK_DIR/secrets" "$WORK_DIR/gateway-evidence" "$release_asset_store"
    chmod 0755 "$release_asset_store"
    [[ -f "$admin_header" ]] || slot_fail "generate a 0400/0600 local admin header at $admin_header before topology startup"
    mode="$(stat -c '%a' "$admin_header")"
    [[ "$mode" == "400" || "$mode" == "600" ]] || slot_fail "rehearsal admin header must be mode 0400 or 0600"
    sed \
      -e "s|@@GATEWAY_DIR@@|$gateway_dir|g" \
      -e "s|@@ACTIVE_UPSTREAM@@|$active_upstream|g" \
      -e "s|@@PUBLIC_PORT@@|$PUBLIC_PORT|g" \
      "$ROOT_DIR/deploy/zero-downtime-openresty.conf.template" >"$gateway_config"
    docker network inspect fsus-infra-network >/dev/null 2>&1 || docker network create fsus-infra-network >/dev/null
    for volume in \
      "$(slot_env_value FSUSBLOG_SHARED_UPLOADS_VOLUME "$PRODUCTION_ENV_FILE")" \
      "$(slot_env_value FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME "$PRODUCTION_ENV_FILE")"; do
      docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create "$volume" >/dev/null
    done
    infra_compose up -d postgres redis
    node "$ROOT_DIR/tools/deployment/slot-state.mjs" ensure --state "$SLOT_STATE_FILE" >/dev/null
    node "$ROOT_DIR/tools/storage/materialize-release-assets.mjs" \
      --release-manifest "$SOURCE_MANIFEST" \
      --slot "$SOURCE_SLOT" \
      --store "$release_asset_store" \
      --out "$WORK_DIR/source-asset-materialization.json" >/dev/null
    jq -e --arg slot "$SOURCE_SLOT" '
      .schema == "fsusblog.release-assets.materialization.v1"
      and .status == "ok"
      and .dryRun == false
      and .slot == $slot
      and (.releaseId | type == "string" and length > 0)
      and (.assets | type == "array" and length > 0)
      and (.errors | type == "array" and length == 0)
    ' "$WORK_DIR/source-asset-materialization.json" >/dev/null \
      || slot_fail "source release asset materialization failed"
    FSUSBLOG_DEPLOYMENT_BOOTSTRAP=1 "$ROOT_DIR/tools/deployment/slot-start.sh" --slot "$SOURCE_SLOT" --release-manifest "$SOURCE_MANIFEST" \
      --env-file "$PRODUCTION_ENV_FILE" --state-file "$SLOT_STATE_FILE" >/dev/null
    source_state="$(slot_state_read --slot "$SOURCE_SLOT")"
    source_generation="$(jq -r '.record.deploymentGeneration' <<< "$source_state")"
    source_release="$(jq -r '.record.releaseId' <<< "$source_state")"
    source_digest="$(jq -r '.record.imageDigest' <<< "$source_state")"
    source_port="$([[ "$SOURCE_SLOT" == "blue" ]] && printf '%s' "${FSUSBLOG_BLUE_PORT:-8081}" || printf '%s' "${FSUSBLOG_GREEN_PORT:-8082}")"
    "$ROOT_DIR/tools/deployment/deployment-control.sh" activate --slot "$SOURCE_SLOT" --release "$source_release" \
      --generation "$source_generation" --port "$source_port" --admin-header-file "$admin_header" \
      --origin "$FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN" >/dev/null
    node "$ROOT_DIR/tools/deployment/slot-state.mjs" set-active --state "$SLOT_STATE_FILE" --slot "$SOURCE_SLOT" --kind initialize >/dev/null
    node "$ROOT_DIR/tools/deployment/gateway-control.mjs" initialize --active "$active_upstream" --slot "$SOURCE_SLOT" >/dev/null
    infra_compose up -d openresty
    node "$ROOT_DIR/tools/deployment/active-release-fence.mjs" acquire --port "$source_port" \
      --release "$source_release" --slot "$SOURCE_SLOT" --generation "$source_generation" --digest "$source_digest" \
      --admin-header-file "$admin_header" --origin "$FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN" \
      --out "$WORK_DIR/active-fence-initialize.json" >/dev/null
    curl -fsS --max-time 20 "$FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL" >/dev/null
    "$0" status --env-file "$PRODUCTION_ENV_FILE" --work-dir "$WORK_DIR" --public-port "$PUBLIC_PORT" --state-file "$SLOT_STATE_FILE"
    ;;
  down)
    for slot in blue green; do
      if [[ -f "$SLOT_STATE_FILE" ]]; then
        state="$(slot_state_read 2>/dev/null || true)"
        active="$(jq -r '.activeSlot // ""' <<< "$state" 2>/dev/null || true)"
        if [[ "$active" == "$slot" ]]; then
          node "$ROOT_DIR/tools/deployment/slot-state.mjs" set-active --state "$SLOT_STATE_FILE" --slot "$([[ "$slot" == "blue" ]] && printf green || printf blue)" --kind teardown >/dev/null 2>&1 || true
        fi
      fi
      slot_configure "$slot"
      slot_compose down --remove-orphans >/dev/null 2>&1 || true
    done
    [[ -f "$PRODUCTION_ENV_FILE" ]] && infra_compose down -v --remove-orphans >/dev/null 2>&1 || true
    docker volume rm -f "$release_derived_volume" >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR"
    ;;
  status)
    slot_status="$("$ROOT_DIR/tools/deployment/slot-status.sh" --state-file "$SLOT_STATE_FILE" 2>/dev/null || printf null)"
    infra_status="$(infra_compose ps --format json 2>/dev/null | jq -s . || printf '[]')"
    public_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL" || printf 000)"
    jq -cn --argjson slots "$slot_status" --argjson infrastructure "$infra_status" --arg publicHttpStatus "$public_status" \
      --arg workDir "$WORK_DIR" --arg releaseAssetStore "$release_asset_store" --arg releaseDerivedVolume "$release_derived_volume" \
      '{schema:"fsusblog.zero-downtime-topology.v1",workDir:$workDir,releaseAssetStore:$releaseAssetStore,releaseDerivedVolume:$releaseDerivedVolume,slots:$slots,infrastructure:$infrastructure,publicHttpStatus:$publicHttpStatus}'
    ;;
  *) slot_fail "action must be up, down or status" ;;
esac
