#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/dev/docker-compose.yml"
FRONTEND_DIR="$ROOT_DIR/src/frontend"
BACKEND_PROJECT="$ROOT_DIR/src/backend/FsusBlog.Server.csproj"

SEED_DEMO=0
INSTALL_DEPS=1
CLEANUP=0

usage() {
  cat <<'USAGE'
Usage: tools/dev/start.sh [--seed-demo] [--no-install] [--cleanup]

Starts the public-preview development stack:
  - PostgreSQL and Redis through deploy/dev/docker-compose.yml
  - ASP.NET Core backend on http://127.0.0.1:7568
  - Vite frontend on http://127.0.0.1:3000

Options:
  --seed-demo   Seed deterministic fictional demo content after backend startup.
  --no-install  Do not run npm ci when src/frontend/node_modules is missing.
  --cleanup     Stop and remove dev PostgreSQL/Redis containers and volumes.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --seed-demo) SEED_DEMO=1 ;;
    --no-install) INSTALL_DEPS=0 ;;
    --cleanup) CLEANUP=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[dev-start] unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[dev-start] missing required command: $1" >&2
    echo "[dev-start] install prerequisites from docs/development.md and retry." >&2
    exit 1
  fi
}

need_cmd docker
need_cmd dotnet
need_cmd node
need_cmd npm

if [[ "$CLEANUP" == "1" ]]; then
  docker compose -f "$COMPOSE_FILE" down -v
  echo "[dev-start] removed dev containers and volumes."
  exit 0
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
export ConnectionStrings__DefaultConnection="Host=127.0.0.1;Port=${FSUSBLOG_DEV_POSTGRES_PORT:-5432};Database=${FSUSBLOG_DEV_POSTGRES_DB:-fsusblog};Username=${FSUSBLOG_DEV_POSTGRES_USER:-fsusblog};Password=${FSUSBLOG_DEV_POSTGRES_PASSWORD:-fsusblog_dev}"
export ConnectionStrings__Redis="127.0.0.1:${FSUSBLOG_DEV_REDIS_PORT:-6379},abortConnect=false,connectTimeout=10000"
export RedisOptions__Configuration="$ConnectionStrings__Redis"
export Jwt__SecretKey="${FSUSBLOG_DEV_JWT_SECRET:-local-development-jwt-secret-change-before-shared-use-2026}"
export Jwt__Issuer="${FSUSBLOG_DEV_JWT_ISSUER:-FsusBlogServer}"
export Jwt__Audience="${FSUSBLOG_DEV_JWT_AUDIENCE:-FsusBlogClient}"
export Jwt__AccessTokenExpiresMinutes="${FSUSBLOG_DEV_JWT_ACCESS_TOKEN_EXPIRES_MINUTES:-1440}"
export Security__Pow__SigningKey="${FSUSBLOG_DEV_POW_SIGNING_KEY:-local-development-pow-signing-key-change-before-shared-use-2026}"
export Security__Pow__BaseDifficulty="${FSUSBLOG_DEV_POW_BASE_DIFFICULTY:-8}"
export Security__Pow__MaxDifficulty="${FSUSBLOG_DEV_POW_MAX_DIFFICULTY:-8}"
export Security__CaptchaV1__SigningKey="${FSUSBLOG_DEV_CAPTCHA_SIGNING_KEY:-local-development-captcha-v1-signing-key-change-before-shared-use-2026}"
export Security__PerceptionSealedToken__CurrentKeyVersion="${FSUSBLOG_DEV_PERCEPTION_SEALED_TOKEN_KEY_VERSION:-dev}"
export Security__PerceptionSealedToken__Keys__dev="${FSUSBLOG_DEV_PERCEPTION_SEALED_TOKEN_KEY:-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f}"
export Security__RecoveryKeyPepper="${FSUSBLOG_DEV_RECOVERY_KEY_PEPPER:-local-development-recovery-key-pepper-change-before-shared-use-2026}"
export MfaChallenge__TicketSigningKey="${FSUSBLOG_DEV_MFA_TICKET_SIGNING_KEY:-local-development-mfa-ticket-signing-key-change-before-shared-use-2026}"
export VisitLog__IpHashPepper="${FSUSBLOG_DEV_VISIT_LOG_IP_HASH_PEPPER:-local-development-visit-log-ip-hash-pepper-change-before-shared-use-2026}"
export Moderation__Pepper="${FSUSBLOG_DEV_MODERATION_PEPPER:-local-development-moderation-pepper-change-before-shared-use-2026}"
export Moderation__RegionPolicy__IpHashKey="${FSUSBLOG_DEV_MODERATION_REGION_IP_HASH_KEY:-local-development-moderation-region-ip-hash-key-change-before-shared-use-2026}"
export Subscription__EmailHashPepper="${FSUSBLOG_DEV_SUBSCRIPTION_EMAIL_HASH_PEPPER:-local-development-subscription-email-hash-pepper-change-before-shared-use-2026}"
export AnonymousCredentialIssuer__IssuerPublicKeyId="${FSUSBLOG_DEV_ANONYMOUS_ISSUER_PUBLIC_KEY_ID:-local-dev-issuer}"
export AnonymousCredentialIssuer__SubjectHashPepper="${FSUSBLOG_DEV_ANONYMOUS_SUBJECT_HASH_PEPPER:-local-development-anonymous-subject-hash-pepper-change-before-shared-use-2026}"
export AnonymousCredentialRoot__AttestationKey="${FSUSBLOG_DEV_ANONYMOUS_ROOT_ATTESTATION_KEY:-local-development-anonymous-root-attestation-key-change-before-shared-use-2026}"
export AnonymousCredentialRoot__AttestationKeyId="${FSUSBLOG_DEV_ANONYMOUS_ROOT_ATTESTATION_KEY_ID:-local-dev-root-attestation}"
export AnonymousIdentity__NullifierPepper="${FSUSBLOG_DEV_ANONYMOUS_NULLIFIER_PEPPER:-local-development-anonymous-nullifier-pepper-change-before-shared-use-2026}"
export fsus__allowLocalAuthFixture="${FSUSBLOG_ALLOW_LOCAL_AUTH_FIXTURE:-true}"
LOCAL_AUTH_FIXTURE_SECRET="${FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET:-${fsus__localAuthFixtureSecret:-local-development-auth-fixture-secret-change-before-shared-use-2026}}"
export fsus__localAuthFixtureSecret="$LOCAL_AUTH_FIXTURE_SECRET"
export VITE_FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET="$LOCAL_AUTH_FIXTURE_SECRET"
export FSUSBLOG_ANONYMOUS_IDENTITY_MODE="${FSUSBLOG_ANONYMOUS_IDENTITY_MODE:-1}"
export CORS_ALLOWED_HOSTS="http://localhost:3000,http://127.0.0.1:3000"
export Seo__BaseUrl="http://127.0.0.1:3000"
export Fido2__ServerDomain="localhost"
export Fido2__Origins__0="http://localhost:3000"
export Fido2__Origins__1="http://127.0.0.1:3000"
export AuthCookies__AllowInsecureTransportCookies="true"
export AuthCookies__AllowLegacyPlainCookieRead="true"

