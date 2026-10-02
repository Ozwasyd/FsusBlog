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
SPA_MANIFEST_DESCRIPTOR=""
PRODUCTION_BUILD_RECEIPT=""

HOST_TRUSTED_SETUP_MANIFEST=""
HOST_VERIFYING_KEY_MANIFEST=""
HOST_GROTH16_VERIFYING_KEY=""
HOST_ISSUER_PUBLIC_KEY=""
HOST_ISSUER_PRIVATE_KEY=""

Log() {
    printf '[deploy-production] %s\n' "$1"
}

Fail() {
    printf '[deploy-production] fatal: %s\n' "$1" >&2
    exit 1
}

Usage() {
    cat <<'USAGE'
Usage: tools/deploy-production.sh [options]

Options:
  --env-file <path>              Production env file. Defaults to .env.production.
  --release-manifest <path>      Required immutable release-manifest.json from CI.
  --spa-manifest-descriptor <path> Required canonical descriptor in the retained release directory.
  --production-build-receipt <path> Required validated receipt authority in the retained release directory.
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
            [[ $# -ge 2 ]] || Fail "--env-file requires a path"
            ENV_FILE="$2"
            shift 2
            ;;
        --release-manifest)
            [[ $# -ge 2 ]] || Fail "--release-manifest requires a path"
            RELEASE_MANIFEST="$2"
            shift 2
            ;;
        --spa-manifest-descriptor)
            [[ $# -ge 2 ]] || Fail "--spa-manifest-descriptor requires a path"
            SPA_MANIFEST_DESCRIPTOR="$2"
            shift 2
            ;;
        --production-build-receipt)
            [[ $# -ge 2 ]] || Fail "--production-build-receipt requires a path"
            PRODUCTION_BUILD_RECEIPT="$2"
            shift 2
            ;;
        --release-id)
            [[ $# -ge 2 ]] || Fail "--release-id requires a value"
            REQUESTED_RELEASE_ID="$2"
            shift 2
            ;;
        --image-ref)
            [[ $# -ge 2 ]] || Fail "--image-ref requires a value"
            REQUESTED_IMAGE_REF="$2"
            shift 2
            ;;
        --slot)
            [[ $# -ge 2 ]] || Fail "--slot requires a value"
            RELEASE_SLOT="$2"
            shift 2
            ;;
        --project-name)
            [[ $# -ge 2 ]] || Fail "--project-name requires a value"
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
            Usage
            exit 0
            ;;
        *)
            Fail "unknown argument: $1"
            ;;
    esac
done

[[ "${FSUSBLOG_INTERNAL_SLOT_OPERATION:-0}" == "1" ]] ||
    Fail "direct invocation is unsupported; use tools/deployment/release-rollout.sh"

RequireCommand() {
    if ! command -v "$1" >/dev/null 2>&1; then
        Fail "missing required command: $1"
    fi
}

PrintCommand() {
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

RunCmd() {
    if [[ "$DRY_RUN" == "1" ]]; then
        printf '[deploy-production] dry-run command: '
        PrintCommand "$@"
        return 0
    fi

    "$@"
}

LoadEnvFile() {
    [[ -f "$ENV_FILE" ]] || {
        printf '[deploy-production] missing %s\n' "$ENV_FILE" >&2
        printf '[deploy-production] create it with:\n' >&2
        printf '  cp config/examples/.env.production.example .env.production\n' >&2
        printf '  \044EDITOR .env.production\n' >&2
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
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || Fail "invalid env key in $ENV_FILE: $key"
        case "$key" in
            FSUSBLOG_RELEASE_ID | FSUSBLOG_RELEASE_CREATED_AT_UTC | FSUSBLOG_COMMIT_SHA | FSUSBLOG_IMAGE_REF | FSUSBLOG_IMAGE_TAG | FSUSBLOG_IMAGE_DIGEST | FSUSBLOG_RELEASE_SLOT | FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE | FSUSBLOG_RELEASE_MANIFEST_HOST_PATH)
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

IsPlaceholderValue() {
    local value="${1:-}"
    [[ -z "$value" ]] && return 0
    [[ "$value" == *CHANGE_ME* ]] && return 0
    [[ "$value" == *TODO* ]] && return 0
    [[ "$value" == *TBD* ]] && return 0
    [[ "$value" == *placeholder* ]] && return 0
    return 1
}

RequireEnvValue() {
    local name="$1"
    local value="${!name:-}"
    if IsPlaceholderValue "$value"; then
        printf '[deploy-production] missing or placeholder env: %s\n' "$name" >&2
        return 1
    fi
    return 0
}

RequireEnvEquals() {
    local name="$1"
    local expected="$2"
    local value="${!name:-}"
    if [[ "$value" != "$expected" ]]; then
        printf '[deploy-production] %s must be %s, got %s\n' "$name" "$expected" "${value:-<empty>}" >&2
        return 1
    fi
    return 0
}

IsSha256Hex() {
    [[ "${1:-}" =~ ^[0-9a-fA-F]{64}$ ]]
}

RequireSha256Env() {
    local name="$1"
    local value="${!name:-}"
    if ! IsSha256Hex "$value"; then
        printf '[deploy-production] %s must be a 64-char hex SHA-256 digest\n' "$name" >&2
        return 1
    fi
    return 0
}

Sha256File() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        Fail "missing required command: sha256sum or shasum"
    fi
}

ResolveHostPath() {
    local containerPath="$1"
    local containerPrefix="$2"
    local hostDir="$3"
    local label="$4"

    if [[ "$containerPath" != "$containerPrefix"* ]]; then
        Fail "$label must point under $containerPrefix inside the container: $containerPath"
    fi

    local suffix="${containerPath#"$containerPrefix"}"
    printf '%s/%s\n' "${hostDir%/}" "$suffix"
}

RequireFile() {
    local label="$1"
    local file="$2"
    if [[ ! -f "$file" ]]; then
        printf '[deploy-production] missing %s: %s\n' "$label" "$file" >&2
        return 1
    fi
    return 0
}

GuideZkMaterials() {
    cat >&2 <<'GUIDE'
[deploy-production] ZK-Prod is default-on and fail-closed. Complete these before deploy:
  1. Mount real non-repo material directories:
     FSUSBLOG_ZK_CONFIG_DIR=/srv/fsusblog/zk/config
     FSUSBLOG_ZK_SECRET_DIR=/srv/fsusblog/zk/secrets
  2. Put public config material in FSUSBLOG_ZK_CONFIG_DIR:
     comment-v5-trusted-setup.manifest.json
     anonymous-comment-v5-verifying-key.manifest.json
     comment.v5.vk
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

ValidateEnv() {
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
        FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME
        FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME
        FSUSBLOG_RELEASE_ASSET_STORE
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
        RequireEnvValue "$name" || failed=1
    done

    RequireEnvEquals FSUSBLOG_ANONYMOUS_IDENTITY_MODE 1 || failed=1
    RequireEnvEquals FSUSBLOG_ZK_PROD_ENABLED true || failed=1
    RequireEnvEquals FSUSBLOG_ZK_TRUSTED_SETUP_VERIFIED true || failed=1
    RequireEnvEquals FSUSBLOG_ZK_CREDENTIAL_READY true || failed=1
    RequireSha256Env FSUSBLOG_ZK_VERIFYING_KEY_HASH || failed=1
    RequireSha256Env FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH || failed=1
    if IsPlaceholderValue "${REVERSE_PROXY_KNOWN_PROXIES:-}" && IsPlaceholderValue "${REVERSE_PROXY_KNOWN_NETWORKS:-}"; then
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
        GuideZkMaterials
        exit 1
    fi
}

ValidateZkFiles() {
    HOST_TRUSTED_SETUP_MANIFEST="$(ResolveHostPath "$FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST")"
    HOST_VERIFYING_KEY_MANIFEST="$(ResolveHostPath "$FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST")"
    HOST_GROTH16_VERIFYING_KEY="$(ResolveHostPath "$FSUSBLOG_ZK_GROTH16_VERIFYING_KEY" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_GROTH16_VERIFYING_KEY")"
    HOST_ISSUER_PUBLIC_KEY="$(ResolveHostPath "$FSUSBLOG_ZK_ISSUER_PUBLIC_KEY" "/app/config/zk/" "$FSUSBLOG_ZK_CONFIG_DIR" "FSUSBLOG_ZK_ISSUER_PUBLIC_KEY")"
    HOST_ISSUER_PRIVATE_KEY="$(ResolveHostPath "$FSUSBLOG_ZK_ISSUER_PRIVATE_KEY" "/app/secrets/zk/" "$FSUSBLOG_ZK_SECRET_DIR" "FSUSBLOG_ZK_ISSUER_PRIVATE_KEY")"

    local failed=0
    RequireFile "trusted setup manifest" "$HOST_TRUSTED_SETUP_MANIFEST" || failed=1
    RequireFile "verifying key manifest" "$HOST_VERIFYING_KEY_MANIFEST" || failed=1
    RequireFile "Groth16 verifying key" "$HOST_GROTH16_VERIFYING_KEY" || failed=1
    RequireFile "issuer public key" "$HOST_ISSUER_PUBLIC_KEY" || failed=1
    RequireFile "issuer private key" "$HOST_ISSUER_PRIVATE_KEY" || failed=1

    if [[ "$failed" == "1" ]]; then
        GuideZkMaterials
        exit 1
    fi

    local vkSha issuerSha expectedVkSha expectedIssuerSha
    vkSha="$(Sha256File "$HOST_GROTH16_VERIFYING_KEY")"
    issuerSha="$(Sha256File "$HOST_ISSUER_PUBLIC_KEY")"
    expectedVkSha="$(printf '%s' "$FSUSBLOG_ZK_VERIFYING_KEY_HASH" | tr '[:upper:]' '[:lower:]')"
    expectedIssuerSha="$(printf '%s' "$FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH" | tr '[:upper:]' '[:lower:]')"
    if [[ "$vkSha" != "$expectedVkSha" ]]; then
        Fail "FSUSBLOG_ZK_VERIFYING_KEY_HASH does not match $HOST_GROTH16_VERIFYING_KEY"
    fi
    if [[ "$issuerSha" != "$expectedIssuerSha" ]]; then
        Fail "FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH does not match $HOST_ISSUER_PUBLIC_KEY"
    fi
}

RunZkReleaseGate() {
    local smokeEvidence="${FSUSBLOG_ZK_PROD_SMOKE_EVIDENCE:-.tmp/security/privacy-zk-prod-smoke.json}"
    local rootEvidence="${FSUSBLOG_ZK_ROOT_BOOTSTRAP_EVIDENCE:-.tmp/security/anonymous-credential-root-bootstrap.json}"

    if [[ "$DRY_RUN" == "1" ]]; then
        printf '[deploy-production] dry-run command: '
        PrintCommand env \
            FSUSBLOG_ZK_NATIVE_VERIFIER_LIB="${FSUSBLOG_ZK_NATIVE_VERIFIER_LIB:-managed:mcl}" \
            FSUSBLOG_ZK_VERIFYING_KEY_HASH="$FSUSBLOG_ZK_VERIFYING_KEY_HASH" \
            FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST="$HOST_TRUSTED_SETUP_MANIFEST" \
            FSUSBLOG_ZK_ISSUER_PUBLIC_KEY="$HOST_ISSUER_PUBLIC_KEY" \
            FSUSBLOG_ZK_ISSUER_PRIVATE_KEY="$HOST_ISSUER_PRIVATE_KEY" \
            npm --prefix src/frontend run check:privacy-zk-prod-release -- \
            --require-enabled \
            --trusted-setup-manifest "$HOST_TRUSTED_SETUP_MANIFEST" \
            --smoke-evidence "$smokeEvidence" \
            --root-bootstrap-evidence "$rootEvidence"
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
        --smoke-evidence "$smokeEvidence" \
        --root-bootstrap-evidence "$rootEvidence"
}

LoadReleaseManifest() {
    [[ -n "$RELEASE_MANIFEST" ]] || Fail "--release-manifest is required for production deploy"
    [[ -f "$RELEASE_MANIFEST" ]] || Fail "release manifest not found: $RELEASE_MANIFEST"
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
        Fail "release manifest validation failed"
    fi
    local -a fields=()
    mapfile -t fields <<<"$output"
    [[ "${#fields[@]}" -eq 7 ]] || Fail "release manifest validator returned incomplete deployment fields"
    export FSUSBLOG_RELEASE_ID="${fields[0]}"
    export FSUSBLOG_RELEASE_CREATED_AT_UTC="${fields[1]}"
    export FSUSBLOG_COMMIT_SHA="${fields[2]}"
    export FSUSBLOG_RELEASE_SLOT="${fields[3]}"
    export FSUSBLOG_IMAGE_REF="${fields[4]}"
    export FSUSBLOG_IMAGE_TAG="${fields[5]}"
    export FSUSBLOG_IMAGE_DIGEST="${fields[6]}"
    export FSUSBLOG_RELEASE_MANIFEST_HOST_PATH="$RELEASE_MANIFEST"
    [[ -n "${FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE:-}" ]] ||
        Fail "FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE must be derived from the durable active slot before deploy"
    node "$ROOT_DIR/tools/release/release-id.mjs" validate "$FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE" >/dev/null ||
        Fail "FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE is invalid"
    [[ "$FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE" != "$FSUSBLOG_RELEASE_ID" ]] ||
        Fail "previous rollback release must differ from the candidate release"
    export FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE
    Log "release=$FSUSBLOG_RELEASE_ID slot=$FSUSBLOG_RELEASE_SLOT digest=$FSUSBLOG_IMAGE_DIGEST"
}

ValidateSpaAuthority() {
    [[ -f "$SPA_MANIFEST_DESCRIPTOR" && ! -L "$SPA_MANIFEST_DESCRIPTOR" ]] ||
        Fail "--spa-manifest-descriptor must name the canonical immutable descriptor"
    [[ -f "$PRODUCTION_BUILD_RECEIPT" && ! -L "$PRODUCTION_BUILD_RECEIPT" ]] ||
        Fail "--production-build-receipt must name the canonical immutable receipt authority"
    local releaseRoot expectedDescriptor expectedReceipt descriptorPath receiptPath
    releaseRoot="$(realpath "$FSUSBLOG_RELEASE_ASSET_STORE")/releases/$FSUSBLOG_RELEASE_ID"
    expectedDescriptor="$releaseRoot/spa-manifest-descriptor.json"
    expectedReceipt="$releaseRoot/production-build-receipt.json"
    descriptorPath="$(realpath "$SPA_MANIFEST_DESCRIPTOR")"
    receiptPath="$(realpath "$PRODUCTION_BUILD_RECEIPT")"
    [[ "$descriptorPath" == "$expectedDescriptor" ]] ||
        Fail "SPA manifest descriptor is outside the current retained release"
    [[ "$receiptPath" == "$expectedReceipt" ]] ||
        Fail "production build receipt authority is outside the current retained release"
    [[ "$((8#$(stat -c '%a' "$descriptorPath") & 8#222))" == "0" ]] ||
        Fail "SPA manifest descriptor must be read-only"
    [[ "$((8#$(stat -c '%a' "$receiptPath") & 8#222))" == "0" ]] ||
        Fail "production build receipt authority must be read-only"
    export FSUSBLOG_PRODUCTION_BUILD_RECEIPT_HOST_PATH="$receiptPath"
}

ConfigureSlotCompose() {
    local expectedProject bluePort greenPort
    bluePort="${FSUSBLOG_BLUE_PORT:-8081}"
    greenPort="${FSUSBLOG_GREEN_PORT:-8082}"
    [[ "$bluePort" =~ ^[0-9]+$ && "$bluePort" -ge 1 && "$bluePort" -le 65535 ]] || Fail "FSUSBLOG_BLUE_PORT is invalid"
    [[ "$greenPort" =~ ^[0-9]+$ && "$greenPort" -ge 1 && "$greenPort" -le 65535 ]] || Fail "FSUSBLOG_GREEN_PORT is invalid"
    [[ "$bluePort" != "$greenPort" ]] || Fail "blue and green ports must be different"

    case "$RELEASE_SLOT" in
        blue)
            export FSUSBLOG_SLOT_PORT="$bluePort"
            ;;
        green)
            export FSUSBLOG_SLOT_PORT="$greenPort"
            ;;
        *)
            Fail "--slot must be blue or green"
            ;;
    esac

    expectedProject="fsusblog-$RELEASE_SLOT"
    if [[ -n "$PROJECT_NAME" && "$PROJECT_NAME" != "$expectedProject" ]]; then
        Fail "Compose project must be $expectedProject for slot $RELEASE_SLOT"
    fi
    PROJECT_NAME="$expectedProject"
    export FSUSBLOG_COMPOSE_PROJECT_NAME="$PROJECT_NAME"
    export FSUSBLOG_CONTAINER_NAME="fsus-app-$RELEASE_SLOT"
    export FSUSBLOG_SLOT_AOT_CACHE_VOLUME="fsusblog-aot-cache-$RELEASE_SLOT"
    export FSUSBLOG_SLOT_LOGS_VOLUME="fsusblog-logs-$RELEASE_SLOT"
    export FSUSBLOG_SLOT_DATA_VOLUME="fsusblog-data-$RELEASE_SLOT"
}

ValidatePulledImage() {
    if [[ "$DRY_RUN" == "1" ]]; then
        Log "dry-run verify pulled image digest and OCI release labels against release manifest"
        return 0
    fi

    local repoDigests actualRelease actualCreatedAtUtc actualCommit
    repoDigests="$(docker image inspect "$FSUSBLOG_IMAGE_REF" --format '{{range .RepoDigests}}{{println .}}{{end}}')"
    if ! grep -Fxq "$FSUSBLOG_IMAGE_REF" <<<"$repoDigests"; then
        Fail "pulled image digest does not match release manifest: $FSUSBLOG_IMAGE_REF"
    fi
    actualRelease="$(docker image inspect "$FSUSBLOG_IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')"
    actualCreatedAtUtc="$(docker image inspect "$FSUSBLOG_IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.created"}}')"
    actualCommit="$(docker image inspect "$FSUSBLOG_IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
    [[ "$actualRelease" == "$FSUSBLOG_RELEASE_ID" ]] || Fail "pulled image release label does not match manifest"
    [[ "$actualCreatedAtUtc" == "$FSUSBLOG_RELEASE_CREATED_AT_UTC" ]] || Fail "pulled image created label does not match manifest"
    [[ "$actualCommit" == "$FSUSBLOG_COMMIT_SHA" ]] || Fail "pulled image commit label does not match manifest"
}

Main() {
    RequireCommand node
    if [[ "$DRY_RUN" != "1" ]]; then
        RequireCommand docker
        RequireCommand grep
        RequireCommand npm
    fi

    cd "$ROOT_DIR"
    ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
    COMPOSE_FILE="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)/$(basename "$COMPOSE_FILE")"

    LoadEnvFile
    ConfigureSlotCompose
    LoadReleaseManifest
    ValidateEnv
    ValidateSpaAuthority
    ValidateZkFiles
    RunZkReleaseGate

    RunCmd docker pull "$FSUSBLOG_IMAGE_REF"
    ValidatePulledImage
    RunCmd docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$PROJECT_NAME" config

    if [[ "$SKIP_UP" == "1" ]]; then
        Log "skip docker compose up"
        return 0
    fi

    RunCmd docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up -d --no-build --pull always
    if [[ "$DRY_RUN" == "1" ]]; then
        Log "dry-run complete"
    else
        Log "deploy complete"
    fi
}

Main "$@"
