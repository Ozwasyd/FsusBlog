#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/ops/development/dependencies.compose.yml"
BOOTSTRAP_PROJECT="$ROOT_DIR/tools/security/AnonymousCredentialRootBootstrap/FsusBlog.AnonymousCredentialRootBootstrap.csproj"
FIXTURE_DIR="${FSUSBLOG_DEV_ANONYMOUS_COMMENT_FIXTURE_DIR:-$ROOT_DIR/.tmp/dev-anonymous-comment-fixture}"

NeedCmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "[anonymous-comment-fixture] missing required command: $1" >&2
        exit 1
    fi
}

NeedCmd docker
NeedCmd dotnet
NeedCmd shasum

DB_NAME="${FSUSBLOG_DEV_POSTGRES_DB:-fsusblog}"
DB_USER="${FSUSBLOG_DEV_POSTGRES_USER:-fsusblog}"
DB_PASSWORD="${FSUSBLOG_DEV_POSTGRES_PASSWORD:-fsusblog_dev}"
DB_PORT="${FSUSBLOG_DEV_POSTGRES_PORT:-5432}"
DB_CONNECTION="${ConnectionStrings__DefaultConnection:-Host=127.0.0.1;Port=$DB_PORT;Database=$DB_NAME;Username=$DB_USER;Password=$DB_PASSWORD}"

DEV_EPOCH="${FSUSBLOG_DEV_ANONYMOUS_COMMENT_EPOCH:-2026070801}"
DEV_CREDENTIAL_ROOT_HASH="${FSUSBLOG_DEV_ANONYMOUS_COMMENT_ROOT_HASH:-ffe5c89bf498f3c9af84344a1a86e8f2e2dd7e758149ca860b4470d8a9951055}"
DEV_REVOCATION_ROOT_HASH="${FSUSBLOG_DEV_ANONYMOUS_COMMENT_REVOCATION_ROOT_HASH:-0534b236fbe54ef350616e8f27d21223b688fcdb08dba8968942421a9d02e20f}"
DEV_ISSUER_PUBLIC_KEY_HASH="${AnonymousCredentialIssuer__CircuitNative__IssuerPublicKeyHash:-336a54a24c06ad3a47ed8090d09a73a876cc1e56e352fdafc96faa38faa2a81e}"
DEV_VERIFYING_KEY_PATH="${AnonymousIdentity__ZkVerifier__NativeGroth16__VerifyingKeyPath:-$ROOT_DIR/tests/fixtures/zk/comment-v2/mcl-pairing/comment_v2_mcl_pairing.vk}"
DEV_VERIFYING_KEY_HASH="${AnonymousIdentity__ZkVerifier__VerifyingKeyHash:-$(shasum -a 256 "$DEV_VERIFYING_KEY_PATH" | awk '{print $1}')}"

mkdir -p "$FIXTURE_DIR"
TRUSTED_SETUP_MANIFEST="$FIXTURE_DIR/trusted-setup.manifest.json"
VERIFYING_KEY_MANIFEST="$FIXTURE_DIR/verifying-key.manifest.json"
BOOTSTRAP_INPUT="$FIXTURE_DIR/anonymous-root-input.json"
BOOTSTRAP_EVIDENCE="$FIXTURE_DIR/anonymous-root-evidence.json"

cat >"$TRUSTED_SETUP_MANIFEST" <<JSON
{
  "schema": "fsusblog.zk.trusted-setup-manifest.v1",
  "circuit_id": "fsus.anonymous.comment.v3",
  "public_input_layout_version": 4,
  "production_usable": true,
  "ceremony_status": "verified",
  "verifying_key_hash": "$DEV_VERIFYING_KEY_HASH"
}
JSON

cat >"$VERIFYING_KEY_MANIFEST" <<JSON
{
  "schema": "fsusblog.zk.verifying-key-config.v1",
  "circuit_id": "fsus.anonymous.comment.v3",
  "public_input_layout_version": 4,
  "production_usable": true,
  "verifying_key_hash": "$DEV_VERIFYING_KEY_HASH"
}
JSON

cat >"$BOOTSTRAP_INPUT" <<JSON
{
  "schema": "fsusblog.anonymous-credential-root-bootstrap-request.v1",
  "epoch": $DEV_EPOCH,
  "credentialRootHash": "$DEV_CREDENTIAL_ROOT_HASH",
  "revocationRootHash": "$DEV_REVOCATION_ROOT_HASH",
  "issuerPublicKeyHash": "$DEV_ISSUER_PUBLIC_KEY_HASH",
  "circuitId": "fsus.anonymous.comment.v3",
  "circuitNumericId": 1,
  "publicInputLayoutVersion": 4,
  "verifyingKeyHash": "$DEV_VERIFYING_KEY_HASH",
  "expiresAt": "2036-07-08T00:00:00Z",
  "graceExpiresAt": "2036-08-08T00:00:00Z",
  "operatorId": "local-dev:anonymous-comment-fixture",
  "reason": "local dev anonymous comment privacy fixture"
}
JSON

docker compose -f "$COMPOSE_FILE" up -d postgres >/dev/null

existing_count="$(docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$DB_PASSWORD" postgres \
    psql -U "$DB_USER" -d "$DB_NAME" -Atc "select count(*) from anonymous_credential_root where epoch = $DEV_EPOCH and status = 'active' and root_hash = '$DEV_CREDENTIAL_ROOT_HASH' and verifying_key_hash = '$DEV_VERIFYING_KEY_HASH' and issuer_public_key_hash = '$DEV_ISSUER_PUBLIC_KEY_HASH' and root_grace_expires_at_utc > now();" 2>/dev/null || true)"

if [[ "$existing_count" == "1" ]]; then
    echo "[anonymous-comment-fixture] active local anonymous credential root already prepared."
    exit 0
fi

dotnet run --project "$BOOTSTRAP_PROJECT" -- \
    --input "$BOOTSTRAP_INPUT" \
    --trusted-setup-manifest "$TRUSTED_SETUP_MANIFEST" \
    --verifying-key-manifest "$VERIFYING_KEY_MANIFEST" \
    --db-type postgres \
    --connection-string "$DB_CONNECTION" \
    --evidence "$BOOTSTRAP_EVIDENCE"

echo "[anonymous-comment-fixture] local anonymous comment privacy root prepared."
