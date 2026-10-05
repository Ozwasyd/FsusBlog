#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SLOT_STATE_FILE="${FSUSBLOG_SLOT_STATE_FILE:-/var/lib/fsusblog/deployment/slots.json}"
PRODUCTION_ENV_FILE="${FSUSBLOG_PRODUCTION_ENV_FILE:-$ROOT_DIR/.env.production}"
COMPOSE_FILE="${FSUSBLOG_PRODUCTION_COMPOSE_FILE:-$ROOT_DIR/ops/docker/docker-compose.production.yml}"
DEPLOYMENT_LOCK_FILE="${FSUSBLOG_DEPLOYMENT_LOCK_FILE:-/var/lock/fsusblog-deployment.lock}"

SlotLog() {
    printf '[deployment-slot] %s\n' "$1"
}

SlotFail() {
    printf '[deployment-slot] fatal: %s\n' "$1" >&2
    exit 1
}

SlotRequireCommand() {
    command -v "$1" >/dev/null 2>&1 || SlotFail "missing required command: $1"
}

SlotRequire() {
    case "${1:-}" in
        blue | green) ;;
        *) SlotFail "slot must be blue or green" ;;
    esac
}

SlotAcquireDeploymentLock() {
    SlotRequireCommand flock
    local inheritedFd="${FSUSBLOG_DEPLOYMENT_LOCK_FD:-}"
    if [[ -n "$inheritedFd" ]]; then
        [[ "$inheritedFd" =~ ^[0-9]+$ && -e "/proc/$$/fd/$inheritedFd" ]] ||
            SlotFail "inherited deployment lock descriptor is invalid"
        SlotRequireCommand readlink
        local inheritedPath expectedPath
        inheritedPath="$(readlink -f "/proc/$$/fd/$inheritedFd")"
        expectedPath="$(readlink -f "$DEPLOYMENT_LOCK_FILE")"
        [[ "$inheritedPath" == "$expectedPath" ]] ||
            SlotFail "inherited deployment lock descriptor targets the wrong file"
        flock -n "$inheritedFd" ||
            SlotFail "inherited deployment lock is not held"
        return
    fi
    mkdir -p "$(dirname "$DEPLOYMENT_LOCK_FILE")"
    exec 9>"$DEPLOYMENT_LOCK_FILE"
    flock -n 9 || SlotFail "another deployment or gateway transition holds $DEPLOYMENT_LOCK_FILE"
}

