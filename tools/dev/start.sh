#!/usr/bin/env bash
# Dev stack entry: fixture profile is an explicit pre-start input (default none).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/ops/development/dependencies.compose.yml"
FRONTEND_DIR="$ROOT_DIR/src/frontend"
FRONTEND_DIST_DIR="$FRONTEND_DIR/dist"
BACKEND_PROJECT="$ROOT_DIR/src/backend/FsusBlog.Server.csproj"
FIXTURE_CATALOG_CLI=("$ROOT_DIR/tools/testing/fixture-catalog.mjs")
RECEIPT_ROOT="${FSUSBLOG_DEV_FIXTURE_RECEIPT_ROOT:-$ROOT_DIR/.tmp/dev-fixture}"

FIXTURE_PROFILE="none"
INSTALL_DEPS=1
CLEANUP=0

Usage() {
    cat <<'USAGE'
Usage: tools/dev/start.sh [--fixture-profile <catalog-id>] [--no-install] [--cleanup]

Starts the public-preview development stack:
  - PostgreSQL and Redis through ops/development/dependencies.compose.yml
  - ASP.NET Core backend on http://127.0.0.1:7568
  - Vite frontend on http://127.0.0.1:3000

Fixture profile (catalog id; default none):
  none                       Zero business/auth/session/security mutation after schema start.
  demo-public                Apply development demo dataset only.
  account-messaging          Prepare and verify auth/message/notification fixtures.
  acceptance-representative  Prepare local auth/public representative fixtures.

Options:
  --fixture-profile <id>  Explicit fixture profile catalog id (default: none).
  --no-install            Do not run npm ci when src/frontend/node_modules is missing.
  --cleanup               Stop and remove dev PostgreSQL/Redis containers and volumes.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --fixture-profile)
            if [[ $# -lt 2 || -z "${2:-}" ]]; then
                echo "[dev-start] --fixture-profile requires a catalog id" >&2
                Usage >&2
                exit 2
            fi
            FIXTURE_PROFILE="$2"
            shift 2
            ;;
        --fixture-profile=*)
            FIXTURE_PROFILE="${1#--fixture-profile=}"
            if [[ -z "$FIXTURE_PROFILE" ]]; then
                echo "[dev-start] --fixture-profile requires a catalog id" >&2
                Usage >&2
                exit 2
            fi
            shift
            ;;
        --no-install)
            INSTALL_DEPS=0
            shift
            ;;
        --cleanup)
            CLEANUP=1
            shift
            ;;
        -h | --help)
            Usage
            exit 0
            ;;
        *)
            echo "[dev-start] unknown argument: $1" >&2
            Usage >&2
            exit 2
            ;;
    esac
done

NeedCmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "[dev-start] missing required command: $1" >&2
        echo "[dev-start] install prerequisites from docs/development.md and retry." >&2
        exit 1
    fi
}

NeedCmd docker
NeedCmd dotnet
NeedCmd node
NeedCmd npm

if [[ "$CLEANUP" == "1" ]]; then
    docker compose -f "$COMPOSE_FILE" down -v
    echo "[dev-start] removed dev containers and volumes."
    exit 0
fi

# Resolve/validate profile before any service or data mutation.
mkdir -p "$RECEIPT_ROOT"
PLANNED_RECEIPT="$RECEIPT_ROOT/planned-profile.json"
DEMO_FIXTURE_RECEIPT="$RECEIPT_ROOT/fixture-receipt-demo-public.json"
PLAN_RESOLVE_ARGS=(
    resolve
    --profile "$FIXTURE_PROFILE"
    --source dev-cli
    --out "$PLANNED_RECEIPT"
    --kind planned-profile
)
if [[ "$FIXTURE_PROFILE" == "demo-public" ]]; then
    PLAN_RESOLVE_ARGS+=(--execution-class development)
