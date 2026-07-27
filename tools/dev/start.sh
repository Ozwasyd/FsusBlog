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
Usage: tools/dev/start.sh [--fixture-profile none|demo-public|acceptance-representative] [--no-install] [--cleanup]

Starts the public-preview development stack:
  - PostgreSQL and Redis through ops/development/dependencies.compose.yml
  - ASP.NET Core backend on http://127.0.0.1:7568
  - Vite frontend on http://127.0.0.1:3000

Fixture profile (catalog id; default none):
  none                       Zero business/auth/session/security mutation after schema start.
  demo-public                Apply development demo dataset only.
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
PLAN_JSON="$(
    node "${FIXTURE_CATALOG_CLI[@]}" resolve \
        --profile "$FIXTURE_PROFILE" \
        --source dev-cli \
        --out "$PLANNED_RECEIPT" \
        --kind planned-profile
)"
PROFILE_ID="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.profileId)' "$PLAN_JSON")"
CATALOG_DIGEST="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.catalogDigest)' "$PLAN_JSON")"
CAPABILITY_DIGEST="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.expandedCapabilityDigest)' "$PLAN_JSON")"
MUTATION_POLICY="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.mutationPolicy)' "$PLAN_JSON")"
REQUIRES_LOCAL_AUTH="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.requiresLocalAuthBypass ? "1" : "0")' "$PLAN_JSON")"
REQUIRES_AUTH_FIXTURES="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.requiresAuthFixtures ? "1" : "0")' "$PLAN_JSON")"
REQUIRES_PUBLIC_FIXTURES="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.requiresPublicFixtures ? "1" : "0")' "$PLAN_JSON")"
REQUIRES_DEMO_SEED="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.requiresDemoSeed ? "1" : "0")' "$PLAN_JSON")"
REQUIRES_SECURITY_RESET="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.requiresSecurityReset ? "1" : "0")' "$PLAN_JSON")"
CAPABILITY_IDS="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write((p.capabilities||[]).join(","))' "$PLAN_JSON")"
PRODUCER_IDS="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write((p.producers||[]).join(","))' "$PLAN_JSON")"

echo "[dev-start] planned fixture profile=${PROFILE_ID} source=dev-cli catalogDigest=${CATALOG_DIGEST} mutationPolicy=${MUTATION_POLICY}"
echo "[dev-start] capabilities=${CAPABILITY_IDS:-<none>} producers=${PRODUCER_IDS:-<none>}"
echo "[dev-start] planned-profile receipt: ${PLANNED_RECEIPT}"

if [[ "$REQUIRES_SECURITY_RESET" == "1" ]]; then
    echo "[dev-start] security reset is not implemented as a standalone bootstrap producer yet" >&2
    exit 1
fi

echo "[dev-start] starting PostgreSQL and Redis..."
docker compose -f "$COMPOSE_FILE" up -d postgres redis

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
    export VITE_FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET="$LOCAL_AUTH_FIXTURE_SECRET"
else
    export fsus__allowLocalAuthFixture=false
    unset fsus__localAuthFixtureSecret || true
    unset VITE_FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET || true
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

# Fixture orchestrator (profile-gated). Full multi-producer orchestrator is owned by a later issue;
# this entry only invokes the catalog-backed producers the selected profile requires.
FIXTURE_RECEIPT="$RECEIPT_ROOT/fixture-receipt.json"
if [[ "$PROFILE_ID" == "none" || "$MUTATION_POLICY" == "zero-mutation" ]]; then
    node -e '
const fs = require("node:fs")
const path = require("node:path")
const file = process.argv[1]
const plan = JSON.parse(process.argv[2])
const receipt = {
  schema: "fsusblog.fixture-receipt.v1",
  kind: "fixture-receipt",
  generatedAt: new Date().toISOString(),
  profileId: plan.profileId,
  profileSource: plan.profileSource,
  catalogDigest: plan.catalogDigest,
  expandedCapabilityDigest: plan.expandedCapabilityDigest,
  capabilityIds: plan.capabilities,
  producerIds: plan.producers,
  mutationPolicy: plan.mutationPolicy,
  mutations: [],
  zeroData: true
}
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
' "$FIXTURE_RECEIPT" "$PLAN_JSON"
    echo "[dev-start] none/zero-mutation profile: wrote zero-data fixture receipt"
