#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${FSUSBLOG_PRODUCTION_ENV_FILE:-$ROOT_DIR/.env.production}"
COMPOSE_FILE="${FSUSBLOG_PRODUCTION_COMPOSE_FILE:-$ROOT_DIR/ops/docker/docker-compose.yml}"
DRY_RUN=0
SKIP_BUILD=0
SKIP_UP=0
SKIP_ZK_RELEASE_CHECK="${FSUSBLOG_DEPLOY_SKIP_ZK_RELEASE_CHECK:-0}"

HOST_TRUSTED_SETUP_MANIFEST=""
HOST_VERIFYING_KEY_MANIFEST=""
HOST_GROTH16_VERIFYING_KEY=""
HOST_ISSUER_PUBLIC_KEY=""
HOST_ISSUER_PRIVATE_KEY=""

log() {
  printf '[deploy-production] %s\n' "$1"
}

fail() {
  printf '[deploy-production] fatal: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: tools/deploy-production.sh [options]

Options:
  --env-file <path>              Production env file. Defaults to .env.production.
  --dry-run                      Validate inputs and print commands without executing them.
  --skip-build                   Skip tools/build-final-image.sh.
  --skip-up                      Run checks and docker compose config, but do not start containers.
  --skip-zk-release-check        Skip the ZK-Prod release gate. Use only for a documented rollback.
  -h, --help                     Show this help.

This is the one-command production deploy entrypoint:
  1. Load .env.production without executing it as shell code.
  2. Guide and block on missing real anonymous/ZK production material.
  3. Run npm --prefix src/frontend run check:privacy-zk-prod-release.
  4. Build the final image with tools/build-final-image.sh.
  5. Run docker compose --env-file .env.production config and up -d.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || fail "--env-file requires a path"
      ENV_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-up)
      SKIP_UP=1
      shift
      ;;
    --skip-zk-release-check)
      SKIP_ZK_RELEASE_CHECK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "missing required command: $1"
  fi
}

print_command() {
  local first=1
  for arg in "$@"; do
    if [[ $first -eq 0 ]]; then
      printf ' '
    fi
    first=0
    printf '%q' "$arg"
  done
  printf '\n'
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[deploy-production] dry-run command: '
    print_command "$@"
    return 0
  fi

  "$@"
}

load_env_file() {
  [[ -f "$ENV_FILE" ]] || {
    printf '[deploy-production] missing %s\n' "$ENV_FILE" >&2
    printf '[deploy-production] create it with:\n' >&2
    printf '  cp .env.production-template .env.production\n' >&2
    printf '  $EDITOR .env.production\n' >&2
    printf '[deploy-production] then fill every CHANGE_ME value and the ZK material directories.\n' >&2
    exit 1
  }

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" == export\ * ]]; then
      line="${line#export }"
    fi
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "invalid env key in $ENV_FILE: $key"
    if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$ENV_FILE"
}

is_placeholder_value() {
  local value="${1:-}"
  [[ -z "$value" ]] && return 0
  [[ "$value" == *CHANGE_ME* ]] && return 0
  [[ "$value" == *TODO* ]] && return 0
  [[ "$value" == *TBD* ]] && return 0
  [[ "$value" == *placeholder* ]] && return 0
  return 1
}

require_env_value() {
  local name="$1"
  local value="${!name:-}"
  if is_placeholder_value "$value"; then
    printf '[deploy-production] missing or placeholder env: %s\n' "$name" >&2
    return 1
  fi
  return 0
}

require_env_equals() {
  local name="$1"
  local expected="$2"
  local value="${!name:-}"
  if [[ "$value" != "$expected" ]]; then
    printf '[deploy-production] %s must be %s, got %s\n' "$name" "$expected" "${value:-<empty>}" >&2
    return 1
  fi
  return 0
}

is_sha256_hex() {
  [[ "${1:-}" =~ ^[0-9a-fA-F]{64}$ ]]
}

require_sha256_env() {
  local name="$1"
  local value="${!name:-}"
  if ! is_sha256_hex "$value"; then
    printf '[deploy-production] %s must be a 64-char hex SHA-256 digest\n' "$name" >&2
    return 1
  fi
  return 0
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    fail "missing required command: sha256sum or shasum"
  fi
}

resolve_host_path() {
  local container_path="$1"
  local container_prefix="$2"
  local host_dir="$3"
  local label="$4"

  if [[ "$container_path" != "$container_prefix"* ]]; then
    fail "$label must point under $container_prefix inside the container: $container_path"
  fi

  local suffix="${container_path#"$container_prefix"}"
  printf '%s/%s\n' "${host_dir%/}" "$suffix"
}

require_file() {
  local label="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    printf '[deploy-production] missing %s: %s\n' "$label" "$file" >&2
    return 1
  fi
  return 0
}

