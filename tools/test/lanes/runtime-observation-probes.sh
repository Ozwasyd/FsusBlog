#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required}"
ATTEMPT_ID="${FSUSBLOG_TEST_ATTEMPT_ID:-attempt-0001}"
SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:?FSUSBLOG_TEST_SOURCE_COMMIT is required}"
SOURCE_FINGERPRINT="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?FSUSBLOG_TEST_SOURCE_FINGERPRINT is required}"
BUILD_RECEIPT="${FSUSBLOG_CI_PRODUCTION_BUILD_RECEIPT:-$ROOT_DIR/.tmp/ci-production-build/receipt.json}"
FIXTURE_RECEIPT="${FSUSBLOG_FIXTURE_PREPARE_RECEIPT:-$ROOT_DIR/.tmp/fixtures/$RUN_ID/prepare-state.json}"
RUNTIME_DIR="${FSUSBLOG_ACCEPTANCE_RUNTIME_DIR:-$ROOT_DIR/.tmp/acceptance/$RUN_ID}"
BACKEND_IDENTITY="${FSUSBLOG_BACKEND_PROCESS_IDENTITY:-$RUNTIME_DIR/backend.identity.json}"
OUT_DIR="${FSUSBLOG_RUNTIME_OBSERVATION_PROBE_DIR:-$ROOT_DIR/.tmp/runtime-observation-probes/$RUN_ID/$ATTEMPT_ID}"

[[ -r "$BACKEND_IDENTITY" ]] || {
    printf '[runtime-observation-probes] backend identity is missing: %s\n' "$BACKEND_IDENTITY" >&2
    exit 1
}

backend_pid="$($NODE_BIN - "$BACKEND_IDENTITY" "$RUN_ID" "$SOURCE_COMMIT" "$SOURCE_FINGERPRINT" <<'NODE'
const fs = require('node:fs')
const [identityPath, runId, commit, fingerprint] = process.argv.slice(2)
const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'))
if (identity.schema !== 'fsusblog.local-runtime-process-identity.v1'
  || identity.role !== 'backend' || identity.runId !== runId || identity.namespace !== runId
  || identity.sourceState?.commit !== commit
  || String(identity.sourceState?.worktreeFingerprint ?? '').replace(/^sha256:/u, '') !== fingerprint.replace(/^sha256:/u, '')
  || !Number.isSafeInteger(identity.pid) || identity.pid < 2
  || !/^[0-9]+$/u.test(String(identity.startTimeTicks ?? '')))
{
  throw new Error('backend process identity does not match the current run')
}
const stat = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8')
const close = stat.lastIndexOf(')')
const fields = stat.slice(close + 2).split(' ')
if (fields[19] !== String(identity.startTimeTicks)) throw new Error('backend PID start-time identity changed')
const cwd = fs.realpathSync(`/proc/${identity.pid}/cwd`)
if (cwd !== fs.realpathSync(process.cwd())) throw new Error('backend process belongs to another worktree')
process.stdout.write(String(identity.pid))
NODE
)"

jwt_field_count=0
while IFS= read -r variable; do
    case "$variable" in
        Jwt__SecretKey=*|Jwt__KeyVersion=*|Jwt__Issuer=*|Jwt__Audience=*)
            export "$variable"
            jwt_field_count=$((jwt_field_count + 1))
            ;;
    esac
done < <(tr '\0' '\n' <"/proc/$backend_pid/environ")
if [[ "$jwt_field_count" -ne 4 ]]; then
    printf '[runtime-observation-probes] current backend JWT signing handle is incomplete\n' >&2
    exit 1
fi

export FSUSBLOG_TEST_ATTEMPT_ID="$ATTEMPT_ID"
export FSUSBLOG_RUNTIME_OBSERVATION_TIMEOUT_MS="${FSUSBLOG_RUNTIME_OBSERVATION_TIMEOUT_MS:-120000}"
mkdir -p "$OUT_DIR"

for kind in route-response-error session-cookie-runtime cache-search-outbox-convergence; do
    output="$OUT_DIR/$kind.json"
    "$NODE_BIN" "$ROOT_DIR/tools/test-evidence/runtime-observation-probes.mjs" probe \
        --kind "$kind" \
        --build "$BUILD_RECEIPT" \
        --fixture "$FIXTURE_RECEIPT" \
        --out "$output"
    "$NODE_BIN" "$ROOT_DIR/tools/test-evidence/runtime-observation-probes.mjs" verify \
        --receipt "$output"
done

printf '[runtime-observation-probes] verified run=%s attempt=%s count=3\n' "$RUN_ID" "$ATTEMPT_ID"