fi
PLAN_JSON="$(
    node "${FIXTURE_CATALOG_CLI[@]}" "${PLAN_RESOLVE_ARGS[@]}"
)"
PROFILE_ID="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.profileId)' "$PLAN_JSON")"
CATALOG_DIGEST="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.catalogDigest)' "$PLAN_JSON")"
CAPABILITY_DIGEST="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.expandedCapabilityDigest)' "$PLAN_JSON")"
MUTATION_POLICY="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.mutationPolicy)' "$PLAN_JSON")"
REQUIRES_LOCAL_AUTH="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.requiresLocalAuthBypass ? "1" : "0")' "$PLAN_JSON")"
REQUIRES_AUTH_FIXTURES="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.requiresAuthFixtures ? "1" : "0")' "$PLAN_JSON")"
REQUIRES_PUBLIC_FIXTURES="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.requiresPublicFixtures ? "1" : "0")' "$PLAN_JSON")"
REQUIRES_DEMO_SEED="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.requiresDemoSeed ? "1" : "0")' "$PLAN_JSON")"
CAPABILITY_IDS="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write((p.capabilities||[]).join(","))' "$PLAN_JSON")"
PRODUCER_IDS="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write((p.producers||[]).join(","))' "$PLAN_JSON")"
REQUIRES_ACCOUNT_PROFILE_PREFERENCES="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write((p.producers||[]).includes("account-profile-preferences") ? "1" : "0")' "$PLAN_JSON")"

echo "[dev-start] planned fixture profile=${PROFILE_ID} source=dev-cli catalogDigest=${CATALOG_DIGEST} mutationPolicy=${MUTATION_POLICY}"
echo "[dev-start] capabilities=${CAPABILITY_IDS:-<none>} producers=${PRODUCER_IDS:-<none>}"
echo "[dev-start] planned-profile receipt: ${PLANNED_RECEIPT}"

echo "[dev-start] starting PostgreSQL and Redis..."
if docker inspect fsusblog-dev-postgres >/dev/null 2>&1 || docker inspect fsusblog-dev-redis >/dev/null 2>&1; then
    # Compose cannot take over containers it did not create (name conflict),
    # so an existing healthy stack is reused and readiness is checked below.
    echo "[dev-start] dev containers already present; reusing them (compose up skipped)."
else
    docker compose -f "$COMPOSE_FILE" up -d postgres redis
fi

echo "[dev-start] waiting for PostgreSQL..."
for _ in $(seq 1 60); do
    if docker exec fsusblog-dev-postgres pg_isready -U "${FSUSBLOG_DEV_POSTGRES_USER:-fsusblog}" -d "${FSUSBLOG_DEV_POSTGRES_DB:-fsusblog}" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
if ! docker exec fsusblog-dev-postgres pg_isready -U "${FSUSBLOG_DEV_POSTGRES_USER:-fsusblog}" -d "${FSUSBLOG_DEV_POSTGRES_DB:-fsusblog}" >/dev/null 2>&1; then
    echo "[dev-start] PostgreSQL did not become ready. Check: docker logs fsusblog-dev-postgres" >&2
    exit 1
fi

echo "[dev-start] waiting for Redis..."
for _ in $(seq 1 60); do
    if docker exec fsusblog-dev-redis redis-cli ping >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
if ! docker exec fsusblog-dev-redis redis-cli ping >/dev/null 2>&1; then
    echo "[dev-start] Redis did not become ready. Check: docker logs fsusblog-dev-redis" >&2
    exit 1
fi

