#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:-}"
WORKTREE_FINGERPRINT="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:-}"
TEST_PLAN="${FSUSBLOG_TEST_PLAN:-$ROOT_DIR/.tmp/release-evidence/test-plan.json}"
STATIC_ADMISSION="${FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT:-$ROOT_DIR/.tmp/behavior-doc-static-admission/receipt.json}"
OUT_DIR="${FSUSBLOG_BEHAVIOR_TEST_EVIDENCE_OUT:-$ROOT_DIR/.tmp/behavior-test-evidence}"
RUN_DIR="$OUT_DIR/runs/$RUN_ID"
RAW_DIR="$RUN_DIR/raw"
OBSERVATION_DIR="$RUN_DIR/observations"
BINDINGS="$OUT_DIR/bindings.json"
RECEIPT="$OUT_DIR/receipt.json"
VERIFICATION="$OUT_DIR/verification.json"

if [[ -z "$SOURCE_COMMIT" || -z "$WORKTREE_FINGERPRINT" || -z "$RUN_ID" ]]; then
    printf '%s\n' \
        "[behavior-test-evidence] FSUSBLOG_TEST_SOURCE_COMMIT, FSUSBLOG_TEST_SOURCE_FINGERPRINT and FSUSBLOG_TEST_RUN_ID are required" >&2
    exit 1
fi
if [[ "$WORKTREE_FINGERPRINT" =~ ^sha256:([a-f0-9]{64})$ ]]; then
    WORKTREE_FINGERPRINT="sha256:${BASH_REMATCH[1]}"
