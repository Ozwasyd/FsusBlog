#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${FSUSBLOG_PRODUCTION_ENV_FILE:-$ROOT_DIR/.env.production}"
COMPOSE_FILE="${FSUSBLOG_PRODUCTION_COMPOSE_FILE:-$ROOT_DIR/ops/docker/docker-compose.production.yml}"
DRY_RUN=0
SKIP_UP=0
RELEASE_MANIFEST="${FSUSBLOG_RELEASE_MANIFEST:-}"
REQUESTED_RELEASE_ID="${FSUSBLOG_RELEASE_ID:-}"
REQUESTED_IMAGE_REF="${FSUSBLOG_IMAGE_REF:-}"
RELEASE_SLOT="${FSUSBLOG_RELEASE_SLOT:-}"
PROJECT_NAME="${FSUSBLOG_COMPOSE_PROJECT_NAME:-}"

HOST_TRUSTED_SETUP_MANIFEST=""
HOST_VERIFYING_KEY_MANIFEST=""
HOST_LOCAL_REVIEW_MANIFEST=""
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
  --release-manifest <path>      Required immutable release-manifest.json from CI.
  --release-id <id>              Optional expected releaseId; mismatch fails closed.
  --image-ref <repository@sha256> Optional expected immutable image ref.
  --slot <blue|green>            Required fixed runtime release slot.
  --project-name <name>          Optional expected Compose project; must be fsusblog-<slot>.
  --dry-run                      Validate inputs and print commands without executing them.
  --skip-up                      Run checks and docker compose config, but do not start containers.
  -h, --help                     Show this help.