POSTGRES_CONTAINER_ID="$(docker inspect --format '{{.Id}}' fsusblog-dev-postgres)"
REDIS_CONTAINER_ID="$(docker inspect --format '{{.Id}}' fsusblog-dev-redis)"
SERVICE_GENERATION_HEX="$(
    node -e 'const {createHash}=require("node:crypto"); const value=JSON.stringify({postgres:process.argv[1],redis:process.argv[2]}); process.stdout.write(createHash("sha256").update(value).digest("hex"))' \
        "$POSTGRES_CONTAINER_ID" \
        "$REDIS_CONTAINER_ID"
)"
SERVICE_GENERATION="sha256:${SERVICE_GENERATION_HEX}"
DEV_RUN_ID="dev-${SERVICE_GENERATION_HEX:0:24}"
DEV_NAMESPACE="dev-${SERVICE_GENERATION_HEX:0:24}"
SOURCE_IDENTITY_JSON="$(
    node "$ROOT_DIR/tools/test-fixtures/cli.mjs" source-identity --repository-root "$ROOT_DIR"
)"
SOURCE_COMMIT="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.commit)' "$SOURCE_IDENTITY_JSON")"
SOURCE_FINGERPRINT="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.worktreeFingerprint)' "$SOURCE_IDENTITY_JSON")"

if [[ ",${PRODUCER_IDS}," == *",auth-session,"* ]]; then
    if [[ -z "${FSUSBLOG_TEMPORAL_CONTEXT_JSON:-}" ]]; then
        FSUSBLOG_TEMPORAL_CONTEXT_JSON="$(
            SOURCE_COMMIT="$SOURCE_COMMIT" \
            SOURCE_FINGERPRINT="$SOURCE_FINGERPRINT" \
            DEV_RUN_ID="$DEV_RUN_ID" \
            node --input-type=module -e '
                import {
                    defaultTimeoutPolicyDigest,
                    qualificationTemporalContext
                } from "./tools/test/temporal-context.mjs";
                process.stdout.write(JSON.stringify(qualificationTemporalContext({
                    sourceCommit: process.env.SOURCE_COMMIT,
                    sourceFingerprint: process.env.SOURCE_FINGERPRINT,
                    producerId: "auth-session",
                    schedulerRunId: process.env.DEV_RUN_ID,
                    businessEpochUtc: "2042-05-17T09:30:00.000Z",
                    locale: "en-US",
                    uiLocale: "en-US",
                    timeoutPolicyDigest: defaultTimeoutPolicyDigest()
                })));
            '
        )"
        export FSUSBLOG_TEMPORAL_CONTEXT_JSON
    fi
    export FSUSBLOG_TEST_BUSINESS_EPOCH_UTC="$(
        node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.businessEpochUtc)' \
            "$FSUSBLOG_TEMPORAL_CONTEXT_JSON"
    )"
    export TZ="$(
        node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.nodeTimezone)' \
            "$FSUSBLOG_TEMPORAL_CONTEXT_JSON"
    )"
fi

DEMO_TRANSITION_ACTION="none"
DEMO_TRANSITION_REASON="no-previous-demo-receipt"
if [[ -f "$DEMO_FIXTURE_RECEIPT" ]]; then
    DEMO_TRANSITION_JSON="$(
        node "$ROOT_DIR/tools/test-fixtures/cli.mjs" dev-transition \
            --receipt "$DEMO_FIXTURE_RECEIPT" \
            --profile "$PROFILE_ID" \
            --run-id "$DEV_RUN_ID" \
            --namespace "$DEV_NAMESPACE" \
            --source-commit "$SOURCE_COMMIT" \
            --source-fingerprint "$SOURCE_FINGERPRINT" \
            --service-generation "$SERVICE_GENERATION"
    )"
    DEMO_TRANSITION_ACTION="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.action)' "$DEMO_TRANSITION_JSON")"
    DEMO_TRANSITION_REASON="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.reason)' "$DEMO_TRANSITION_JSON")"
fi
echo "[dev-start] execution identity run=${DEV_RUN_ID} namespace=${DEV_NAMESPACE} serviceGeneration=${SERVICE_GENERATION}"
echo "[dev-start] demo transition action=${DEMO_TRANSITION_ACTION} reason=${DEMO_TRANSITION_REASON}"

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    if [[ "$INSTALL_DEPS" != "1" ]]; then
        echo "[dev-start] src/frontend/node_modules is missing and --no-install was used." >&2
        exit 1
    fi
    if [[ -z "${GITHUB_PACKAGES_TOKEN:-}" ]]; then
        echo "[dev-start] GITHUB_PACKAGES_TOKEN is not set. npm ci may fail for the private FsusUI package." >&2
        echo "[dev-start] Set a read:packages token or install dependencies manually before retrying." >&2
    fi
    npm --prefix "$FRONTEND_DIR" ci