backend_pid=""
frontend_pid=""
cleanup_children() {
  if [[ -n "$frontend_pid" ]]; then kill "$frontend_pid" >/dev/null 2>&1 || true; fi
  if [[ -n "$backend_pid" ]]; then kill "$backend_pid" >/dev/null 2>&1 || true; fi
}
trap cleanup_children EXIT INT TERM

echo "[dev-start] starting backend on http://127.0.0.1:7568 ..."
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

if [[ "$SEED_DEMO" == "1" ]]; then
  "$ROOT_DIR/tools/dev/seed-demo-data.sh"
fi

echo "[dev-start] preparing persistent local auth fixtures..."
FSUSBLOG_BASE_URL="http://127.0.0.1:7568" \
PLAYWRIGHT_BASE_URL="http://localhost:3000" \
FSUSBLOG_PG_CONTAINER="fsusblog-dev-postgres" \
FSUSBLOG_REDIS_CONTAINER="fsusblog-dev-redis" \
FSUSBLOG_JWT_ACCESS_TOKEN_EXPIRES_MINUTES="$Jwt__AccessTokenExpiresMinutes" \
npm --prefix "$FRONTEND_DIR" run prepare:binary-smoke:auth-users

echo "[dev-start] starting frontend on http://127.0.0.1:3000 ..."
npm --prefix "$FRONTEND_DIR" run dev:debug &
frontend_pid=$!

cat <<'READY'
[dev-start] local stack is starting.
  Frontend: http://127.0.0.1:3000
  Backend:  http://127.0.0.1:7568
  Cleanup:  ./tools/dev/start.sh --cleanup

Press Ctrl+C to stop backend and frontend processes.
READY

wait -n "$backend_pid" "$frontend_pid"