SlotEnvValue() {
    local key="$1"
    local file="${2:-$PRODUCTION_ENV_FILE}"
    [[ -f "$file" ]] || SlotFail "production env file not found: $file"
    local value
    value="$(awk -v wanted="$key" '
    /^[[:space:]]*(#|$)/ { next }
    {
      line=$0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      split(line, parts, "=")
      name=parts[1]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == wanted) {
        value=substr(line, index(line, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        print value
        exit
      }
    }' "$file")"
    if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
    fi
    [[ -n "$value" && "$value" != *CHANGE_ME* && "$value" != *TODO* && "$value" != *placeholder* ]] ||
        SlotFail "$key must be an explicit non-placeholder value in $file"
    printf '%s\n' "$value"
}

SlotEnvOptionalValue() {
    local key="$1"
    local file="${2:-$PRODUCTION_ENV_FILE}"
    [[ -f "$file" ]] || SlotFail "production env file not found: $file"
    local value
    value="$(awk -v wanted="$key" '
    /^[[:space:]]*(#|$)/ { next }
    {
      line=$0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      split(line, parts, "=")
      name=parts[1]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == wanted) {
        value=substr(line, index(line, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        print value
        exit
      }
    }' "$file")"
    if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
    fi
    printf '%s\n' "$value"
}

SlotDurationSeconds() {
    local value="$1"
    if [[ "$value" =~ ^([0-9]+)$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
    elif [[ "$value" =~ ^([0-9]+)s$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
    elif [[ "$value" =~ ^([0-9]+)m$ ]]; then
        printf '%s\n' "$((BASH_REMATCH[1] * 60))"
    elif [[ "$value" =~ ^([0-9]+)h$ ]]; then
        printf '%s\n' "$((BASH_REMATCH[1] * 3600))"
    else
        return 1
    fi
}

SlotConfigure() {
    local slot="$1"
    local bluePort="${FSUSBLOG_BLUE_PORT:-8081}"
    local greenPort="${FSUSBLOG_GREEN_PORT:-8082}"
    SlotRequire "$slot"
    [[ "$bluePort" =~ ^[0-9]+$ && "$bluePort" -ge 1 && "$bluePort" -le 65535 ]] || SlotFail "FSUSBLOG_BLUE_PORT is invalid"
    [[ "$greenPort" =~ ^[0-9]+$ && "$greenPort" -ge 1 && "$greenPort" -le 65535 ]] || SlotFail "FSUSBLOG_GREEN_PORT is invalid"
    [[ "$bluePort" != "$greenPort" ]] || SlotFail "blue and green ports must be different"

    export FSUSBLOG_RELEASE_SLOT="$slot"
    FSUSBLOG_SLOT_PORT="$([[ "$slot" == "blue" ]] && printf '%s' "$bluePort" || printf '%s' "$greenPort")"
    export FSUSBLOG_SLOT_PORT
    export FSUSBLOG_COMPOSE_PROJECT_NAME="fsusblog-$slot"
    export FSUSBLOG_CONTAINER_NAME="fsus-app-$slot"
    export FSUSBLOG_SLOT_AOT_CACHE_VOLUME="fsusblog-aot-cache-$slot"
    export FSUSBLOG_SLOT_LOGS_VOLUME="fsusblog-logs-$slot"
    export FSUSBLOG_SLOT_DATA_VOLUME="fsusblog-data-$slot"
}

SlotLoadManifest() {
    local manifest="$1"
    local slot="$2"
    [[ -f "$manifest" ]] || SlotFail "release manifest not found: $manifest"
    local output
    output="$(node "$ROOT_DIR/tools/release/check-release-manifest.mjs" \
        --manifest "$manifest" \
        --slot "$slot" \
        --format lines)" || SlotFail "release manifest validation failed"
    local -a fields=()
    mapfile -t fields <<<"$output"
    [[ "${#fields[@]}" -eq 7 ]] || SlotFail "release manifest validator returned incomplete fields"
    export FSUSBLOG_RELEASE_ID="${fields[0]}"
    export FSUSBLOG_RELEASE_CREATED_AT_UTC="${fields[1]}"
    export FSUSBLOG_COMMIT_SHA="${fields[2]}"
    export FSUSBLOG_RELEASE_SLOT="${fields[3]}"
    export FSUSBLOG_IMAGE_REF="${fields[4]}"
    export FSUSBLOG_IMAGE_TAG="${fields[5]}"
    export FSUSBLOG_IMAGE_DIGEST="${fields[6]}"
}

SlotStateRead() {
    node "$ROOT_DIR/tools/deployment/slot-state.mjs" read --state "$SLOT_STATE_FILE" "$@"
}

SlotStateReadCurrent() {
    node "$ROOT_DIR/tools/deployment/slot-state.mjs" read --state "$SLOT_STATE_FILE"
}

SlotStateRecordFailure() {
    local slot="$1"
    local operation="$2"
    local message="$3"
    local -a args=(record-failure --state "$SLOT_STATE_FILE" --slot "$slot" --operation "$operation" --message "$message")
    [[ -n "${FSUSBLOG_RELEASE_ID:-}" ]] && args+=(--release-id "$FSUSBLOG_RELEASE_ID")
    node "$ROOT_DIR/tools/deployment/slot-state.mjs" "${args[@]}" >/dev/null
}

SlotCompose() {
    docker compose \
        --env-file "$PRODUCTION_ENV_FILE" \
        -f "$COMPOSE_FILE" \
        -p "$FSUSBLOG_COMPOSE_PROJECT_NAME" \
        "$@"
}

SlotPortListening() {
    local port="$1"
    ss -H -ltn 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix "$" { found=1 } END { exit(found ? 0 : 1) }'
}
