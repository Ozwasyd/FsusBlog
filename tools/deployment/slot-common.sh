#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SLOT_STATE_FILE="${FSUSBLOG_SLOT_STATE_FILE:-/var/lib/fsusblog/deployment/slots.json}"
PRODUCTION_ENV_FILE="${FSUSBLOG_PRODUCTION_ENV_FILE:-$ROOT_DIR/.env.production}"
COMPOSE_FILE="${FSUSBLOG_PRODUCTION_COMPOSE_FILE:-$ROOT_DIR/ops/docker/docker-compose.yml}"
DEPLOYMENT_LOCK_FILE="${FSUSBLOG_DEPLOYMENT_LOCK_FILE:-/var/lock/fsusblog-deployment.lock}"

slot_log() {
  printf '[deployment-slot] %s\n' "$1"
}

slot_fail() {
  printf '[deployment-slot] fatal: %s\n' "$1" >&2
  exit 1
}

slot_require_command() {
  command -v "$1" >/dev/null 2>&1 || slot_fail "missing required command: $1"
}

slot_require() {
  case "${1:-}" in
    blue|green) ;;
    *) slot_fail "slot must be blue or green" ;;
  esac
}

slot_acquire_deployment_lock() {
  slot_require_command flock
  local inherited_fd="${FSUSBLOG_DEPLOYMENT_LOCK_FD:-}"
  if [[ -n "$inherited_fd" ]]; then
    [[ "$inherited_fd" =~ ^[0-9]+$ && -e "/proc/$$/fd/$inherited_fd" ]] \
      || slot_fail "inherited deployment lock descriptor is invalid"
    slot_require_command readlink
    local inherited_path expected_path
    inherited_path="$(readlink -f "/proc/$$/fd/$inherited_fd")"
    expected_path="$(readlink -f "$DEPLOYMENT_LOCK_FILE")"
    [[ "$inherited_path" == "$expected_path" ]] \
      || slot_fail "inherited deployment lock descriptor targets the wrong file"
    flock -n "$inherited_fd" \
      || slot_fail "inherited deployment lock is not held"
    return
  fi
  mkdir -p "$(dirname "$DEPLOYMENT_LOCK_FILE")"
  exec 9>"$DEPLOYMENT_LOCK_FILE"
  flock -n 9 || slot_fail "another deployment or gateway transition holds $DEPLOYMENT_LOCK_FILE"
}

slot_env_value() {
  local key="$1"
  local file="${2:-$PRODUCTION_ENV_FILE}"
  [[ -f "$file" ]] || slot_fail "production env file not found: $file"
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
  [[ -n "$value" && "$value" != *CHANGE_ME* && "$value" != *TODO* && "$value" != *placeholder* ]] \
    || slot_fail "$key must be an explicit non-placeholder value in $file"
  printf '%s\n' "$value"
}

slot_env_optional_value() {
  local key="$1"
  local file="${2:-$PRODUCTION_ENV_FILE}"
  [[ -f "$file" ]] || slot_fail "production env file not found: $file"
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

slot_duration_seconds() {
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

slot_configure() {
  local slot="$1"
  local blue_port="${FSUSBLOG_BLUE_PORT:-8081}"
  local green_port="${FSUSBLOG_GREEN_PORT:-8082}"
  slot_require "$slot"
  [[ "$blue_port" =~ ^[0-9]+$ && "$blue_port" -ge 1 && "$blue_port" -le 65535 ]] || slot_fail "FSUSBLOG_BLUE_PORT is invalid"
  [[ "$green_port" =~ ^[0-9]+$ && "$green_port" -ge 1 && "$green_port" -le 65535 ]] || slot_fail "FSUSBLOG_GREEN_PORT is invalid"
  [[ "$blue_port" != "$green_port" ]] || slot_fail "blue and green ports must be different"

  export FSUSBLOG_RELEASE_SLOT="$slot"
  export FSUSBLOG_SLOT_PORT="$([[ "$slot" == "blue" ]] && printf '%s' "$blue_port" || printf '%s' "$green_port")"
  export FSUSBLOG_COMPOSE_PROJECT_NAME="fsusblog-$slot"
  export FSUSBLOG_CONTAINER_NAME="fsus-app-$slot"
  export FSUSBLOG_SLOT_AOT_CACHE_VOLUME="fsusblog-aot-cache-$slot"
  export FSUSBLOG_SLOT_LOGS_VOLUME="fsusblog-logs-$slot"
  export FSUSBLOG_SLOT_DATA_VOLUME="fsusblog-data-$slot"
}

slot_load_manifest() {
  local manifest="$1"
  local slot="$2"
  [[ -f "$manifest" ]] || slot_fail "release manifest not found: $manifest"
  local output
  output="$(node "$ROOT_DIR/tools/release/check-release-manifest.mjs" \
    --manifest "$manifest" \
    --slot "$slot" \
    --format lines)" || slot_fail "release manifest validation failed"
  local -a fields=()
  mapfile -t fields <<< "$output"
  [[ "${#fields[@]}" -eq 7 ]] || slot_fail "release manifest validator returned incomplete fields"
  export FSUSBLOG_RELEASE_ID="${fields[0]}"
  export FSUSBLOG_COMMIT_SHA="${fields[1]}"
  export FSUSBLOG_RELEASE_SLOT="${fields[2]}"
  export FSUSBLOG_IMAGE_REF="${fields[3]}"
  export FSUSBLOG_IMAGE_TAG="${fields[4]}"
  export FSUSBLOG_IMAGE_DIGEST="${fields[5]}"
  export FSUSBLOG_ROLLBACK_TARGET="${fields[6]}"
}

slot_state_read() {
  node "$ROOT_DIR/tools/deployment/slot-state.mjs" read --state "$SLOT_STATE_FILE" "$@"
}

slot_state_record_failure() {
  local slot="$1"
  local operation="$2"
  local message="$3"
  local -a args=(record-failure --state "$SLOT_STATE_FILE" --slot "$slot" --operation "$operation" --message "$message")
  [[ -n "${FSUSBLOG_RELEASE_ID:-}" ]] && args+=(--release-id "$FSUSBLOG_RELEASE_ID")
  node "$ROOT_DIR/tools/deployment/slot-state.mjs" "${args[@]}" >/dev/null
}

slot_compose() {
  docker compose \
    --env-file "$PRODUCTION_ENV_FILE" \
    -f "$COMPOSE_FILE" \
    -p "$FSUSBLOG_COMPOSE_PROJECT_NAME" \
    "$@"
}

slot_port_listening() {
  local port="$1"
  ss -H -ltn 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix "$" { found=1 } END { exit(found ? 0 : 1) }'
}