elif [[ "$REQUIRES_DEMO_SEED" == "1" ]]; then
    "$ROOT_DIR/tools/dev/seed-demo-data.sh"
    node -e '
const fs = require("node:fs")
const path = require("node:path")
const file = process.argv[1]
const plan = JSON.parse(process.argv[2])
const receipt = {
  schema: "fsusblog.fixture-receipt.v1",
  kind: "fixture-receipt",
  generatedAt: new Date().toISOString(),
  profileId: plan.profileId,
  profileSource: plan.profileSource,
  catalogDigest: plan.catalogDigest,
  expandedCapabilityDigest: plan.expandedCapabilityDigest,
  capabilityIds: plan.capabilities,
  producerIds: plan.producers,
  mutationPolicy: plan.mutationPolicy,
  mutations: ["development-demo"],
  zeroData: false
}
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
' "$FIXTURE_RECEIPT" "$PLAN_JSON"
elif [[ "$REQUIRES_AUTH_FIXTURES" == "1" || "$REQUIRES_PUBLIC_FIXTURES" == "1" ]]; then
    if [[ "$REQUIRES_AUTH_FIXTURES" == "1" ]]; then
        echo "[dev-start] preparing auth fixtures for profile ${PROFILE_ID}..."
        FSUSBLOG_BASE_URL="http://127.0.0.1:7568" \
            PLAYWRIGHT_BASE_URL="http://localhost:3000" \
            FSUSBLOG_PG_CONTAINER="fsusblog-dev-postgres" \
            FSUSBLOG_REDIS_CONTAINER="fsusblog-dev-redis" \
            FSUSBLOG_JWT_ACCESS_TOKEN_EXPIRES_MINUTES="$Jwt__AccessTokenExpiresMinutes" \
            npm --prefix "$FRONTEND_DIR" run prepare:binary-smoke:auth-users
    fi
    if [[ "$REQUIRES_PUBLIC_FIXTURES" == "1" && "$REQUIRES_AUTH_FIXTURES" != "1" ]]; then
        echo "[dev-start] public-only fixture production for profile ${PROFILE_ID} is owned by the later fixture orchestrator" >&2
        exit 1
    fi
    node -e '
const fs = require("node:fs")
const path = require("node:path")
const file = process.argv[1]
const plan = JSON.parse(process.argv[2])
const mutations = []
if (plan.requiresAuthFixtures) mutations.push("auth-session")
if (plan.requiresPublicFixtures) mutations.push("public-content-deferred")
const receipt = {
  schema: "fsusblog.fixture-receipt.v1",
  kind: "fixture-receipt",
  generatedAt: new Date().toISOString(),
  profileId: plan.profileId,
  profileSource: plan.profileSource,
  catalogDigest: plan.catalogDigest,
  expandedCapabilityDigest: plan.expandedCapabilityDigest,
  capabilityIds: plan.capabilities,
  producerIds: plan.producers,
  mutationPolicy: plan.mutationPolicy,
  mutations,
  zeroData: false
}
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
' "$FIXTURE_RECEIPT" "$PLAN_JSON"
else
    echo "[dev-start] profile ${PROFILE_ID} requires producers that this entry does not own yet" >&2
    exit 1
fi

FIXTURE_RECEIPT_DIGEST="$(node "${FIXTURE_CATALOG_CLI[@]}" receipt-digest --file "$FIXTURE_RECEIPT")"
READY_RECEIPT="$RECEIPT_ROOT/environment-ready.json"
node "${FIXTURE_CATALOG_CLI[@]}" write-receipt \
    --plan "$PLANNED_RECEIPT" \
    --out "$READY_RECEIPT" \
    --kind environment-ready \
    --fixture-receipt "$FIXTURE_RECEIPT" >/dev/null

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
  environment-ready receipt: ${READY_RECEIPT}
  Cleanup:  ./tools/dev/start.sh --cleanup

Press Ctrl+C to stop backend and frontend processes.
READY

wait -n "$backend_pid" "$frontend_pid"