guide_zk_materials() {
  cat >&2 <<'GUIDE'
[deploy-production] ZK-Prod is default-on and fail-closed. Complete these before deploy:
  1. Mount real non-repo material directories:
     FSUSBLOG_ZK_CONFIG_DIR=/srv/fsusblog/zk/config
     FSUSBLOG_ZK_SECRET_DIR=/srv/fsusblog/zk/secrets
  2. Put public config material in FSUSBLOG_ZK_CONFIG_DIR:
     comment-v2-trusted-setup.manifest.json
     anonymous-comment-v2-verifying-key.manifest.json
     comment.v2.vk
     issuer-public.key
  3. Put private material in FSUSBLOG_ZK_SECRET_DIR:
     issuer-private.key
  4. Generate root bootstrap evidence after rotating the production/staging root:
     node tools/security/bootstrap-anonymous-credential-root.mjs --input <root-input.json> --evidence .tmp/security/anonymous-credential-root-bootstrap.json
  5. Generate real smoke evidence, then run:
     npm --prefix src/frontend run check:privacy-zk-prod-smoke
     npm --prefix src/frontend run check:privacy-zk-prod-release
GUIDE
}

validate_env() {
  local failed=0
  local required=(
    EXTERNAL_DB_HOST
    EXTERNAL_REDIS_HOST
    DB_USER
    DB_PASSWORD
    DB_NAME
    REDIS_PASSWORD
    Jwt__SecretKey
    SITE_BASEURL
    CORS_ALLOWED_HOSTS
    APP_ALLOWED_HOSTS
    FIDO2_SERVER_DOMAIN
    FSUSBLOG_ZK_CONFIG_DIR
    FSUSBLOG_ZK_SECRET_DIR
    FSUSBLOG_ZK_VERIFYING_KEY_HASH
    FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST
    FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST
    FSUSBLOG_ZK_GROTH16_VERIFYING_KEY
    FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_ID
    FSUSBLOG_ZK_ISSUER_PUBLIC_KEY
    FSUSBLOG_ZK_ISSUER_PRIVATE_KEY
    FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH
  )

  local name
  for name in "${required[@]}"; do
    require_env_value "$name" || failed=1
  done

  require_env_equals FSUSBLOG_ANONYMOUS_IDENTITY_MODE 1 || failed=1
  require_env_equals FSUSBLOG_ZK_PROD_ENABLED true || failed=1
  require_env_equals FSUSBLOG_ZK_TRUSTED_SETUP_VERIFIED true || failed=1
  require_env_equals FSUSBLOG_ZK_CREDENTIAL_READY true || failed=1
  require_sha256_env FSUSBLOG_ZK_VERIFYING_KEY_HASH || failed=1
  require_sha256_env FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH || failed=1
  if is_placeholder_value "${REVERSE_PROXY_KNOWN_PROXIES:-}" && is_placeholder_value "${REVERSE_PROXY_KNOWN_NETWORKS:-}"; then
    printf '[deploy-production] set REVERSE_PROXY_KNOWN_PROXIES or REVERSE_PROXY_KNOWN_NETWORKS\n' >&2
    failed=1
  fi

  [[ -d "${FSUSBLOG_ZK_CONFIG_DIR:-}" ]] || {
    printf '[deploy-production] missing ZK config directory: %s\n' "${FSUSBLOG_ZK_CONFIG_DIR:-<empty>}" >&2
    failed=1
  }
  [[ -d "${FSUSBLOG_ZK_SECRET_DIR:-}" ]] || {
    printf '[deploy-production] missing ZK secret directory: %s\n' "${FSUSBLOG_ZK_SECRET_DIR:-<empty>}" >&2
    failed=1
  }

  if [[ "$failed" == "1" ]]; then
    guide_zk_materials
    exit 1
  fi
}