elif [[ "$WORKTREE_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]]; then
    WORKTREE_FINGERPRINT="sha256:$WORKTREE_FINGERPRINT"
else
    printf '%s\n' \
        "[behavior-test-evidence] FSUSBLOG_TEST_SOURCE_FINGERPRINT must be a sha256 digest" >&2
    exit 1
fi
for required in "$TEST_PLAN" "$STATIC_ADMISSION"; do
    if [[ ! -f "$required" ]]; then
        printf '%s\n' "[behavior-test-evidence] required input missing: $required" >&2
        exit 1
    fi
done

mkdir -p "$RAW_DIR" "$OBSERVATION_DIR" "$OUT_DIR"

node "$ROOT_DIR/tools/contracts/check-behavior-test-evidence.mjs" \
    --mode bindings \
    --out "$BINDINGS"

NODE_TEST_FILES=(
    tests/tools/code-intent.test.mjs
    tests/tools/document-lifecycle.test.mjs
    tests/tools/test-asset-audit.test.mjs
    tests/tools/test-matrix-topology.test.mjs
)
OBSERVATIONS=()
NODE_RUNTIME="$(node -p 'process.version')"
RUNNER_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
RUNNER_ARCH="$(uname -m)"

for test_file in "${NODE_TEST_FILES[@]}"; do
    file_id="${test_file//\//-}"
    tap_file="$RAW_DIR/$file_id.tap"
    observation_file="$OBSERVATION_DIR/$file_id.json"
    node --test --test-reporter=tap "$ROOT_DIR/$test_file" >"$tap_file"
    node "$ROOT_DIR/tools/test-observations/cli.mjs" adapt \
        --framework node-tap \
        --input "$tap_file" \
        --output "$observation_file" \
        --root "$ROOT_DIR" \
        --evidence-reference "${tap_file#"$ROOT_DIR"/}" \
        --suite "$test_file" \
        --source-commit "$SOURCE_COMMIT" \
        --worktree-fingerprint "$WORKTREE_FINGERPRINT" \
        --run-id "$RUN_ID" \
        --attempt-kind primary \
        --evidence-class correctness \
        --runner-os "$RUNNER_OS" \
        --runner-arch "$RUNNER_ARCH" \
        --runner-runtime "$NODE_RUNTIME" \
        --closure-path config/contracts \
        --closure-path src/shared/Contracts/Governance \
        --closure-path tests/backend/Integration/UserSessionSensitiveEndpointIntegrationTests.cs \
        --closure-path tests/backend/Unit/BinaryTransportHotPathContractTests.cs \
        --closure-path tests/backend/Unit/CommentMutationOutboxPostgresTests.cs \
        --closure-path tests/backend/Unit/ProductionStartupValidatorTests.cs \
        --closure-path tests/backend/Unit/UserSessionJwtAuthenticationTests.cs \
        --closure-path tests/tools/code-intent.test.mjs \
        --closure-path tests/tools/document-lifecycle.test.mjs \
        --closure-path tests/tools/test-asset-audit.test.mjs \
        --closure-path tests/tools/test-matrix-topology.test.mjs \
        --closure-path tools/contracts/behavior-test-binding.mjs \
        --closure-path tools/test-observations
    OBSERVATIONS+=("$observation_file")
done

TRX_FILE="$RAW_DIR/behavior-bound-backend.trx"
DOTNET_FILTER="$(
    node -e '
        const report = require(process.argv[1]);
        const names = report.bindings
            .filter((binding) => binding.framework === "xunit-trx")
            .map((binding) => `FullyQualifiedName~${binding.fullyQualifiedName}`);
        if (names.length === 0) process.exit(1);
        process.stdout.write(names.join("|"));
    ' "$BINDINGS"
)"
"$ROOT_DIR/tools/build-with-data-env.sh" dotnet test \
    "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj" \
    --configuration Debug \
    --filter "$DOTNET_FILTER" \
    --results-directory "$RAW_DIR" \
    --logger "trx;LogFileName=behavior-bound-backend.trx"

BACKEND_OBSERVATION="$OBSERVATION_DIR/backend-xunit.json"
node "$ROOT_DIR/tools/test-observations/cli.mjs" adapt \
    --framework xunit-trx \
    --input "$TRX_FILE" \
    --output "$BACKEND_OBSERVATION" \
    --root "$ROOT_DIR" \
    --evidence-reference "${TRX_FILE#"$ROOT_DIR"/}" \
    --suite behavior-bound-backend \
    --source-commit "$SOURCE_COMMIT" \
    --worktree-fingerprint "$WORKTREE_FINGERPRINT" \
    --run-id "$RUN_ID" \
    --attempt-kind primary \
    --evidence-class correctness \
    --runner-os "$RUNNER_OS" \
    --runner-arch "$RUNNER_ARCH" \
    --runner-runtime "$(dotnet --version)" \
    --closure-path config/contracts \
    --closure-path src/shared/Contracts/Governance \
    --closure-path tests/backend/Integration/UserSessionSensitiveEndpointIntegrationTests.cs \
    --closure-path tests/backend/Unit/BinaryTransportHotPathContractTests.cs \
    --closure-path tests/backend/Unit/CommentMutationOutboxPostgresTests.cs \
    --closure-path tests/backend/Unit/ProductionStartupValidatorTests.cs \
    --closure-path tests/backend/Unit/UserSessionJwtAuthenticationTests.cs \
    --closure-path tests/tools/code-intent.test.mjs \
    --closure-path tests/tools/document-lifecycle.test.mjs \
    --closure-path tests/tools/test-asset-audit.test.mjs \
    --closure-path tests/tools/test-matrix-topology.test.mjs \
    --closure-path tools/contracts/behavior-test-binding.mjs \
    --closure-path tools/test-observations
OBSERVATIONS+=("$BACKEND_OBSERVATION")

PRODUCER_ARGS=()
VERIFIER_ARGS=()
for observation in "${OBSERVATIONS[@]}"; do
    PRODUCER_ARGS+=(--observations "$observation")
    VERIFIER_ARGS+=(--observations "$observation")
done

node "$ROOT_DIR/tools/test-matrix/produce-behavior-test-evidence.mjs" \
    "${PRODUCER_ARGS[@]}" \
    --plan "$TEST_PLAN" \
    --out "$RECEIPT" \
    --evidence-root "$ROOT_DIR" \
    --source-commit "$SOURCE_COMMIT" \
    --worktree-fingerprint "$WORKTREE_FINGERPRINT" \
    --static-admission-receipt "$STATIC_ADMISSION"

node "$ROOT_DIR/tools/test-matrix/verify-behavior-test-evidence.mjs" \
    "${VERIFIER_ARGS[@]}" \
    --plan "$TEST_PLAN" \
    --receipt "$RECEIPT" \
    --out "$VERIFICATION" \
    --evidence-root "$ROOT_DIR" \
    --source-commit "$SOURCE_COMMIT" \
    --worktree-fingerprint "$WORKTREE_FINGERPRINT" \
    --static-admission-receipt "$STATIC_ADMISSION"