fi

export ASPNETCORE_ENVIRONMENT=Development
mkdir -p "$FRONTEND_DIST_DIR"
export ASPNETCORE_WEBROOT="$FRONTEND_DIST_DIR"
export ConnectionStrings__DefaultConnection="Host=127.0.0.1;Port=${FSUSBLOG_DEV_POSTGRES_PORT:-5432};Database=${FSUSBLOG_DEV_POSTGRES_DB:-fsusblog};Username=${FSUSBLOG_DEV_POSTGRES_USER:-fsusblog};Password=${FSUSBLOG_DEV_POSTGRES_PASSWORD:-fsusblog_dev}"
export ConnectionStrings__Redis="127.0.0.1:${FSUSBLOG_DEV_REDIS_PORT:-6379},abortConnect=false,connectTimeout=10000"
export RedisOptions__Configuration="$ConnectionStrings__Redis"
export Jwt__KeyVersion="${FSUSBLOG_DEV_JWT_KEY_VERSION:-dev-v1}"
export Jwt__SecretKey="${FSUSBLOG_DEV_JWT_SECRET:-local-development-jwt-secret-change-before-shared-use-2026}"
export Jwt__Issuer="${FSUSBLOG_DEV_JWT_ISSUER:-FsusBlogServer}"
export Jwt__Audience="${FSUSBLOG_DEV_JWT_AUDIENCE:-FsusBlogClient}"
export Jwt__AccessTokenExpiresMinutes="${FSUSBLOG_DEV_JWT_ACCESS_TOKEN_EXPIRES_MINUTES:-1440}"
export Jwt__RotationWindowDays="${FSUSBLOG_DEV_JWT_ROTATION_WINDOW_DAYS:-30}"
export Security__Pow__SigningKey="${FSUSBLOG_DEV_POW_SIGNING_KEY:-local-development-pow-signing-key-change-before-shared-use-2026}"
export Security__Pow__BaseDifficulty="${FSUSBLOG_DEV_POW_BASE_DIFFICULTY:-8}"
export Security__Pow__MaxDifficulty="${FSUSBLOG_DEV_POW_MAX_DIFFICULTY:-8}"
export Security__PerceptionSealedToken__CurrentKeyVersion="${FSUSBLOG_DEV_PERCEPTION_SEALED_TOKEN_KEY_VERSION:-dev}"
export Security__PerceptionSealedToken__Keys__dev="${FSUSBLOG_DEV_PERCEPTION_SEALED_TOKEN_KEY:-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f}"
export Security__RecoveryKeyPepper="${FSUSBLOG_DEV_RECOVERY_KEY_PEPPER:-local-development-recovery-key-pepper-change-before-shared-use-2026}"
export MfaChallenge__TicketSigningKey="${FSUSBLOG_DEV_MFA_TICKET_SIGNING_KEY:-local-development-mfa-ticket-signing-key-change-before-shared-use-2026}"
export VisitLog__IpPseudonymization__CurrentEpoch="${FSUSBLOG_DEV_VISIT_LOG_IP_KEY_EPOCH:-1}"
export VisitLog__IpPseudonymization__CurrentKey="${FSUSBLOG_DEV_VISIT_LOG_IP_KEY:-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=}"
export Moderation__Pepper="${FSUSBLOG_DEV_MODERATION_PEPPER:-local-development-moderation-pepper-change-before-shared-use-2026}"
export Moderation__RegionPolicy__IpHashKey="${FSUSBLOG_DEV_MODERATION_REGION_IP_HASH_KEY:-local-development-moderation-region-ip-hash-key-change-before-shared-use-2026}"
export Subscription__EmailHashPepper="${FSUSBLOG_DEV_SUBSCRIPTION_EMAIL_HASH_PEPPER:-local-development-subscription-email-hash-pepper-change-before-shared-use-2026}"
export AnonymousCredentialIssuer__IssuerPublicKeyId="${FSUSBLOG_DEV_ANONYMOUS_ISSUER_PUBLIC_KEY_ID:-local-dev-issuer}"
export AnonymousCredentialIssuer__SubjectHashPepper="${FSUSBLOG_DEV_ANONYMOUS_SUBJECT_HASH_PEPPER:-local-development-anonymous-subject-hash-pepper-change-before-shared-use-2026}"
export AnonymousCredentialRoot__AttestationKey="${FSUSBLOG_DEV_ANONYMOUS_ROOT_ATTESTATION_KEY:-local-development-anonymous-root-attestation-key-change-before-shared-use-2026}"
export AnonymousCredentialRoot__AttestationKeyId="${FSUSBLOG_DEV_ANONYMOUS_ROOT_ATTESTATION_KEY_ID:-local-dev-root-attestation}"
export AnonymousIdentity__NullifierPepper="${FSUSBLOG_DEV_ANONYMOUS_NULLIFIER_PEPPER:-local-development-anonymous-nullifier-pepper-change-before-shared-use-2026}"
export FSUSBLOG_ANONYMOUS_IDENTITY_MODE="${FSUSBLOG_ANONYMOUS_IDENTITY_MODE:-1}"
export CORS_ALLOWED_HOSTS="http://localhost:3000,http://127.0.0.1:3000"
export Seo__BaseUrl="http://127.0.0.1:3000"
export Fido2__ServerDomain="localhost"
export Fido2__Origins__0="http://localhost:3000"
export Fido2__Origins__1="http://127.0.0.1:3000"
export AuthCookies__AllowInsecureTransportCookies="true"