validate_zk_files() {
  HOST_TRUSTED_SETUP_MANIFEST="$(resolve_host_path "$FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST")"
  HOST_VERIFYING_KEY_MANIFEST="$(resolve_host_path "$FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST")"
  HOST_GROTH16_VERIFYING_KEY="$(resolve_host_path "$FSUSBLOG_ZK_GROTH16_VERIFYING_KEY" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_GROTH16_VERIFYING_KEY")"
  HOST_ISSUER_PUBLIC_KEY="$(resolve_host_path "$FSUSBLOG_ZK_ISSUER_PUBLIC_KEY" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_ISSUER_PUBLIC_KEY")"
  HOST_ISSUER_PRIVATE_KEY="$(resolve_host_path "$FSUSBLOG_ZK_ISSUER_PRIVATE_KEY" "/app/secrets/zk/" "$FSUSBLOG_ZK_SECRET_DIR" "FSUSBLOG_ZK_ISSUER_PRIVATE_KEY")"

  local failed=0
  require_file "trusted setup manifest" "$HOST_TRUSTED_SETUP_MANIFEST" || failed=1
  require_file "verifying key manifest" "$HOST_VERIFYING_KEY_MANIFEST" || failed=1
  require_file "Groth16 verifying key" "$HOST_GROTH16_VERIFYING_KEY" || failed=1
  require_file "issuer public key" "$HOST_ISSUER_PUBLIC_KEY" || failed=1
  require_file "issuer private key" "$HOST_ISSUER_PRIVATE_KEY" || failed=1

  if [[ "$failed" == "1" ]]; then
    guide_zk_materials
    exit 1
  fi

  local vk_sha issuer_sha expected_vk_sha expected_issuer_sha
  vk_sha="$(sha256_file "$HOST_GROTH16_VERIFYING_KEY")"
  issuer_sha="$(sha256_file "$HOST_ISSUER_PUBLIC_KEY")"
  expected_vk_sha="$(printf '%s' "$FSUSBLOG_ZK_VERIFYING_KEY_HASH" | tr '[:upper:]' '[:lower:]')"
  expected_issuer_sha="$(printf '%s' "$FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH" | tr '[:upper:]' '[:lower:]')"
  if [[ "$vk_sha" != "$expected_vk_sha" ]]; then
    fail "FSUSBLOG_ZK_VERIFYING_KEY_HASH does not match $HOST_GROTH16_VERIFYING_KEY"
  fi
  if [[ "$issuer_sha" != "$expected_issuer_sha" ]]; then
    fail "FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH does not match $HOST_ISSUER_PUBLIC_KEY"
  fi
}

run_zk_release_gate() {
  if [[ "$SKIP_ZK_RELEASE_CHECK" == "1" ]]; then
    log "skip ZK-Prod release gate by request; this is only acceptable for a documented rollback"
    return 0
  fi

  local smoke_evidence="${FSUSBLOG_ZK_PROD_SMOKE_EVIDENCE:-.tmp/security/privacy-zk-prod-smoke.json}"
  local root_evidence="${FSUSBLOG_ZK_ROOT_BOOTSTRAP_EVIDENCE:-.tmp/security/anonymous-credential-root-bootstrap.json}"

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[deploy-production] dry-run command: '
    print_command env \
      FSUSBLOG_ZK_NATIVE_VERIFIER_LIB="${FSUSBLOG_ZK_NATIVE_VERIFIER_LIB:-managed:mcl}" \
      FSUSBLOG_ZK_VERIFYING_KEY_HASH="$FSUSBLOG_ZK_VERIFYING_KEY_HASH" \
      FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST="$HOST_TRUSTED_SETUP_MANIFEST" \
      FSUSBLOG_ZK_ISSUER_PUBLIC_KEY="$HOST_ISSUER_PUBLIC_KEY" \
      FSUSBLOG_ZK_ISSUER_PRIVATE_KEY="$HOST_ISSUER_PRIVATE_KEY" \
      npm --prefix src/frontend run check:privacy-zk-prod-release -- \
      --require-enabled \
      --trusted-setup-manifest "$HOST_TRUSTED_SETUP_MANIFEST" \
      --smoke-evidence "$smoke_evidence" \
      --root-bootstrap-evidence "$root_evidence"
    return 0
  fi

  env \
    FSUSBLOG_ZK_NATIVE_VERIFIER_LIB="${FSUSBLOG_ZK_NATIVE_VERIFIER_LIB:-managed:mcl}" \
    FSUSBLOG_ZK_VERIFYING_KEY_HASH="$FSUSBLOG_ZK_VERIFYING_KEY_HASH" \
    FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST="$HOST_TRUSTED_SETUP_MANIFEST" \
    FSUSBLOG_ZK_ISSUER_PUBLIC_KEY="$HOST_ISSUER_PUBLIC_KEY" \
    FSUSBLOG_ZK_ISSUER_PRIVATE_KEY="$HOST_ISSUER_PRIVATE_KEY" \
    npm --prefix src/frontend run check:privacy-zk-prod-release -- \
      --require-enabled \
      --trusted-setup-manifest "$HOST_TRUSTED_SETUP_MANIFEST" \
      --smoke-evidence "$smoke_evidence" \
      --root-bootstrap-evidence "$root_evidence"
}

main() {
  if [[ "$DRY_RUN" != "1" ]]; then
    require_command docker
    require_command npm
  fi

  cd "$ROOT_DIR"
  ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
  COMPOSE_FILE="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)/$(basename "$COMPOSE_FILE")"

  load_env_file
  validate_env
  validate_zk_files
  run_zk_release_gate

  if [[ "$SKIP_BUILD" != "1" ]]; then
    run_cmd "$ROOT_DIR/tools/build-final-image.sh"
  else
    log "skip image build"
  fi

  run_cmd docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config

  if [[ "$SKIP_UP" == "1" ]]; then
    log "skip docker compose up"
    return 0
  fi

  run_cmd docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run complete"
  else
    log "deploy complete"
  fi
}

main "$@"