This is the lower-level immutable image deploy used by tools/deployment/slot-start.sh:
  1. Load .env.production without executing it as shell code.
  2. Guide and block on missing real anonymous/ZK production material.
  3. Run npm --prefix src/frontend run check:privacy-zk-prod-release.
  4. Validate and pull the exact repository@sha256 image from the release manifest.
  5. Run the exact fsusblog-blue/fsusblog-green Compose project config and up -d --no-build.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-file)
            [[ $# -ge 2 ]] || fail "--env-file requires a path"
            ENV_FILE="$2"
            shift 2
            ;;
        --release-manifest)
            [[ $# -ge 2 ]] || fail "--release-manifest requires a path"
            RELEASE_MANIFEST="$2"
            shift 2
            ;;
        --release-id)
            [[ $# -ge 2 ]] || fail "--release-id requires a value"
            REQUESTED_RELEASE_ID="$2"
            shift 2
            ;;
        --image-ref)
            [[ $# -ge 2 ]] || fail "--image-ref requires a value"
            REQUESTED_IMAGE_REF="$2"
            shift 2
            ;;
        --slot)
            [[ $# -ge 2 ]] || fail "--slot requires a value"
            RELEASE_SLOT="$2"
            shift 2
            ;;
        --project-name)
            [[ $# -ge 2 ]] || fail "--project-name requires a value"
            PROJECT_NAME="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --skip-up)
            SKIP_UP=1
            shift
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
done

[[ "${FSUSBLOG_INTERNAL_SLOT_OPERATION:-0}" == "1" ]] ||
    fail "direct invocation is unsupported; use tools/deployment/release-rollout.sh"

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
        printf '  cp .env.production.example .env.production\n' >&2
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
        case "$key" in
            FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE | FSUSBLOG_RELEASE_MANIFEST_HOST_PATH)
                continue
                ;;
        esac
        if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
            value="${value:1:${#value}-2}"
        elif [[ "$value" == \'*\' && "$value" == *\' && ${#value} -ge 2 ]]; then
            value="${value:1:${#value}-2}"
        fi
        export "$key=$value"
    done <"$ENV_FILE"
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
     comment-v2-local-review.manifest.json and every hash-bound local review artifact
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
        Jwt__KeyVersion
        Jwt__RotationWindowDays
        SITE_BASEURL
        CORS_ALLOWED_HOSTS
        APP_ALLOWED_HOSTS
        FIDO2_SERVER_DOMAIN
        FSUSBLOG_ZK_CONFIG_DIR
        FSUSBLOG_ZK_SECRET_DIR
        FSUSBLOG_SHARED_UPLOADS_VOLUME
        FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME
        FSUSBLOG_ZK_VERIFYING_KEY_HASH
        FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST
        FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST
        FSUSBLOG_ZK_LOCAL_REVIEW_MANIFEST
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
    HOST_LOCAL_REVIEW_MANIFEST="$(resolve_host_path "$FSUSBLOG_ZK_LOCAL_REVIEW_MANIFEST" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_LOCAL_REVIEW_MANIFEST")"
    HOST_GROTH16_VERIFYING_KEY="$(resolve_host_path "$FSUSBLOG_ZK_GROTH16_VERIFYING_KEY" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_GROTH16_VERIFYING_KEY")"
    HOST_ISSUER_PUBLIC_KEY="$(resolve_host_path "$FSUSBLOG_ZK_ISSUER_PUBLIC_KEY" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_ISSUER_PUBLIC_KEY")"
    HOST_ISSUER_PRIVATE_KEY="$(resolve_host_path "$FSUSBLOG_ZK_ISSUER_PRIVATE_KEY" "/app/secrets/zk/" "$FSUSBLOG_ZK_SECRET_DIR" "FSUSBLOG_ZK_ISSUER_PRIVATE_KEY")"

    local failed=0
    require_file "trusted setup manifest" "$HOST_TRUSTED_SETUP_MANIFEST" || failed=1
    require_file "verifying key manifest" "$HOST_VERIFYING_KEY_MANIFEST" || failed=1
    require_file "repository-local cryptographic review manifest" "$HOST_LOCAL_REVIEW_MANIFEST" || failed=1
    require_file "Groth16 verifying key" "$HOST_GROTH16_VERIFYING_KEY" || failed=1
    require_file "issuer public key" "$HOST_ISSUER_PUBLIC_KEY" || failed=1
    require_file "issuer private key" "$HOST_ISSUER_PRIVATE_KEY" || failed=1

    if [[ "$failed" == "1" ]]; then
        guide_zk_materials
        exit 1
    fi

    local vk_sha issuer_sha local_review_sha expected_vk_sha expected_issuer_sha
    vk_sha="$(sha256_file "$HOST_GROTH16_VERIFYING_KEY")"
    issuer_sha="$(sha256_file "$HOST_ISSUER_PUBLIC_KEY")"
    local_review_sha="$(sha256_file "$HOST_LOCAL_REVIEW_MANIFEST")"
    expected_vk_sha="$(printf '%s' "$FSUSBLOG_ZK_VERIFYING_KEY_HASH" | tr '[:upper:]' '[:lower:]')"
    expected_issuer_sha="$(printf '%s' "$FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH" | tr '[:upper:]' '[:lower:]')"
    if [[ "$vk_sha" != "$expected_vk_sha" ]]; then
        fail "FSUSBLOG_ZK_VERIFYING_KEY_HASH does not match $HOST_GROTH16_VERIFYING_KEY"
    fi
    if [[ "$issuer_sha" != "$expected_issuer_sha" ]]; then
        fail "FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH does not match $HOST_ISSUER_PUBLIC_KEY"
    fi
    if [[ "sha256:$local_review_sha" != "$FSUSBLOG_ZK_LOCAL_REVIEW_SHA256" ]]; then
        fail "repository-local cryptographic review does not match immutable release manifest"
    fi
}

run_zk_release_gate() {
    local smoke_evidence="${FSUSBLOG_ZK_PROD_SMOKE_EVIDENCE:-.tmp/security/privacy-zk-prod-smoke.json}"
    local root_evidence="${FSUSBLOG_ZK_ROOT_BOOTSTRAP_EVIDENCE:-.tmp/security/anonymous-credential-root-bootstrap.json}"

    if [[ "$DRY_RUN" == "1" ]]; then
        printf '[deploy-production] dry-run command: '
        print_command env \
            FSUSBLOG_ZK_NATIVE_VERIFIER_LIB="${FSUSBLOG_ZK_NATIVE_VERIFIER_LIB:-managed:mcl}" \
            FSUSBLOG_ZK_VERIFYING_KEY_HASH="$FSUSBLOG_ZK_VERIFYING_KEY_HASH" \
            FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST="$HOST_TRUSTED_SETUP_MANIFEST" \
            FSUSBLOG_ZK_LOCAL_REVIEW_MANIFEST="$HOST_LOCAL_REVIEW_MANIFEST" \
            FSUSBLOG_ZK_ISSUER_PUBLIC_KEY="$HOST_ISSUER_PUBLIC_KEY" \
            FSUSBLOG_ZK_ISSUER_PRIVATE_KEY="$HOST_ISSUER_PRIVATE_KEY" \
            npm --prefix src/frontend run check:privacy-zk-prod-release -- \
            --require-enabled \
            --trusted-setup-manifest "$HOST_TRUSTED_SETUP_MANIFEST" \
            --local-review-manifest "$HOST_LOCAL_REVIEW_MANIFEST" \
            --smoke-evidence "$smoke_evidence" \
            --root-bootstrap-evidence "$root_evidence"
        return 0
    fi

    env \
        FSUSBLOG_ZK_NATIVE_VERIFIER_LIB="${FSUSBLOG_ZK_NATIVE_VERIFIER_LIB:-managed:mcl}" \
        FSUSBLOG_ZK_VERIFYING_KEY_HASH="$FSUSBLOG_ZK_VERIFYING_KEY_HASH" \
        FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST="$HOST_TRUSTED_SETUP_MANIFEST" \
        FSUSBLOG_ZK_LOCAL_REVIEW_MANIFEST="$HOST_LOCAL_REVIEW_MANIFEST" \
        FSUSBLOG_ZK_ISSUER_PUBLIC_KEY="$HOST_ISSUER_PUBLIC_KEY" \
        FSUSBLOG_ZK_ISSUER_PRIVATE_KEY="$HOST_ISSUER_PRIVATE_KEY" \
        npm --prefix src/frontend run check:privacy-zk-prod-release -- \
        --require-enabled \
        --trusted-setup-manifest "$HOST_TRUSTED_SETUP_MANIFEST" \
        --local-review-manifest "$HOST_LOCAL_REVIEW_MANIFEST" \
        --smoke-evidence "$smoke_evidence" \
        --root-bootstrap-evidence "$root_evidence"
}

load_release_manifest() {
    [[ -n "$RELEASE_MANIFEST" ]] || fail "--release-manifest is required for production deploy"
    [[ -f "$RELEASE_MANIFEST" ]] || fail "release manifest not found: $RELEASE_MANIFEST"
    RELEASE_MANIFEST="$(cd "$(dirname "$RELEASE_MANIFEST")" && pwd)/$(basename "$RELEASE_MANIFEST")"
    local -a command=(
        node "$ROOT_DIR/tools/release/check-release-manifest.mjs"
        --manifest "$RELEASE_MANIFEST"
        --slot "$RELEASE_SLOT"
        --format lines
    )
    if [[ -n "$REQUESTED_RELEASE_ID" ]]; then
        command+=(--release-id "$REQUESTED_RELEASE_ID")
    fi
    if [[ -n "$REQUESTED_IMAGE_REF" ]]; then
        command+=(--image-ref "$REQUESTED_IMAGE_REF")
    fi

    local output
    if ! output="$("${command[@]}")"; then
        fail "release manifest validation failed"
    fi
    local -a fields=()
    mapfile -t fields <<<"$output"
    [[ "${#fields[@]}" -eq 8 ]] || fail "release manifest validator returned incomplete deployment fields"
    export FSUSBLOG_RELEASE_ID="${fields[0]}"
    export FSUSBLOG_COMMIT_SHA="${fields[1]}"
    export FSUSBLOG_RELEASE_SLOT="${fields[2]}"
    export FSUSBLOG_IMAGE_REF="${fields[3]}"
    export FSUSBLOG_IMAGE_TAG="${fields[4]}"
    export FSUSBLOG_IMAGE_DIGEST="${fields[5]}"
    export FSUSBLOG_ROLLBACK_TARGET="${fields[6]}"
    export FSUSBLOG_ZK_LOCAL_REVIEW_SHA256="${fields[7]}"
    export FSUSBLOG_RELEASE_MANIFEST_HOST_PATH="$RELEASE_MANIFEST"
    [[ -n "${FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE:-}" ]] ||
        fail "FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE must be derived from the durable active slot before deploy"
    [[ "$FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{5,127}$ ]] ||
        fail "FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE is invalid"
    [[ "$FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE" != "$FSUSBLOG_RELEASE_ID" ]] ||
        fail "previous rollback release must differ from the candidate release"
    export FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE
    log "release=$FSUSBLOG_RELEASE_ID slot=$FSUSBLOG_RELEASE_SLOT digest=$FSUSBLOG_IMAGE_DIGEST rollbackTarget=$FSUSBLOG_ROLLBACK_TARGET"
}

configure_slot_compose() {
    local expected_project blue_port green_port
    blue_port="${FSUSBLOG_BLUE_PORT:-8081}"
    green_port="${FSUSBLOG_GREEN_PORT:-8082}"
    [[ "$blue_port" =~ ^[0-9]+$ && "$blue_port" -ge 1 && "$blue_port" -le 65535 ]] || fail "FSUSBLOG_BLUE_PORT is invalid"
    [[ "$green_port" =~ ^[0-9]+$ && "$green_port" -ge 1 && "$green_port" -le 65535 ]] || fail "FSUSBLOG_GREEN_PORT is invalid"
    [[ "$blue_port" != "$green_port" ]] || fail "blue and green ports must be different"

    case "$RELEASE_SLOT" in
        blue)
            export FSUSBLOG_SLOT_PORT="$blue_port"
            ;;
        green)
            export FSUSBLOG_SLOT_PORT="$green_port"
            ;;
        *)
            fail "--slot must be blue or green"
            ;;
    esac

    expected_project="fsusblog-$RELEASE_SLOT"
    if [[ -n "$PROJECT_NAME" && "$PROJECT_NAME" != "$expected_project" ]]; then
        fail "Compose project must be $expected_project for slot $RELEASE_SLOT"
    fi
    PROJECT_NAME="$expected_project"
    export FSUSBLOG_COMPOSE_PROJECT_NAME="$PROJECT_NAME"
    export FSUSBLOG_CONTAINER_NAME="fsus-app-$RELEASE_SLOT"
    export FSUSBLOG_SLOT_AOT_CACHE_VOLUME="fsusblog-aot-cache-$RELEASE_SLOT"
    export FSUSBLOG_SLOT_LOGS_VOLUME="fsusblog-logs-$RELEASE_SLOT"
    export FSUSBLOG_SLOT_DATA_VOLUME="fsusblog-data-$RELEASE_SLOT"
}

validate_pulled_image() {
    if [[ "$DRY_RUN" == "1" ]]; then
        log "dry-run verify pulled image digest and OCI release labels against release manifest"
        return 0
    fi

    local repo_digests actual_release actual_commit
    repo_digests="$(docker image inspect "$FSUSBLOG_IMAGE_REF" --format '{{range .RepoDigests}}{{println .}}{{end}}')"
    if ! grep -Fxq "$FSUSBLOG_IMAGE_REF" <<<"$repo_digests"; then
        fail "pulled image digest does not match release manifest: $FSUSBLOG_IMAGE_REF"
    fi
    actual_release="$(docker image inspect "$FSUSBLOG_IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')"
    actual_commit="$(docker image inspect "$FSUSBLOG_IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
    [[ "$actual_release" == "$FSUSBLOG_RELEASE_ID" ]] || fail "pulled image release label does not match manifest"
    [[ "$actual_commit" == "$FSUSBLOG_COMMIT_SHA" ]] || fail "pulled image commit label does not match manifest"
}

main() {
    require_command node
    if [[ "$DRY_RUN" != "1" ]]; then
        require_command docker
        require_command grep
        require_command npm
    fi

    cd "$ROOT_DIR"
    ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
    COMPOSE_FILE="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)/$(basename "$COMPOSE_FILE")"

    load_env_file
    configure_slot_compose
    if [[ -z "$REQUESTED_RELEASE_ID" && -n "${FSUSBLOG_RELEASE_ID:-}" ]]; then
        REQUESTED_RELEASE_ID="$FSUSBLOG_RELEASE_ID"
    fi
    if [[ -z "$REQUESTED_IMAGE_REF" && -n "${FSUSBLOG_IMAGE_REF:-}" ]]; then
        REQUESTED_IMAGE_REF="$FSUSBLOG_IMAGE_REF"
    fi
    load_release_manifest
    validate_env
    validate_zk_files
    run_zk_release_gate

    run_cmd docker pull "$FSUSBLOG_IMAGE_REF"
    validate_pulled_image
    run_cmd docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$PROJECT_NAME" config

    if [[ "$SKIP_UP" == "1" ]]; then
        log "skip docker compose up"
        return 0
    fi

    run_cmd docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up -d --no-build --pull always
    if [[ "$DRY_RUN" == "1" ]]; then
        log "dry-run complete"
    else
        log "deploy complete"
    fi
}

main "$@"