# Local auth fixture bypass only when the selected profile depends on auth-session.
if [[ "$REQUIRES_LOCAL_AUTH" == "1" ]]; then
    export fsus__allowLocalAuthFixture=true
    LOCAL_AUTH_FIXTURE_SECRET="${FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET:-${fsus__localAuthFixtureSecret:-local-development-auth-fixture-secret-change-before-shared-use-2026}}"
    export fsus__localAuthFixtureSecret="$LOCAL_AUTH_FIXTURE_SECRET"
    export FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET="$LOCAL_AUTH_FIXTURE_SECRET"
    export VITE_FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET="$LOCAL_AUTH_FIXTURE_SECRET"
else
    export fsus__allowLocalAuthFixture=false
    unset fsus__localAuthFixtureSecret || true
    unset FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET || true
    unset VITE_FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET || true
fi

if [[ "$REQUIRES_ACCOUNT_PROFILE_PREFERENCES" == "1" ]]; then
    ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET="${FSUSBLOG_ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET:-local-development-account-profile-preference-fixture-secret-change-before-shared-use-2026}"
    export FSUSBLOG_ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET="$ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET"
    export fsus__allowAccountProfilePreferenceFixture=true
    export fsus__accountProfilePreferenceFixtureSecret="$ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET"
else
    unset FSUSBLOG_ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET || true
    export fsus__allowAccountProfilePreferenceFixture=false
    unset fsus__accountProfilePreferenceFixtureSecret || true
fi

# Demo prepare is opt-in. Receipt-authorized cleanup has a separate gate so
# switching to none cannot expose the demo prepare composition root.
if [[ "$REQUIRES_DEMO_SEED" == "1" ]]; then
    export fsus__allowLocalDemoFixture=true
else
    export fsus__allowLocalDemoFixture=false
fi
if [[ "$DEMO_TRANSITION_ACTION" == "cleanup" ]]; then
    export fsus__allowLocalDemoFixtureCleanup=true
else
    export fsus__allowLocalDemoFixtureCleanup=false
fi
if [[ "$REQUIRES_DEMO_SEED" == "1" || "$DEMO_TRANSITION_ACTION" == "cleanup" ]]; then
    LOCAL_DEMO_FIXTURE_SECRET="${FSUSBLOG_LOCAL_DEMO_FIXTURE_SECRET:-local-development-demo-fixture-secret-change-before-shared-use-2026}"
    export fsus__localDemoFixtureSecret="$LOCAL_DEMO_FIXTURE_SECRET"
    export FSUSBLOG_LOCAL_DEMO_FIXTURE_SECRET="$LOCAL_DEMO_FIXTURE_SECRET"
else
    unset fsus__localDemoFixtureSecret || true
    unset FSUSBLOG_LOCAL_DEMO_FIXTURE_SECRET || true
fi

backend_pid=""
frontend_pid=""
CleanupChildren() {
    if [[ -n "$frontend_pid" ]]; then kill "$frontend_pid" >/dev/null 2>&1 || true; fi
    if [[ -n "$backend_pid" ]]; then kill "$backend_pid" >/dev/null 2>&1 || true; fi
}
trap CleanupChildren EXIT INT TERM

echo "[dev-start] starting backend on http://127.0.0.1:7568 ..."
ASPNETCORE_ENVIRONMENT=Development \
    dotnet run --project "$BACKEND_PROJECT" --no-launch-profile --urls "http://127.0.0.1:7568" &
backend_pid=$!

if command -v curl >/dev/null 2>&1; then
    echo "[dev-start] waiting for backend health..."
    backend_ready=0
    for _ in $(seq 1 90); do
        if curl -fsS "http://127.0.0.1:7568/health/live" >/dev/null 2>&1; then
            backend_ready=1
            break
        fi
        if ! kill -0 "$backend_pid" >/dev/null 2>&1; then
            echo "[dev-start] backend process exited before health check passed." >&2
            exit 1
        fi
        sleep 1
    done
    if [[ "$backend_ready" != "1" ]]; then
        echo "[dev-start] backend health did not become ready at http://127.0.0.1:7568/health/live" >&2
        exit 1
    fi
else
    echo "[dev-start] curl not found; skipping backend health probe."
    sleep 8
fi

# Unique FixtureOrchestrator (#1709 + #1710 FixtureReceipt). Profile → DAG → producer ports only.
FIXTURE_RECEIPT="$RECEIPT_ROOT/fixture-receipt-${PROFILE_ID}.json"
ORCHESTRATOR_PLAN="$RECEIPT_ROOT/orchestrator-plan.json"
PREPARE_STATE="$RECEIPT_ROOT/prepare-state.json"
CLEANUP_STATE="$RECEIPT_ROOT/demo-cleanup-state.json"

if [[ "$DEMO_TRANSITION_ACTION" == "cleanup" ]]; then
    echo "[dev-start] cleaning exact identities from prior demo-public receipt..."
    node "$ROOT_DIR/tools/test-fixtures/cli.mjs" cleanup \
        --receipt "$DEMO_FIXTURE_RECEIPT" \
        --out "$CLEANUP_STATE" \
        --base-url "http://127.0.0.1:7568" \
        --debug-backend-url "http://127.0.0.1:7568" \
        --pg-container "fsusblog-dev-postgres" \
        --redis-container "fsusblog-dev-redis" \
        --service-generation "$SERVICE_GENERATION"
    node -e 'require("node:fs").unlinkSync(process.argv[1])' "$DEMO_FIXTURE_RECEIPT"
    echo "[dev-start] prior demo-public receipt retired after verified cleanup."
fi

echo "[dev-start] invoking unique fixture orchestrator for profile ${PROFILE_ID}..."
# The none, demo-public, and closed account-messaging profiles publish verified
# FixtureReceipts. A repeated
# demo-public run first cleans the exact identities sealed by its prior receipt.
DEV_FIXTURE_ARGS=(
    run
    --profile "$PROFILE_ID"
    --source dev-cli
    --plan-out "$ORCHESTRATOR_PLAN"
    --prepare-state "$PREPARE_STATE"
    --base-url "http://127.0.0.1:7568"
    --debug-backend-url "http://127.0.0.1:7568"
    --frontend-url "http://localhost:3000"
    --pg-container "fsusblog-dev-postgres"
    --redis-container "fsusblog-dev-redis"
    --run-id "$DEV_RUN_ID"
    --namespace "$DEV_NAMESPACE"
    --source-commit "$SOURCE_COMMIT"
    --source-fingerprint "$SOURCE_FINGERPRINT"
    --service-generation "$SERVICE_GENERATION"
)
if [[ "$PROFILE_ID" == "demo-public" ]]; then
    DEV_FIXTURE_ARGS+=(--execution-class development)
    if [[ "$DEMO_TRANSITION_ACTION" == "reuse" ]]; then
        DEV_FIXTURE_ARGS+=(--previous-fixture-receipt "$DEMO_FIXTURE_RECEIPT")
    fi
fi
FIXTURE_RECEIPT_PUBLISHED=0
if [[ "$PROFILE_ID" == "none" || "$PROFILE_ID" == "demo-public" || "$PROFILE_ID" == "account-messaging" ]]; then
    DEV_FIXTURE_ARGS+=(--fixture-receipt "$FIXTURE_RECEIPT")
    FIXTURE_RECEIPT_PUBLISHED=1
else
    DEV_FIXTURE_ARGS+=(--skip-verify)
fi
FSUSBLOG_BASE_URL="http://127.0.0.1:7568" \
    PLAYWRIGHT_BASE_URL="http://localhost:3000" \
    FSUSBLOG_DEBUG_BACKEND_URL="http://127.0.0.1:7568" \
    FSUSBLOG_DEBUG_FRONTEND_URL="http://localhost:3000" \
    FSUSBLOG_PG_CONTAINER="fsusblog-dev-postgres" \
    FSUSBLOG_REDIS_CONTAINER="fsusblog-dev-redis" \
    FSUSBLOG_JWT_ACCESS_TOKEN_EXPIRES_MINUTES="${Jwt__AccessTokenExpiresMinutes:-}" \
    node "$ROOT_DIR/tools/test-fixtures/cli.mjs" "${DEV_FIXTURE_ARGS[@]}"

FIXTURE_RECEIPT_DIGEST=""
FIXTURE_RECEIPT_TERMINAL_STATUS="prepared-unverified"
if [[ "$FIXTURE_RECEIPT_PUBLISHED" == "1" && -f "$FIXTURE_RECEIPT" ]]; then
    FIXTURE_RECEIPT_DIGEST="$(node "$ROOT_DIR/tools/test-fixtures/cli.mjs" receipt-digest --file "$FIXTURE_RECEIPT")"
    FIXTURE_RECEIPT_TERMINAL_STATUS="verified"
fi
echo "[dev-start] starting frontend on http://127.0.0.1:3000 ..."
npm --prefix "$FRONTEND_DIR" run dev:debug &
frontend_pid=$!

cat <<READY
[dev-start] local stack is ready.
  Frontend: http://127.0.0.1:3000
  Backend:  http://127.0.0.1:7568
  fixture profile: ${PROFILE_ID}
  profile source: dev-cli
  catalog digest: ${CATALOG_DIGEST}
  capability digest: ${CAPABILITY_DIGEST}
  capability ids: ${CAPABILITY_IDS:-<none>}
  producer ids: ${PRODUCER_IDS:-<none>}
  mutation policy: ${MUTATION_POLICY}
  fixture receipt: ${FIXTURE_RECEIPT}
  fixture receipt digest: ${FIXTURE_RECEIPT_DIGEST}
  qualification environment-ready receipt: not produced by the development entrypoint
  Cleanup:  ./tools/dev/start.sh --cleanup

Press Ctrl+C to stop backend and frontend processes.
READY

# macOS ships bash 3.2 which has no `wait -n`; poll both children instead.
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
    sleep 1
done
