#!/usr/bin/env bash
set -eEuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_TOKEN="$(node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID().replaceAll("-", "").slice(0, 16))')"
RUN_PREFIX="current-schema-bootstrap-${RUN_TOKEN}"
POSTGRES_CONTAINER="${RUN_PREFIX}-postgres"
POSTGRES_SWAP_CONTAINER="${RUN_PREFIX}-postgres-swap"
NETWORK_NAME="${RUN_PREFIX}-network"
TEMP_ROOT="$(mktemp -d "/var/tmp/fsusblog-current-schema-bootstrap-${RUN_TOKEN}.XXXXXX")"
OUTPUT_ROOT="$ROOT_DIR/.tmp/current-schema-bootstrap-integration/$RUN_TOKEN"
CATALOG_FILE="$ROOT_DIR/config/testing/test-execution-service-catalog.json"
COVERAGE_REGISTRY_FILE="$ROOT_DIR/tests/coverage-registry.json"
MATRIX_FILE="$ROOT_DIR/tests/matrix.yml"
MATRIX_PARSER_FILE="$ROOT_DIR/tools/test-matrix/parse-matrix.mjs"
MATRIX_PARSER_DEPENDENCY_FILE="$ROOT_DIR/tools/yaml/parse-document.mjs"
SOURCE_AUTHORITY_ROOT="$TEMP_ROOT/source-authority"
SOURCE_MATRIX_PARSER_FILE="$SOURCE_AUTHORITY_ROOT/tools/test-matrix/parse-matrix.mjs"
SOURCE_MATRIX_PARSER_DEPENDENCY_FILE="$SOURCE_AUTHORITY_ROOT/tools/yaml/parse-document.mjs"
SOURCE_RECEIPT_VERIFIER="$SOURCE_AUTHORITY_ROOT/tools/db/verify-current-schema-test-materialization-receipt.mjs"
SERVER_PROJECT="$ROOT_DIR/src/backend/FsusBlog.Server.csproj"
SERVER_DLL="$ROOT_DIR/src/backend/bin/Release/net10.0/FsusBlog.Server.dll"
RECEIPT_VERIFIER="$ROOT_DIR/tools/db/verify-current-schema-test-materialization-receipt.mjs"
SERVICE_ENVELOPE_PRODUCER="$ROOT_DIR/tools/test/execution-envelope-services.mjs"
SOURCE_COMMIT=""
POSTGRES_IMAGE=""
POSTGRES_PORT=""
CONNECTION_STRING=""
ACTIVE_POSTGRES_CONTAINER="$POSTGRES_CONTAINER"
ACTIVE_CONTAINER_ID=""
DATABASE_OID=""
DATABASE_SYSTEM_IDENTIFIER=""
STAGE_RECEIPTS=()
LAST_EVIDENCE_EXIT_STATUS=""
LAST_EVIDENCE_STDOUT=""
LAST_EVIDENCE_STDERR=""

mkdir -p "$(dirname "$OUTPUT_ROOT")"
if ! mkdir "$OUTPUT_ROOT"; then
    rmdir "$TEMP_ROOT"
    printf '[current-schema-bootstrap-integration] run evidence root already exists: %s\n' "$OUTPUT_ROOT" >&2
    exit 1
fi
LANE_STDOUT="$OUTPUT_ROOT/lane.stdout.log"
LANE_STDERR="$OUTPUT_ROOT/lane.stderr.log"
FIRST_FAILURE_PATH="$OUTPUT_ROOT/first-failure.json"
exec 3>&1 4>&2
exec >"$LANE_STDOUT" 2>"$LANE_STDERR"

SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
POSTGRES_IMAGE="$(node "$SERVICE_ENVELOPE_PRODUCER" --image-reference postgres)"

RecordFirstFailure() {
    local exitStatus="$1"
    local line="$2"
    local command="$3"
    [[ ! -e "$FIRST_FAILURE_PATH" ]] || return 0
    EXIT_STATUS_VALUE="$exitStatus" LINE_VALUE="$line" COMMAND_VALUE="$command" \
    RUN_ID_VALUE="$RUN_PREFIX" SOURCE_COMMIT_VALUE="$SOURCE_COMMIT" \
    CONTAINER_NAME_VALUE="$ACTIVE_POSTGRES_CONTAINER" CONTAINER_ID_VALUE="$ACTIVE_CONTAINER_ID" \
    POSTGRES_IMAGE_VALUE="$POSTGRES_IMAGE" NETWORK_VALUE="$NETWORK_NAME" \
    DATABASE_OID_VALUE="$DATABASE_OID" SYSTEM_IDENTIFIER_VALUE="$DATABASE_SYSTEM_IDENTIFIER" \
        node --input-type=module - "$FIRST_FAILURE_PATH" <<'NODE'
import fs from 'node:fs'

const output = process.argv[2]
const failure = {
  schema: 'fsusblog.current-schema-bootstrap-integration-first-failure.v1',
  runId: process.env.RUN_ID_VALUE,
  sourceCommit: process.env.SOURCE_COMMIT_VALUE || null,
  observedAt: new Date().toISOString(),
  exitStatus: Number(process.env.EXIT_STATUS_VALUE),
  line: Number(process.env.LINE_VALUE),
  command: process.env.COMMAND_VALUE,
  container: {
    name: process.env.CONTAINER_NAME_VALUE,
    id: process.env.CONTAINER_ID_VALUE || null,
    image: process.env.POSTGRES_IMAGE_VALUE || null,
    network: process.env.NETWORK_VALUE
  },
  database: {
    name: 'fsusblog',
    oid: process.env.DATABASE_OID_VALUE || null,
    systemIdentifier: process.env.SYSTEM_IDENTIFIER_VALUE || null
  }
}
fs.writeFileSync(output, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
NODE
}

Fail() {
    RecordFirstFailure 1 "$LINENO" "$*"
    printf '[current-schema-bootstrap-integration] %s\n' "$*" >&2
    exit 1
}

Cleanup() {
    docker rm -f -v "$POSTGRES_SWAP_CONTAINER" >/dev/null 2>&1 || true
    docker rm -f -v "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
    docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
    rm -rf -- "$TEMP_ROOT"
}
trap Cleanup EXIT INT TERM
trap 'failureStatus=$?; RecordFirstFailure "$failureStatus" "$LINENO" "$BASH_COMMAND"; exit "$failureStatus"' ERR

RequireCommand() {
    command -v "$1" >/dev/null 2>&1 || Fail "required command is unavailable: $1"
}

for requiredCommand in docker dotnet git node pgrep ps setsid sha256sum; do
    RequireCommand "$requiredCommand"
done
[[ "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]] || Fail 'source commit must be an exact lowercase Git object identity'
[[ -z "$(git -C "$ROOT_DIR" status --porcelain=v1)" ]] \
    || Fail 'source-bound current-schema integration requires a clean worktree'
mkdir -p "$(dirname "$SOURCE_MATRIX_PARSER_FILE")" \
    "$(dirname "$SOURCE_MATRIX_PARSER_DEPENDENCY_FILE")" \
    "$(dirname "$SOURCE_RECEIPT_VERIFIER")"
git -C "$ROOT_DIR" show "$SOURCE_COMMIT:tools/test-matrix/parse-matrix.mjs" \
    >"$SOURCE_MATRIX_PARSER_FILE"
git -C "$ROOT_DIR" show "$SOURCE_COMMIT:tools/yaml/parse-document.mjs" \
    >"$SOURCE_MATRIX_PARSER_DEPENDENCY_FILE"
git -C "$ROOT_DIR" show "$SOURCE_COMMIT:tools/db/verify-current-schema-test-materialization-receipt.mjs" \
    >"$SOURCE_RECEIPT_VERIFIER"
cmp -s "$MATRIX_PARSER_FILE" "$SOURCE_MATRIX_PARSER_FILE" \
    || Fail 'live matrix parser differs from the source-bound candidate'
cmp -s "$MATRIX_PARSER_DEPENDENCY_FILE" "$SOURCE_MATRIX_PARSER_DEPENDENCY_FILE" \
    || Fail 'live YAML parser differs from the source-bound candidate'
cmp -s "$RECEIPT_VERIFIER" "$SOURCE_RECEIPT_VERIFIER" \
    || Fail 'live current-schema receipt verifier differs from the source-bound candidate'
node --input-type=module - "$TEMP_ROOT" <<'NODE'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
const candidate = path.join(root, 'publication-preflight.candidate')
const destination = path.join(root, 'publication-preflight.destination')
fs.writeFileSync(candidate, 'candidate', { flag: 'wx' })
fs.writeFileSync(destination, 'existing', { flag: 'wx' })
assert.throws(() => fs.linkSync(candidate, destination), { code: 'EEXIST' })
assert.equal(fs.readFileSync(candidate, 'utf8'), 'candidate')
assert.equal(fs.readFileSync(destination, 'utf8'), 'existing')
fs.unlinkSync(destination)
fs.linkSync(candidate, destination)
assert.equal(fs.lstatSync(candidate).nlink, 2)
fs.unlinkSync(candidate)
assert.equal(fs.lstatSync(destination).nlink, 1)
assert.equal(fs.readFileSync(destination, 'utf8'), 'candidate')
fs.unlinkSync(destination)
NODE

ReceiptPath() {
    local runId="$1"
    local digest
    digest="$(printf '%s' "$runId" | sha256sum | awk '{print $1}')"
    printf '%s/current-schema-test-materialization-%s.json\n' "$OUTPUT_ROOT" "$digest"
}

RuntimeReadyPath() {
    local runId="$1"
    local digest
    digest="$(printf '%s' "$runId" | sha256sum | awk '{print $1}')"
    printf '%s/current-schema-runtime-ready-%s.json\n' "$OUTPUT_ROOT" "$digest"
}

PostgresSql() {
    docker exec "$ACTIVE_POSTGRES_CONTAINER" psql \
        --no-psqlrc \
        --set=ON_ERROR_STOP=1 \
        --username fsusblog \
        --dbname fsusblog \
        "$@"
}

PostgresScalar() {
    PostgresSql --tuples-only --no-align --command "$1" | tr -d '\r' | sed -E '/^[[:space:]]*$/d' | tail -n 1
}

RefreshDatabaseIdentity() {
    local databaseIdentity
    ACTIVE_CONTAINER_ID="$(docker inspect --format '{{.Id}}' "$ACTIVE_POSTGRES_CONTAINER")"
    databaseIdentity="$(PostgresScalar "SELECT database_meta.oid::text||'|'||control.system_identifier::text FROM pg_catalog.pg_database database_meta CROSS JOIN pg_catalog.pg_control_system() control WHERE database_meta.datname=current_database();")"
    [[ "$databaseIdentity" == *'|'* ]] || Fail 'PostgreSQL database identity observation was incomplete'
    IFS='|' read -r DATABASE_OID DATABASE_SYSTEM_IDENTIFIER <<<"$databaseIdentity"
    [[ "$ACTIVE_CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || Fail 'PostgreSQL container identity was not exact'
    [[ "$DATABASE_OID" =~ ^[0-9]+$ ]] || Fail 'PostgreSQL database OID was not exact'
    [[ "$DATABASE_SYSTEM_IDENTIFIER" =~ ^[0-9]+$ ]] || Fail 'PostgreSQL system identifier was not exact'
}

WriteCommandEvidence() {
    local stage="$1"
    local commandId="$2"
    local expected="$3"
    local startedAt="$4"
    local endedAt="$5"
    local exitStatus="$6"
    local stdoutPath="$7"
    local stderrPath="$8"
    shift 8
    local evidencePath="$OUTPUT_ROOT/evidence-${stage}-${commandId}.json"
    [[ ! -e "$evidencePath" ]] || Fail "duplicate command evidence path: $evidencePath"
    STAGE_VALUE="$stage" COMMAND_ID_VALUE="$commandId" EXPECTED_VALUE="$expected" \
    STARTED_AT_VALUE="$startedAt" ENDED_AT_VALUE="$endedAt" EXIT_STATUS_VALUE="$exitStatus" \
    STDOUT_PATH_VALUE="$stdoutPath" STDERR_PATH_VALUE="$stderrPath" \
    RUN_ID_VALUE="$RUN_PREFIX" SOURCE_COMMIT_VALUE="$SOURCE_COMMIT" \
    CONTAINER_NAME_VALUE="$ACTIVE_POSTGRES_CONTAINER" CONTAINER_ID_VALUE="$ACTIVE_CONTAINER_ID" \
    POSTGRES_IMAGE_VALUE="$POSTGRES_IMAGE" NETWORK_VALUE="$NETWORK_NAME" PORT_VALUE="$POSTGRES_PORT" \
    DATABASE_OID_VALUE="$DATABASE_OID" SYSTEM_IDENTIFIER_VALUE="$DATABASE_SYSTEM_IDENTIFIER" \
        node --input-type=module - "$evidencePath" "$@" <<'NODE'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

const [output, ...argv] = process.argv.slice(2)
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const stdout = fs.readFileSync(process.env.STDOUT_PATH_VALUE)
const stderr = fs.readFileSync(process.env.STDERR_PATH_VALUE)
const exitStatus = Number(process.env.EXIT_STATUS_VALUE)
const exitSignal = exitStatus > 128 && exitStatus <= 192 ? exitStatus - 128 : null
const firstLine = (bytes) => bytes.toString('utf8').split(/\r?\n/u).find((line) => line.trim().length > 0)
const firstFailure = exitStatus === 0
  ? null
  : firstLine(stderr) ?? firstLine(stdout) ?? (exitSignal === null
      ? `command exited with status ${exitStatus}`
      : `command terminated by signal ${exitSignal}`)
const evidence = {
  schema: 'fsusblog.current-schema-bootstrap-integration-command.v1',
  status: 'observed',
  qualificationEligible: false,
  stage: process.env.STAGE_VALUE,
  commandId: process.env.COMMAND_ID_VALUE,
  expectedOutcome: process.env.EXPECTED_VALUE,
  command: argv[0] ?? null,
  argv,
  startedAt: process.env.STARTED_AT_VALUE,
  endedAt: process.env.ENDED_AT_VALUE,
  exit: { status: exitStatus, signal: exitSignal },
  stdout: { path: process.env.STDOUT_PATH_VALUE, sha256: digest(stdout) },
  stderr: { path: process.env.STDERR_PATH_VALUE, sha256: digest(stderr) },
  firstFailure,
  run: { id: process.env.RUN_ID_VALUE, sourceCommit: process.env.SOURCE_COMMIT_VALUE },
  container: {
    name: process.env.CONTAINER_NAME_VALUE,
    id: process.env.CONTAINER_ID_VALUE,
    image: process.env.POSTGRES_IMAGE_VALUE,
    network: process.env.NETWORK_VALUE
  },
  database: {
    host: '127.0.0.1',
    port: Number(process.env.PORT_VALUE),
    name: 'fsusblog',
    oid: Number(process.env.DATABASE_OID_VALUE),
    systemIdentifier: process.env.SYSTEM_IDENTIFIER_VALUE
  },
  contentDigest: null
}
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value
evidence.contentDigest = digest(JSON.stringify(canonicalize(evidence)))
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
NODE
}

RunEvidenceCommand() {
    local stage="$1"
    local commandId="$2"
    local expected="$3"
    shift 3
    local stdoutPath="$OUTPUT_ROOT/${stage}-${commandId}.stdout.log"
    local stderrPath="$OUTPUT_ROOT/${stage}-${commandId}.stderr.log"
    local startedAt
    local endedAt
    local exitStatus
    startedAt="$(date -u +'%Y-%m-%dT%H:%M:%S.%NZ')"
    set +e
    "$@" >"$stdoutPath" 2>"$stderrPath"
    exitStatus=$?
    set -e
    LAST_EVIDENCE_EXIT_STATUS="$exitStatus"
    LAST_EVIDENCE_STDOUT="$stdoutPath"
    LAST_EVIDENCE_STDERR="$stderrPath"
    endedAt="$(date -u +'%Y-%m-%dT%H:%M:%S.%NZ')"
    WriteCommandEvidence "$stage" "$commandId" "$expected" "$startedAt" "$endedAt" "$exitStatus" \
        "$stdoutPath" "$stderrPath" "$@"
    return "$exitStatus"
}

WriteNotApplicableEvidence() {
    local stage="$1"
    local detail="$2"
    RunEvidenceCommand "$stage" not-applicable not-applicable \
        printf '%s\n' "$detail" >/dev/null
}

WritePublicCatalogFacts() {
    local output="$1"
    local query
    read -r -d '' query <<'SQL' || true
        SELECT object_kind, object_name, object_definition
        FROM (
            SELECT
                'relation:' || relation.relkind::text AS object_kind,
                relation.relname AS object_name,
                pg_catalog.pg_get_userbyid(relation.relowner) || ':' || relation.relpersistence::text AS object_definition
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
            UNION ALL
            SELECT
                'column',
                relation.relname || '.' || attribute.attname,
                pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                    || ':' || attribute.attnotnull::text
                    || ':' || attribute.attidentity::text
                    || ':' || COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), '')
            FROM pg_catalog.pg_attribute attribute
            JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
            LEFT JOIN pg_catalog.pg_attrdef default_value
              ON default_value.adrelid = attribute.attrelid
             AND default_value.adnum = attribute.attnum
            WHERE namespace.nspname = 'public'
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
            UNION ALL
            SELECT 'constraint', relation.relname || '.' || constraint_meta.conname,
                pg_catalog.pg_get_constraintdef(constraint_meta.oid, false)
            FROM pg_catalog.pg_constraint constraint_meta
            JOIN pg_catalog.pg_class relation ON relation.oid = constraint_meta.conrelid
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
            UNION ALL
            SELECT 'index', index_relation.relname, pg_catalog.pg_get_indexdef(index_relation.oid)
            FROM pg_catalog.pg_index index_meta
            JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_meta.indexrelid
            JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_meta.indrelid
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_relation.relnamespace
            WHERE namespace.nspname = 'public'
            UNION ALL
            SELECT 'routine', routine.proname || ':' || routine.oid::text,
                pg_catalog.pg_get_function_identity_arguments(routine.oid)
            FROM pg_catalog.pg_proc routine
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
            WHERE namespace.nspname = 'public'
            UNION ALL
            SELECT 'type:' || type_meta.typtype::text, type_meta.typname,
                type_meta.typcategory::text || ':' || type_meta.typisdefined::text
            FROM pg_catalog.pg_type type_meta
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type_meta.typnamespace
            WHERE namespace.nspname = 'public'
        ) facts
        ORDER BY object_kind, object_name, object_definition;
SQL
    PostgresSql --tuples-only --no-align --field-separator '|' --command "$query" >"$output"
}

ResetPublicSchema() {
    PostgresSql --command 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION fsusblog;' >/dev/null
}

WaitForPostgres() {
    local deadline=$((SECONDS + 45))
    until docker exec "$ACTIVE_POSTGRES_CONTAINER" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; do
        ((SECONDS < deadline)) || Fail "PostgreSQL did not become ready: $ACTIVE_POSTGRES_CONTAINER"
        sleep 1
    done
}

StartPostgres() {
    local container="$1"
    shift
    docker run --detach \
        --name "$container" \
        --network "$NETWORK_NAME" \
        --env POSTGRES_USER=fsusblog \
        --env POSTGRES_PASSWORD=fsusblog_dev \
        --env POSTGRES_DB=fsusblog \
        --pull never \
        "$@" \
        "$POSTGRES_IMAGE" >/dev/null
    ACTIVE_POSTGRES_CONTAINER="$container"
    WaitForPostgres
    RefreshDatabaseIdentity
}

WriteStageReceipt() {
    local stage="$1"
    local outcome="$2"
    local detail="$3"
    local receipt="$OUTPUT_ROOT/stage-${stage}.json"
    STAGE_RECEIPTS+=("$receipt")
    STAGE="$stage" OUTCOME="$outcome" DETAIL="$detail" SOURCE_COMMIT_VALUE="$SOURCE_COMMIT" \
    OUTPUT_ROOT_VALUE="$OUTPUT_ROOT" RUN_ID_VALUE="$RUN_PREFIX" \
    CONTAINER_NAME_VALUE="$ACTIVE_POSTGRES_CONTAINER" CONTAINER_ID_VALUE="$ACTIVE_CONTAINER_ID" \
    DATABASE_OID_VALUE="$DATABASE_OID" SYSTEM_IDENTIFIER_VALUE="$DATABASE_SYSTEM_IDENTIFIER" \
        node --input-type=module - "$receipt" <<'NODE'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const output = process.argv[2]
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const evidenceFiles = fs.readdirSync(process.env.OUTPUT_ROOT_VALUE)
  .filter((name) => name.startsWith(`evidence-${process.env.STAGE}-`) && name.endsWith('.json'))
  .sort()
const commandEvidence = evidenceFiles.map((name) => {
  const evidencePath = path.join(process.env.OUTPUT_ROOT_VALUE, name)
  const bytes = fs.readFileSync(evidencePath)
  const evidence = JSON.parse(bytes)
  assert.equal(evidence.schema, 'fsusblog.current-schema-bootstrap-integration-command.v1')
  assert.equal(evidence.stage, process.env.STAGE)
  const unsignedEvidence = { ...evidence, contentDigest: null }
  const canonicalizeEvidence = (value) => Array.isArray(value)
    ? value.map(canonicalizeEvidence)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeEvidence(value[key])]))
      : value
  assert.equal(evidence.contentDigest, digest(JSON.stringify(canonicalizeEvidence(unsignedEvidence))))
  assert.equal(evidence.stdout.sha256, digest(fs.readFileSync(evidence.stdout.path)))
  assert.equal(evidence.stderr.sha256, digest(fs.readFileSync(evidence.stderr.path)))
  return {
    path: evidencePath,
    sha256: digest(bytes),
    contentDigest: evidence.contentDigest,
    commandId: evidence.commandId,
    expectedOutcome: evidence.expectedOutcome,
    command: evidence.command,
    argv: evidence.argv,
    startedAt: evidence.startedAt,
    endedAt: evidence.endedAt,
    exit: evidence.exit,
    stdout: evidence.stdout,
    stderr: evidence.stderr,
    firstFailure: evidence.firstFailure,
    container: evidence.container,
    database: evidence.database
  }
})
assert.ok(commandEvidence.length > 0, `stage ${process.env.STAGE} has no durable command evidence`)
if (process.env.OUTCOME === 'rejected')
{
  assert.ok(commandEvidence.some((entry) => entry.expectedOutcome === 'rejected'
    && entry.exit.status !== 0
    && entry.firstFailure !== null), `stage ${process.env.STAGE} lacks exact rejected-command evidence`)
}
else if (process.env.OUTCOME === 'verified')
{
  assert.ok(commandEvidence.some((entry) => entry.expectedOutcome === 'verified'
    && entry.exit.status === 0), `stage ${process.env.STAGE} lacks exact successful-command evidence`)
}
else
{
  assert.equal(process.env.OUTCOME, 'not-applicable')
  assert.ok(commandEvidence.some((entry) => entry.expectedOutcome === 'not-applicable'
    && entry.exit.status === 0), `stage ${process.env.STAGE} lacks explicit not-applicable evidence`)
}
const receipt = {
  schema: 'fsusblog.current-schema-bootstrap-integration-stage.v1',
  status: process.env.OUTCOME === 'not-applicable' ? 'not-applicable' : 'verified',
  qualificationEligible: process.env.OUTCOME !== 'not-applicable',
  stage: process.env.STAGE,
  expectedOutcome: process.env.OUTCOME,
  detail: process.env.DETAIL,
  runId: process.env.RUN_ID_VALUE,
  sourceCommit: process.env.SOURCE_COMMIT_VALUE,
  container: {
    name: process.env.CONTAINER_NAME_VALUE,
    id: process.env.CONTAINER_ID_VALUE
  },
  database: {
    name: 'fsusblog',
    oid: Number(process.env.DATABASE_OID_VALUE),
    systemIdentifier: process.env.SYSTEM_IDENTIFIER_VALUE
  },
  commandEvidence,
  firstFailure: commandEvidence.map((entry) => entry.firstFailure).find(Boolean) ?? null,
  contentDigest: null
}
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value
receipt.contentDigest = digest(JSON.stringify(canonicalize(receipt)))
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
NODE
}

WriteServiceEnvelope() {
    local runId="$1"
    local envelope="$2"
    node "$SERVICE_ENVELOPE_PRODUCER" \
        --producer-id current-schema-bootstrap-integration \
        --run-id "$runId" \
        --required-services postgres \
        --postgres-container "$ACTIVE_POSTGRES_CONTAINER" \
        --output "$envelope" >/dev/null
}

RunMaterializerWithoutLiveAdmissionEvidence() {
    local stage="$1"
    local commandId="$2"
    local expected="$3"
    local runId="$4"
    local envelope="$5"
    shift 5
    RunEvidenceCommand "$stage" "$commandId" "$expected" \
        env \
        ASPNETCORE_ENVIRONMENT=Test \
        FSUSBLOG_CURRENT_SCHEMA_TEST_MATERIALIZATION=1 \
        FSUSBLOG_CURRENT_SCHEMA_TEST_RECEIPT_ROOT="$OUTPUT_ROOT" \
        ConnectionStrings__DefaultConnection="${CONNECTION_STRING};Search Path=public" \
        "$@" \
        dotnet "$SERVER_DLL" \
            materialize-current-schema-test \
            --run-id "$runId" \
            --source-commit "$SOURCE_COMMIT" \
            --service-envelope "$envelope" \
            --service-catalog "$CATALOG_FILE"
}

RunMaterializerEvidence() {
    local stage="$1"
    local commandId="$2"
    local expected="$3"
    local runId="$4"
    local envelope="$5"
    shift 5
    if ! RunEvidenceCommand "$stage" "${commandId}-service-envelope-admission" verified \
        node "$SERVICE_ENVELOPE_PRODUCER" \
            --verify-envelope "$envelope" \
            --service-catalog "$CATALOG_FILE"; then
        Fail "$stage failed canonical service-envelope admission before the materializer command"
    fi
    RunMaterializerWithoutLiveAdmissionEvidence "$stage" "$commandId" "$expected" \
        "$runId" "$envelope" "$@"
}

ExpectMaterializerFailure() {
    local stage="$1"
    local runId="$2"
    local envelope="$3"
    local expectedCode="$4"
    shift 4
    local receipt
    receipt="$(ReceiptPath "$runId")"
    if RunMaterializerEvidence "$stage" materializer rejected "$runId" "$envelope" "$@"; then
        Fail "$stage unexpectedly materialized the schema"
    fi
    if [[ "$LAST_EVIDENCE_EXIT_STATUS" != 1 ]]; then
        Fail "$stage materializer returned unexpected status $LAST_EVIDENCE_EXIT_STATUS"
    fi
    if ! EXPECTED_CODE_VALUE="$expectedCode" node --input-type=module - "$LAST_EVIDENCE_STDOUT" <<'NODE'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const documents = fs.readFileSync(process.argv[2], 'utf8')
  .split(/\r?\n/u)
  .filter((line) => line.trim().startsWith('{'))
  .map((line) => JSON.parse(line))
  .filter((document) => document.status === 'failed' && typeof document.code === 'string')
assert.deepEqual(documents, [{ status: 'failed', code: process.env.EXPECTED_CODE_VALUE }])
NODE
    then
        Fail "$stage materializer did not emit exact typed failure $expectedCode"
    fi
    [[ ! -e "$receipt" ]] || Fail "$stage left a qualification-eligible terminal receipt"
}

AssertPreparedNoneligibleWhenPresent() {
    local runId="$1"
    local prepared
    prepared="$(ReceiptPath "$runId").prepared"
    if [[ -e "$prepared" ]]; then
        node --input-type=module - "$prepared" <<'NODE'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
assert.equal(receipt.status, 'prepared')
assert.equal(receipt.qualificationEligible, false)
NODE
    fi
}

RunCanonicalReceiptVerifier() {
    local stage="$1"
    local runId="$2"
    local envelope="$3"
    RunEvidenceCommand "$stage" receipt-consumer verified \
        env ConnectionStrings__DefaultConnection="${CONNECTION_STRING};Search Path=public" \
        node "$RECEIPT_VERIFIER" \
        --receipt-root "$OUTPUT_ROOT" \
        --run-id "$runId" \
        --source-commit "$SOURCE_COMMIT" \
        --assembly "$SERVER_DLL" \
        --service-catalog "$CATALOG_FILE" \
        --service-envelope "$envelope" >/dev/null
    [[ -s "$(RuntimeReadyPath "$runId")" ]] || Fail 'canonical runtime-ready receipt was not published'
}

ExpectCanonicalReceiptVerifierFailure() {
    local stage="$1"
    local runId="$2"
    local envelope="$3"
    if RunEvidenceCommand "$stage" receipt-consumer rejected \
        env ConnectionStrings__DefaultConnection="${CONNECTION_STRING};Search Path=public" \
        node "$RECEIPT_VERIFIER" \
        --receipt-root "$OUTPUT_ROOT" \
        --run-id "$runId" \
        --source-commit "$SOURCE_COMMIT" \
        --assembly "$SERVER_DLL" \
        --service-catalog "$CATALOG_FILE" \
        --service-envelope "$envelope"; then
        Fail "$stage unexpectedly produced a runtime-ready receipt"
    fi
    [[ ! -e "$(RuntimeReadyPath "$runId")" ]] \
        || Fail "$stage left a qualification-eligible runtime-ready receipt"
}

CreateVerifierHarness() {
    local harness="$TEMP_ROOT/verifier"
    mkdir -p "$harness"
    cat >"$harness/Verifier.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="$SERVER_PROJECT" />
  </ItemGroup>
</Project>
EOF
    cat >"$harness/Program.cs" <<'EOF'
using FsusBlog.Server.Infrastructure.SchemaMigration;
using SqlSugar;

var inspector = new SchemaModelInspector();
if (args.Length == 1 && args[0] == "--print-canonical-tables")
{
    CurrentSchemaCanonicalModel canonical = inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes());
    foreach (string tableName in CurrentSchemaCanonicalAuthority
        .ProjectProvider(canonical, SchemaProviderKind.PostgreSql)
        .Tables.Keys.Order(StringComparer.Ordinal))
    {
        Console.WriteLine(tableName);
    }
    return 0;
}
if (args.Length != 1)
{
    return 2;
}
using var db = new SqlSugarClient(new ConnectionConfig
{
    ConnectionString = args[0],
    DbType = DbType.PostgreSQL,
    IsAutoCloseConnection = true,
    InitKeyType = InitKeyType.Attribute,
    MoreSettings = new ConnMoreSettings
    {
        PgSqlIsAutoToLower = true,
        PgSqlIsAutoToLowerCodeFirst = true
    }
});
try
{
    await new CurrentSchemaStartupVerifier(db, new SchemaModelInspector())
        .RunAsync(CancellationToken.None);
    Console.WriteLine("current-schema-verifier:green");
    return 0;
}
catch (CurrentSchemaMismatchException exception)
{
    Console.Error.WriteLine($"fsusblog.current-schema-mismatch.v1:{exception.Message}");
    return 42;
}
EOF
    dotnet restore "$harness/Verifier.csproj" --nologo >/dev/null
    dotnet build "$harness/Verifier.csproj" \
        --configuration Release \
        --no-restore \
        --nologo \
        -p:FsusBlogCommitSha="$SOURCE_COMMIT" >/dev/null
    printf '%s/bin/Release/net10.0/Verifier.dll\n' "$harness"
}

RunStartupVerifier() {
    dotnet "$VERIFIER_DLL" "${CONNECTION_STRING};Search Path=public"
}

ExpectVerifierFailure() {
    local stage="$1"
    if RunEvidenceCommand "$stage" startup-verifier rejected \
        dotnet "$VERIFIER_DLL" "${CONNECTION_STRING};Search Path=public"; then
        Fail "$stage unexpectedly passed the production current-schema verifier"
    fi
    [[ "$LAST_EVIDENCE_EXIT_STATUS" == 42 ]] \
        || Fail "$stage verifier exited with ${LAST_EVIDENCE_EXIT_STATUS:-unknown}, expected typed schema-mismatch status 42"
    grep -Eq '^fsusblog\.current-schema-mismatch\.v1:' "$LAST_EVIDENCE_STDERR" \
        || Fail "$stage verifier did not emit the typed schema-mismatch marker"
    WriteStageReceipt "$stage" rejected 'production CurrentSchemaStartupVerifier rejected the injected PostgreSQL drift'
}

RestoreOwnedIndex() {
    local indexName="$1"
    local definition="$2"
    PostgresSql --command "DROP INDEX public.${indexName}; ${definition};" >/dev/null
    RunStartupVerifier >/dev/null
}

RestoreOwnedConstraint() {
    local tableName="$1"
    local constraintName="$2"
    local definition="$3"
    PostgresSql --command "ALTER TABLE public.${tableName} DROP CONSTRAINT ${constraintName}; ALTER TABLE public.${tableName} ADD CONSTRAINT ${constraintName} ${definition};" >/dev/null
    RunStartupVerifier >/dev/null
}

RestoreOwnedSequence() {
    local tableName="$1"
    local columnName="$2"
    local sequenceName="$3"
    local sequenceType="$4"
    local startValue="$5"
    local incrementBy="$6"
    local minValue="$7"
    local maxValue="$8"
    local cacheSize="$9"
    local cycle="${10}"
    local cycleClause='NO CYCLE'
    [[ "$cycle" == true ]] && cycleClause='CYCLE'
    PostgresSql --command "CREATE SEQUENCE public.${sequenceName} AS ${sequenceType} START WITH ${startValue} INCREMENT BY ${incrementBy} MINVALUE ${minValue} MAXVALUE ${maxValue} CACHE ${cacheSize} ${cycleClause} OWNED BY public.${tableName}.${columnName}; ALTER TABLE public.${tableName} ALTER COLUMN ${columnName} SET DEFAULT nextval('public.${sequenceName}'::regclass);" >/dev/null
}

docker network create "$NETWORK_NAME" >/dev/null
docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1 \
    || Fail "canonical pinned PostgreSQL image is not present locally; correctness lanes deny pulls: $POSTGRES_IMAGE"
StartPostgres "$POSTGRES_CONTAINER" --publish 127.0.0.1::5432
POSTGRES_PORT="$(docker port "$POSTGRES_CONTAINER" 5432/tcp | sed -E 's/^.*:([0-9]+)$/\1/' | tail -n 1)"
[[ "$POSTGRES_PORT" =~ ^[0-9]+$ ]] || Fail 'Docker did not publish a unique PostgreSQL host port'
CONNECTION_STRING="Host=127.0.0.1;Port=${POSTGRES_PORT};Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true"

dotnet restore "$SERVER_PROJECT" --nologo >/dev/null
"$ROOT_DIR/tools/build-with-data-env.sh" dotnet build "$SERVER_PROJECT" \
    --configuration Release \
    --no-restore \
    --nologo \
    -p:FsusBlogCommitSha="$SOURCE_COMMIT" >/dev/null
[[ -s "$SERVER_DLL" ]] || Fail 'source-bound Release server artifact is missing'

partialRunId="${RUN_PREFIX}-partial-schema"
partialEnvelope="$OUTPUT_ROOT/${partialRunId}-service-envelope.json"
PostgresSql --command 'CREATE TABLE public.current_schema_partial_sentinel (id bigint PRIMARY KEY);' >/dev/null
WriteServiceEnvelope "$partialRunId" "$partialEnvelope"
partialBeforeFacts="$OUTPUT_ROOT/partial-schema-before.facts"
partialAfterFacts="$OUTPUT_ROOT/partial-schema-after.facts"
WritePublicCatalogFacts "$partialBeforeFacts"
beforePartial="$(sha256sum "$partialBeforeFacts" | awk '{print $1}')"
ExpectMaterializerFailure partial-schema "$partialRunId" "$partialEnvelope" \
    current_schema_materializer_public_schema_not_empty
WritePublicCatalogFacts "$partialAfterFacts"
afterPartial="$(sha256sum "$partialAfterFacts" | awk '{print $1}')"
[[ "$beforePartial" == "$afterPartial" ]] || Fail 'partial-schema rejection wrote to PostgreSQL'
cmp -s "$partialBeforeFacts" "$partialAfterFacts" \
    || Fail 'partial-schema canonical catalog facts changed despite digest comparison'
WriteStageReceipt partial-schema rejected "nonempty relation was preserved; before/after canonical catalog digest=${beforePartial}; zero materializer writes; no terminal receipt"

ResetPublicSchema
compositeRunId="${RUN_PREFIX}-composite-type"
compositeEnvelope="$OUTPUT_ROOT/${compositeRunId}-service-envelope.json"
PostgresSql --command 'CREATE TYPE public.current_schema_composite_sentinel AS (id bigint, label text);' >/dev/null
WriteServiceEnvelope "$compositeRunId" "$compositeEnvelope"
compositeBeforeFacts="$OUTPUT_ROOT/composite-type-before.facts"
compositeAfterFacts="$OUTPUT_ROOT/composite-type-after.facts"
WritePublicCatalogFacts "$compositeBeforeFacts"
compositeBefore="$(sha256sum "$compositeBeforeFacts" | awk '{print $1}')"
ExpectMaterializerFailure composite-type "$compositeRunId" "$compositeEnvelope" \
    current_schema_materializer_public_schema_not_empty
[[ ! -e "$(ReceiptPath "$compositeRunId").prepared" ]] \
    || Fail 'composite-type rejection left a prepared receipt'
WritePublicCatalogFacts "$compositeAfterFacts"
compositeAfter="$(sha256sum "$compositeAfterFacts" | awk '{print $1}')"
[[ "$compositeBefore" == "$compositeAfter" ]] \
    || Fail 'composite-type rejection changed raw PostgreSQL catalog facts'
cmp -s "$compositeBeforeFacts" "$compositeAfterFacts" \
    || Fail 'composite-type raw PostgreSQL catalog facts changed despite digest comparison'
WriteStageReceipt composite-type rejected "public composite type and its relation/attribute facts were byte-identical before/after; digest=${compositeBefore}; no prepared or verified receipt"

ResetPublicSchema
nonrelationRunId="${RUN_PREFIX}-nonrelation"
nonrelationEnvelope="$OUTPUT_ROOT/${nonrelationRunId}-service-envelope.json"
PostgresSql --command 'CREATE FUNCTION public.current_schema_nonrelation_sentinel() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;' >/dev/null
WriteServiceEnvelope "$nonrelationRunId" "$nonrelationEnvelope"
ExpectMaterializerFailure nonrelation-object "$nonrelationRunId" "$nonrelationEnvelope" \
    current_schema_materializer_public_schema_not_empty
[[ "$(PostgresScalar "SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='current_schema_nonrelation_sentinel';")" == 1 ]] \
    || Fail 'nonrelation rejection did not preserve the sentinel function'
WriteStageReceipt nonrelation-object rejected 'public routine was preserved, zero materializer writes, no terminal receipt'

ResetPublicSchema
publicationRunId="${RUN_PREFIX}-publication-fault"
publicationEnvelope="$OUTPUT_ROOT/${publicationRunId}-service-envelope.json"
WriteServiceEnvelope "$publicationRunId" "$publicationEnvelope"
ExpectMaterializerFailure publication-fault "$publicationRunId" "$publicationEnvelope" \
    current_schema_materializer_publication_fault_after_commit \
    env FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT=after-commit
AssertPreparedNoneligibleWhenPresent "$publicationRunId"
ExpectCanonicalReceiptVerifierFailure publication-fault "$publicationRunId" "$publicationEnvelope"
[[ "$(PostgresScalar "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public';")" == 0 ]] \
    || Fail 'post-commit publication compensation did not restore an empty public schema'
WriteStageReceipt publication-fault rejected 'post-commit publication failure left no eligible terminal and best-effort compensation restored the empty public schema'

ResetPublicSchema
crashRunId="${RUN_PREFIX}-prepared-crash"
crashEnvelope="$OUTPUT_ROOT/${crashRunId}-service-envelope.json"
WriteServiceEnvelope "$crashRunId" "$crashEnvelope"
node "$SERVICE_ENVELOPE_PRODUCER" \
    --verify-envelope "$crashEnvelope" \
    --service-catalog "$CATALOG_FILE" >/dev/null
crashStdout="$OUTPUT_ROOT/prepared-crash-materializer.stdout.log"
crashStderr="$OUTPUT_ROOT/prepared-crash-materializer.stderr.log"
crashCommand=(setsid env \
    ASPNETCORE_ENVIRONMENT=Test \
    FSUSBLOG_CURRENT_SCHEMA_TEST_MATERIALIZATION=1 \
    FSUSBLOG_CURRENT_SCHEMA_TEST_RECEIPT_ROOT="$OUTPUT_ROOT" \
    FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT=after-prepared-hold \
    ConnectionStrings__DefaultConnection="${CONNECTION_STRING};Search Path=public" \
    dotnet "$SERVER_DLL" \
        materialize-current-schema-test \
        --run-id "$crashRunId" \
        --source-commit "$SOURCE_COMMIT" \
        --service-envelope "$crashEnvelope" \
        --service-catalog "$CATALOG_FILE")
crashStartedAt="$(date -u +'%Y-%m-%dT%H:%M:%S.%NZ')"
"${crashCommand[@]}" >"$crashStdout" 2>"$crashStderr" &
crashPid=$!
lanePgid="$(ps -o pgid= -p "$$" | tr -d ' ')"
crashGroupDeadline=$((SECONDS + 5))
while true; do
    kill -0 "$crashPid" >/dev/null 2>&1 \
        || Fail 'prepared crash materializer exited before process-group admission'
    crashPgid="$(ps -o pgid= -p "$crashPid" | tr -d ' ')"
    if [[ "$crashPgid" == "$crashPid" && "$crashPgid" != "$lanePgid" ]]; then
        break
    fi
    ((SECONDS < crashGroupDeadline)) \
        || Fail 'prepared crash materializer did not start in an exact isolated process group'
    sleep 0.1
done
crashArgs="$(ps -o args= -p "$crashPid")"
[[ "$crashArgs" == *"$SERVER_DLL materialize-current-schema-test --run-id $crashRunId"* ]] \
    || Fail 'prepared crash process identity does not match the exact materializer candidate'
crashPrepared="$(ReceiptPath "$crashRunId").prepared"
crashDeadline=$((SECONDS + 45))
until [[ -s "$crashPrepared" ]]; do
    if ! kill -0 "$crashPid" >/dev/null 2>&1; then
        wait "$crashPid" || true
        Fail 'prepared crash process exited before publishing its noneligible staging receipt'
    fi
    ((SECONDS < crashDeadline)) || Fail 'prepared crash staging receipt was not published'
    sleep 0.1
done
kill -KILL -- "-$crashPgid"
crashExitStatus=0
wait "$crashPid" >/dev/null 2>&1 || crashExitStatus=$?
crashEndedAt="$(date -u +'%Y-%m-%dT%H:%M:%S.%NZ')"
[[ "$crashExitStatus" == 137 ]] \
    || Fail "prepared crash materializer exited with ${crashExitStatus}, expected SIGKILL status 137"
survivorDeadline=$((SECONDS + 5))
while pgrep -g "$crashPgid" >/dev/null 2>&1; do
    ((SECONDS < survivorDeadline)) \
        || Fail 'prepared crash materializer process group retained a surviving candidate'
    sleep 0.1
done
AssertPreparedNoneligibleWhenPresent "$crashRunId"
[[ ! -e "$(ReceiptPath "$crashRunId")" ]] || Fail 'prepared crash left a verified terminal receipt'
rollbackDeadline=$((SECONDS + 20))
until [[ "$(PostgresScalar "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public';")" == 0 ]]; do
    ((SECONDS < rollbackDeadline)) || Fail 'prepared crash transaction did not roll back to an empty schema'
    sleep 0.2
done
WriteCommandEvidence prepared-crash materializer rejected "$crashStartedAt" "$crashEndedAt" \
    "$crashExitStatus" "$crashStdout" "$crashStderr" "${crashCommand[@]}"
WriteStageReceipt prepared-crash rejected 'SIGKILL of the exact isolated materializer process group left zero candidates, only noneligible staging evidence, and PostgreSQL rolled back the open DDL transaction'

ResetPublicSchema
staleRunId="${RUN_PREFIX}-stale-envelope"
staleEnvelope="$OUTPUT_ROOT/${staleRunId}-service-envelope.json"
WriteServiceEnvelope "$staleRunId" "$staleEnvelope"
docker rm -f -v "$POSTGRES_CONTAINER" >/dev/null
ACTIVE_POSTGRES_CONTAINER="$POSTGRES_SWAP_CONTAINER"
StartPostgres "$POSTGRES_SWAP_CONTAINER" --publish "127.0.0.1:${POSTGRES_PORT}:5432"
staleBeforeFacts="$OUTPUT_ROOT/stale-envelope-before.facts"
staleAfterFacts="$OUTPUT_ROOT/stale-envelope-after.facts"
WritePublicCatalogFacts "$staleBeforeFacts"
if RunMaterializerWithoutLiveAdmissionEvidence stale-envelope-cluster-swap materializer rejected \
    "$staleRunId" "$staleEnvelope"; then
    Fail 'stale-envelope-cluster-swap unexpectedly materialized the replacement cluster'
fi
grep -Fq 'current_schema_materializer_database_observation_mismatch' \
    "$OUTPUT_ROOT/stale-envelope-cluster-swap-materializer.stdout.log" \
    "$OUTPUT_ROOT/stale-envelope-cluster-swap-materializer.stderr.log" \
    || Fail 'stale-envelope-cluster-swap did not fail on the PostgreSQL instance identity'
if grep -Eq 'service_envelope_(invalid|drift)|argument_|run_id|digest' \
    "$OUTPUT_ROOT/stale-envelope-cluster-swap-materializer.stdout.log" \
    "$OUTPUT_ROOT/stale-envelope-cluster-swap-materializer.stderr.log"; then
    Fail 'stale-envelope-cluster-swap failed before PostgreSQL instance identity admission'
fi
[[ ! -e "$(ReceiptPath "$staleRunId")" ]] \
    || Fail 'stale-envelope-cluster-swap left a qualification-eligible terminal receipt'
[[ ! -e "$(ReceiptPath "$staleRunId").prepared" ]] \
    || Fail 'stale-envelope-cluster-swap left a prepared receipt'
[[ ! -e "$(RuntimeReadyPath "$staleRunId")" ]] \
    || Fail 'stale-envelope-cluster-swap left a runtime-ready receipt'
WritePublicCatalogFacts "$staleAfterFacts"
cmp -s "$staleBeforeFacts" "$staleAfterFacts" \
    || Fail 'stale service envelope changed the replacement PostgreSQL catalog'
staleCatalogDigest="$(sha256sum "$staleBeforeFacts" | awk '{print $1}')"

positiveRunId="${RUN_PREFIX}-positive"
positiveEnvelope="$OUTPUT_ROOT/${positiveRunId}-service-envelope.json"
WriteServiceEnvelope "$positiveRunId" "$positiveEnvelope"
RunMaterializerEvidence positive materializer verified "$positiveRunId" "$positiveEnvelope"
RunCanonicalReceiptVerifier positive "$positiveRunId" "$positiveEnvelope"
positiveReceipt="$(ReceiptPath "$positiveRunId")"
positiveReceiptBefore="$(sha256sum "$positiveReceipt" | awk '{print $1}')"
if RunMaterializerEvidence positive materializer-rerun rejected "$positiveRunId" "$positiveEnvelope"; then
    Fail 'positive rerun unexpectedly overwrote an existing terminal materialization receipt'
fi
positiveReceiptAfter="$(sha256sum "$positiveReceipt" | awk '{print $1}')"
[[ "$positiveReceiptBefore" == "$positiveReceiptAfter" ]] \
    || Fail 'failed rerun changed the existing terminal materialization receipt'

VERIFIER_DLL="$(CreateVerifierHarness)"

# Mutations may only target canonical-owned objects. Runtime rollup tables
# materialize alongside them, but the startup verifier requires rather than
# compares those tables, so drift injected there can never fail.
CANONICAL_TABLE_LIST="$(dotnet "$VERIFIER_DLL" --print-canonical-tables | sed -E "s/.*/'&'/" | paste -sd, -)"
[[ -n "$CANONICAL_TABLE_LIST" ]] || Fail 'canonical model exposes no owned table for drift injection'
CANONICAL_TABLE_SQL="(${CANONICAL_TABLE_LIST})"

RunEvidenceCommand positive startup-verifier verified \
    dotnet "$VERIFIER_DLL" "${CONNECTION_STRING};Search Path=public"
WriteStageReceipt positive verified 'canonical materializer, startup verifier, and runtime-ready receipt consumer passed'

defaultTarget="$(PostgresScalar "SELECT quote_ident(table_name)||'.'||quote_ident(column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ${CANONICAL_TABLE_SQL} AND data_type IN ('text','character varying') AND column_default IS NULL AND is_identity='NO' ORDER BY table_name,column_name LIMIT 1;")"
[[ "$defaultTarget" == *.* ]] || Fail 'no canonical text column is available for the default drift stage'
defaultTable="${defaultTarget%%.*}"
defaultColumn="${defaultTarget#*.}"
PostgresSql --command "ALTER TABLE public.${defaultTable} ALTER COLUMN ${defaultColumn} SET DEFAULT '__current_schema_drift__';" >/dev/null
ExpectVerifierFailure extra-default
PostgresSql --command "ALTER TABLE public.${defaultTable} ALTER COLUMN ${defaultColumn} DROP DEFAULT;" >/dev/null
RunStartupVerifier >/dev/null

ownedTextIndex="$(PostgresScalar "SELECT quote_ident(table_rel.relname)||'|'||quote_ident(index_rel.relname)||'|'||quote_ident(key_column.attname)||'|'||pg_get_indexdef(index_rel.oid) FROM pg_index index_meta JOIN pg_class table_rel ON table_rel.oid=index_meta.indrelid JOIN pg_namespace table_namespace ON table_namespace.oid=table_rel.relnamespace JOIN pg_class index_rel ON index_rel.oid=index_meta.indexrelid JOIN pg_am access_method ON access_method.oid=index_rel.relam JOIN pg_attribute key_column ON key_column.attrelid=table_rel.oid AND key_column.attnum=index_meta.indkey[0] WHERE table_namespace.nspname='public' AND table_rel.relname IN ${CANONICAL_TABLE_SQL} AND access_method.amname='btree' AND NOT index_meta.indisunique AND index_meta.indnkeyatts=1 AND index_meta.indnatts=1 AND index_meta.indexprs IS NULL AND index_meta.indpred IS NULL AND (index_meta.indoption[0] & 1)=0 AND key_column.atttypid IN ('text'::regtype,'varchar'::regtype) AND NOT EXISTS (SELECT 1 FROM pg_constraint owner WHERE owner.conindid=index_meta.indexrelid) ORDER BY table_rel.relname,index_rel.relname LIMIT 1;")"
[[ "$ownedTextIndex" == *'|'* ]] || Fail 'canonical schema has no directly-owned single-key text index for physical index field drift'
IFS='|' read -r indexTable indexName indexColumn indexOriginalDefinition <<<"$ownedTextIndex"

PostgresSql --command "DROP INDEX public.${indexName}; CREATE INDEX ${indexName} ON public.${indexTable} USING btree (${indexColumn} DESC NULLS LAST);" >/dev/null
ExpectVerifierFailure index-direction
RestoreOwnedIndex "$indexName" "$indexOriginalDefinition"

PostgresSql --command "DROP INDEX public.${indexName}; CREATE INDEX ${indexName} ON public.${indexTable} USING btree (${indexColumn} ASC NULLS FIRST);" >/dev/null
ExpectVerifierFailure index-null-placement
RestoreOwnedIndex "$indexName" "$indexOriginalDefinition"

PostgresSql --command "DROP INDEX public.${indexName}; CREATE INDEX ${indexName} ON public.${indexTable} USING btree (${indexColumn}) WHERE ${indexColumn} IS NOT NULL;" >/dev/null
ExpectVerifierFailure index-predicate
RestoreOwnedIndex "$indexName" "$indexOriginalDefinition"

PostgresSql --command "DROP INDEX public.${indexName}; CREATE INDEX ${indexName} ON public.${indexTable} USING hash (${indexColumn});" >/dev/null
ExpectVerifierFailure index-access-method
RestoreOwnedIndex "$indexName" "$indexOriginalDefinition"

PostgresSql --command "DROP INDEX public.${indexName}; CREATE INDEX ${indexName} ON public.${indexTable} USING btree (${indexColumn} pg_catalog.text_pattern_ops);" >/dev/null
ExpectVerifierFailure index-operator-class
RestoreOwnedIndex "$indexName" "$indexOriginalDefinition"

alternateIndexCollation="$(PostgresScalar "SELECT format('%I.%I', namespace.nspname, collation_meta.collname) FROM pg_collation collation_meta JOIN pg_namespace namespace ON namespace.oid=collation_meta.collnamespace JOIN pg_attribute attribute_meta ON attribute_meta.attrelid='public.${indexTable}'::regclass AND attribute_meta.attname=trim(both chr(34) from '${indexColumn}') WHERE collation_meta.oid<>attribute_meta.attcollation AND collation_meta.collencoding IN (-1,pg_char_to_encoding(current_setting('server_encoding'))) ORDER BY CASE WHEN collation_meta.collname='C' THEN 0 ELSE 1 END,namespace.nspname,collation_meta.collname LIMIT 1;")"
[[ "$alternateIndexCollation" == *.* ]] || Fail 'no alternate compatible PostgreSQL collation is available for the owned index key'
PostgresSql --command "DROP INDEX public.${indexName}; CREATE INDEX ${indexName} ON public.${indexTable} USING btree (${indexColumn} COLLATE ${alternateIndexCollation});" >/dev/null
ExpectVerifierFailure index-collation
RestoreOwnedIndex "$indexName" "$indexOriginalDefinition"

includedColumn="$(PostgresScalar "SELECT quote_ident(attribute_meta.attname) FROM pg_attribute attribute_meta WHERE attribute_meta.attrelid='public.${indexTable}'::regclass AND attribute_meta.attnum>0 AND NOT attribute_meta.attisdropped AND attribute_meta.attname<>trim(both chr(34) from '${indexColumn}') ORDER BY attribute_meta.attnum LIMIT 1;")"
[[ -n "$includedColumn" ]] || Fail 'owned index table has no second column for INCLUDE drift'
PostgresSql --command "DROP INDEX public.${indexName}; CREATE INDEX ${indexName} ON public.${indexTable} USING btree (${indexColumn}) INCLUDE (${includedColumn});" >/dev/null
ExpectVerifierFailure index-include
RestoreOwnedIndex "$indexName" "$indexOriginalDefinition"

ownedUniqueIndex="$(PostgresScalar "SELECT quote_ident(table_rel.relname)||'|'||quote_ident(index_rel.relname)||'|'||quote_ident(key_column.attname)||'|'||pg_get_indexdef(index_rel.oid) FROM pg_index index_meta JOIN pg_class table_rel ON table_rel.oid=index_meta.indrelid JOIN pg_namespace table_namespace ON table_namespace.oid=table_rel.relnamespace JOIN pg_class index_rel ON index_rel.oid=index_meta.indexrelid JOIN pg_am access_method ON access_method.oid=index_rel.relam JOIN pg_attribute key_column ON key_column.attrelid=table_rel.oid AND key_column.attnum=index_meta.indkey[0] WHERE table_namespace.nspname='public' AND table_rel.relname IN ${CANONICAL_TABLE_SQL} AND access_method.amname='btree' AND index_meta.indisunique AND index_meta.indnkeyatts=1 AND index_meta.indnatts=1 AND index_meta.indexprs IS NULL AND index_meta.indpred IS NULL AND (index_meta.indoption[0] & 1)=0 AND NOT EXISTS (SELECT 1 FROM pg_constraint owner WHERE owner.conindid=index_meta.indexrelid) ORDER BY table_rel.relname,index_rel.relname LIMIT 1;")"
[[ "$ownedUniqueIndex" == *'|'* ]] || Fail 'canonical schema has no directly-owned single-key unique index for NULLS NOT DISTINCT drift'
IFS='|' read -r uniqueIndexTable uniqueIndexName uniqueIndexColumn uniqueIndexOriginalDefinition <<<"$ownedUniqueIndex"
PostgresSql --command "DROP INDEX public.${uniqueIndexName}; CREATE UNIQUE INDEX ${uniqueIndexName} ON public.${uniqueIndexTable} USING btree (${uniqueIndexColumn}) NULLS NOT DISTINCT;" >/dev/null
ExpectVerifierFailure index-nulls-not-distinct
RestoreOwnedIndex "$uniqueIndexName" "$uniqueIndexOriginalDefinition"

precisionTarget="$(PostgresScalar "SELECT quote_ident(table_name)||'.'||quote_ident(column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ${CANONICAL_TABLE_SQL} AND data_type='timestamp without time zone' AND datetime_precision=6 ORDER BY table_name,column_name LIMIT 1;")"
if [[ "$precisionTarget" == *.* ]]; then
    precisionTable="${precisionTarget%%.*}"
    precisionColumn="${precisionTarget#*.}"
    PostgresSql --command "ALTER TABLE public.${precisionTable} ALTER COLUMN ${precisionColumn} TYPE timestamp(0) without time zone;" >/dev/null
    ExpectVerifierFailure type-precision
    PostgresSql --command "ALTER TABLE public.${precisionTable} ALTER COLUMN ${precisionColumn} TYPE timestamp(6) without time zone;" >/dev/null
    RunStartupVerifier >/dev/null
    RunEvidenceCommand type-default-precision startup-verifier verified \
        dotnet "$VERIFIER_DLL" "${CONNECTION_STRING};Search Path=public"
    WriteStageReceipt type-default-precision verified 'explicit PostgreSQL timestamp(6) normalized to the canonical unspecified default precision'
else
    WriteNotApplicableEvidence type-precision 'canonical schema exposes no timestamp(6) column'
    WriteStageReceipt type-precision not-applicable 'canonical schema exposes no timestamp(6) column'
    WriteNotApplicableEvidence type-default-precision 'canonical schema exposes no timestamp(6) column whose explicit default precision can be normalized'
    WriteStageReceipt type-default-precision not-applicable 'canonical schema exposes no timestamp(6) column whose explicit default precision can be normalized'
fi
RunStartupVerifier >/dev/null

columnCollationTarget="$(PostgresScalar "SELECT quote_ident(table_rel.relname)||'|'||quote_ident(attribute_meta.attname)||'|'||format_type(attribute_meta.atttypid,attribute_meta.atttypmod)||'|'||format('%I.%I',original_namespace.nspname,original_collation.collname)||'|'||format('%I.%I',alternate_namespace.nspname,alternate_collation.collname) FROM pg_class table_rel JOIN pg_namespace table_namespace ON table_namespace.oid=table_rel.relnamespace JOIN pg_attribute attribute_meta ON attribute_meta.attrelid=table_rel.oid AND attribute_meta.attnum>0 AND NOT attribute_meta.attisdropped JOIN pg_collation original_collation ON original_collation.oid=attribute_meta.attcollation JOIN pg_namespace original_namespace ON original_namespace.oid=original_collation.collnamespace CROSS JOIN LATERAL (SELECT candidate.* FROM pg_collation candidate WHERE candidate.oid<>attribute_meta.attcollation AND candidate.collencoding IN (-1,pg_char_to_encoding(current_setting('server_encoding'))) ORDER BY CASE WHEN candidate.collname='C' THEN 0 ELSE 1 END,candidate.oid LIMIT 1) alternate_collation JOIN pg_namespace alternate_namespace ON alternate_namespace.oid=alternate_collation.collnamespace WHERE table_namespace.nspname='public' AND table_rel.relname IN ${CANONICAL_TABLE_SQL} AND attribute_meta.atttypid IN ('text'::regtype,'varchar'::regtype) AND NOT EXISTS (SELECT 1 FROM pg_attrdef default_meta WHERE default_meta.adrelid=table_rel.oid AND default_meta.adnum=attribute_meta.attnum) ORDER BY table_rel.relname,attribute_meta.attnum LIMIT 1;")"
[[ "$columnCollationTarget" == *'|'* ]] || Fail 'canonical schema has no owned collatable column with an alternate compatible collation'
IFS='|' read -r collationTable collationColumn collationPhysicalType originalColumnCollation alternateColumnCollation <<<"$columnCollationTarget"
PostgresSql --command "ALTER TABLE public.${collationTable} ALTER COLUMN ${collationColumn} TYPE ${collationPhysicalType} COLLATE ${alternateColumnCollation};" >/dev/null
ExpectVerifierFailure column-collation
PostgresSql --command "ALTER TABLE public.${collationTable} ALTER COLUMN ${collationColumn} TYPE ${collationPhysicalType} COLLATE ${originalColumnCollation};" >/dev/null
RunStartupVerifier >/dev/null

ownedSequence="$(PostgresScalar "SELECT quote_ident(owner_rel.relname)||'|'||quote_ident(owner_attribute.attname)||'|'||quote_ident(sequence_rel.relname)||'|'||format_type(sequence_meta.seqtypid,-1)||'|'||sequence_meta.seqstart::text||'|'||sequence_meta.seqincrement::text||'|'||sequence_meta.seqmin::text||'|'||sequence_meta.seqmax::text||'|'||sequence_meta.seqcache::text||'|'||sequence_meta.seqcycle::text FROM pg_class sequence_rel JOIN pg_namespace sequence_namespace ON sequence_namespace.oid=sequence_rel.relnamespace JOIN pg_sequence sequence_meta ON sequence_meta.seqrelid=sequence_rel.oid JOIN pg_depend dependency ON dependency.classid='pg_class'::regclass AND dependency.objid=sequence_rel.oid AND dependency.refclassid='pg_class'::regclass AND dependency.deptype='a' JOIN pg_class owner_rel ON owner_rel.oid=dependency.refobjid JOIN pg_namespace owner_namespace ON owner_namespace.oid=owner_rel.relnamespace JOIN pg_attribute owner_attribute ON owner_attribute.attrelid=owner_rel.oid AND owner_attribute.attnum=dependency.refobjsubid WHERE sequence_namespace.nspname='public' AND owner_namespace.nspname='public' AND owner_rel.relname IN ${CANONICAL_TABLE_SQL} AND sequence_meta.seqtypid='integer'::regtype ORDER BY owner_rel.relname,owner_attribute.attnum LIMIT 1;")"
[[ "$ownedSequence" == *'|'* ]] || Fail 'canonical schema has no integer serial-owned sequence for generation and option drift'
IFS='|' read -r sequenceTable sequenceColumn sequenceName sequenceType sequenceStart sequenceIncrement sequenceMin sequenceMax sequenceCache sequenceCycle <<<"$ownedSequence"

for identityKind in 'BY DEFAULT' 'ALWAYS'; do
    identityStage="identity-generation-$(printf '%s' "$identityKind" | tr '[:upper:] ' '[:lower:]-')"
    PostgresSql --command "ALTER TABLE public.${sequenceTable} ALTER COLUMN ${sequenceColumn} DROP DEFAULT; ALTER SEQUENCE public.${sequenceName} OWNED BY NONE; DROP SEQUENCE public.${sequenceName}; ALTER TABLE public.${sequenceTable} ALTER COLUMN ${sequenceColumn} ADD GENERATED ${identityKind} AS IDENTITY (SEQUENCE NAME public.${sequenceName} START WITH ${sequenceStart} INCREMENT BY ${sequenceIncrement} MINVALUE ${sequenceMin} MAXVALUE ${sequenceMax} CACHE ${sequenceCache} NO CYCLE);" >/dev/null
    ExpectVerifierFailure "$identityStage"
    PostgresSql --command "ALTER TABLE public.${sequenceTable} ALTER COLUMN ${sequenceColumn} DROP IDENTITY;" >/dev/null
    RestoreOwnedSequence "$sequenceTable" "$sequenceColumn" "$sequenceName" "$sequenceType" "$sequenceStart" "$sequenceIncrement" "$sequenceMin" "$sequenceMax" "$sequenceCache" "$sequenceCycle"
    RunStartupVerifier >/dev/null
done

sequenceStartDrift="$(node --input-type=module -e "process.stdout.write(String(BigInt('$sequenceStart') + 1n))")"
sequenceIncrementDrift="$(node --input-type=module -e "process.stdout.write(String(BigInt('$sequenceIncrement') + 1n))")"
sequenceMaxDrift="$(node --input-type=module -e "process.stdout.write(String(BigInt('$sequenceMax') - 1n))")"
sequenceCacheDrift="$(node --input-type=module -e "process.stdout.write(String(BigInt('$sequenceCache') + 1n))")"
sequenceCycleDrift='CYCLE'
sequenceCycleRestore='NO CYCLE'
if [[ "$sequenceCycle" == true ]]; then
    sequenceCycleDrift='NO CYCLE'
    sequenceCycleRestore='CYCLE'
fi

PostgresSql --command "ALTER SEQUENCE public.${sequenceName} START WITH ${sequenceStartDrift};" >/dev/null
ExpectVerifierFailure sequence-start
PostgresSql --command "ALTER SEQUENCE public.${sequenceName} START WITH ${sequenceStart};" >/dev/null
RunStartupVerifier >/dev/null

PostgresSql --command "ALTER SEQUENCE public.${sequenceName} INCREMENT BY ${sequenceIncrementDrift};" >/dev/null
ExpectVerifierFailure sequence-increment
PostgresSql --command "ALTER SEQUENCE public.${sequenceName} INCREMENT BY ${sequenceIncrement};" >/dev/null
RunStartupVerifier >/dev/null

PostgresSql --command "ALTER SEQUENCE public.${sequenceName} MINVALUE 0;" >/dev/null
ExpectVerifierFailure sequence-minimum
PostgresSql --command "ALTER SEQUENCE public.${sequenceName} MINVALUE ${sequenceMin};" >/dev/null
RunStartupVerifier >/dev/null

PostgresSql --command "ALTER SEQUENCE public.${sequenceName} MAXVALUE ${sequenceMaxDrift};" >/dev/null
ExpectVerifierFailure sequence-maximum
PostgresSql --command "ALTER SEQUENCE public.${sequenceName} MAXVALUE ${sequenceMax};" >/dev/null
RunStartupVerifier >/dev/null

PostgresSql --command "ALTER SEQUENCE public.${sequenceName} CACHE ${sequenceCacheDrift};" >/dev/null
ExpectVerifierFailure sequence-cache
PostgresSql --command "ALTER SEQUENCE public.${sequenceName} CACHE ${sequenceCache};" >/dev/null
RunStartupVerifier >/dev/null

PostgresSql --command "ALTER SEQUENCE public.${sequenceName} ${sequenceCycleDrift};" >/dev/null
ExpectVerifierFailure sequence-cycle
PostgresSql --command "ALTER SEQUENCE public.${sequenceName} ${sequenceCycleRestore};" >/dev/null
RunStartupVerifier >/dev/null

PostgresSql --command "ALTER SEQUENCE public.${sequenceName} AS bigint;" >/dev/null
ExpectVerifierFailure sequence-data-type
PostgresSql --command "ALTER SEQUENCE public.${sequenceName} AS ${sequenceType};" >/dev/null
RunStartupVerifier >/dev/null

renamedSequence="${sequenceName}_drift_${RUN_TOKEN}"
PostgresSql --command "ALTER SEQUENCE public.${sequenceName} RENAME TO ${renamedSequence};" >/dev/null
ExpectVerifierFailure sequence-name
PostgresSql --command "ALTER SEQUENCE public.${renamedSequence} RENAME TO ${sequenceName};" >/dev/null
RunStartupVerifier >/dev/null

sequenceShadowSchema="current_schema_sequence_shadow_${RUN_TOKEN}"
PostgresSql --command "CREATE SCHEMA ${sequenceShadowSchema}; ALTER SEQUENCE public.${sequenceName} OWNED BY NONE; ALTER SEQUENCE public.${sequenceName} SET SCHEMA ${sequenceShadowSchema};" >/dev/null
ExpectVerifierFailure sequence-schema
PostgresSql --command "ALTER SEQUENCE ${sequenceShadowSchema}.${sequenceName} SET SCHEMA public; ALTER SEQUENCE public.${sequenceName} OWNED BY public.${sequenceTable}.${sequenceColumn}; DROP SCHEMA ${sequenceShadowSchema};" >/dev/null
RunStartupVerifier >/dev/null

PostgresSql --command "ALTER SEQUENCE public.${sequenceName} OWNED BY NONE;" >/dev/null
ExpectVerifierFailure sequence-ownership
PostgresSql --command "ALTER SEQUENCE public.${sequenceName} OWNED BY public.${sequenceTable}.${sequenceColumn};" >/dev/null
RunStartupVerifier >/dev/null

ownedDeferrableConstraint="$(PostgresScalar "SELECT quote_ident(table_rel.relname)||'|'||quote_ident(constraint_meta.conname)||'|'||constraint_meta.contype::text||'|'||(SELECT string_agg(quote_ident(attribute_meta.attname),',' ORDER BY key_position.ordinality) FROM unnest(constraint_meta.conkey) WITH ORDINALITY key_position(attnum,ordinality) JOIN pg_attribute attribute_meta ON attribute_meta.attrelid=constraint_meta.conrelid AND attribute_meta.attnum=key_position.attnum)||'|'||pg_get_constraintdef(constraint_meta.oid,false) FROM pg_constraint constraint_meta JOIN pg_class table_rel ON table_rel.oid=constraint_meta.conrelid JOIN pg_namespace table_namespace ON table_namespace.oid=table_rel.relnamespace WHERE table_namespace.nspname='public' AND table_rel.relname IN ${CANONICAL_TABLE_SQL} AND constraint_meta.contype IN ('p','u') AND NOT EXISTS (SELECT 1 FROM pg_constraint referencing WHERE referencing.confrelid=constraint_meta.conrelid AND referencing.oid<>constraint_meta.oid) ORDER BY CASE constraint_meta.contype WHEN 'p' THEN 0 ELSE 1 END,table_rel.relname,constraint_meta.conname LIMIT 1;")"
[[ "$ownedDeferrableConstraint" == *'|'* ]] || Fail 'canonical schema has no unreferenced owned PK/UNIQUE constraint for deferrability drift'
IFS='|' read -r deferrableTable deferrableName deferrableKind deferrableColumns deferrableOriginalDefinition <<<"$ownedDeferrableConstraint"
deferrableClause='PRIMARY KEY'
[[ "$deferrableKind" == u ]] && deferrableClause='UNIQUE'
PostgresSql --command "ALTER TABLE public.${deferrableTable} DROP CONSTRAINT ${deferrableName}; ALTER TABLE public.${deferrableTable} ADD CONSTRAINT ${deferrableName} ${deferrableClause} (${deferrableColumns}) DEFERRABLE INITIALLY IMMEDIATE;" >/dev/null
ExpectVerifierFailure constraint-deferrable
RestoreOwnedConstraint "$deferrableTable" "$deferrableName" "$deferrableOriginalDefinition"
PostgresSql --command "ALTER TABLE public.${deferrableTable} DROP CONSTRAINT ${deferrableName}; ALTER TABLE public.${deferrableTable} ADD CONSTRAINT ${deferrableName} ${deferrableClause} (${deferrableColumns}) DEFERRABLE INITIALLY DEFERRED;" >/dev/null
ExpectVerifierFailure constraint-initially-deferred
RestoreOwnedConstraint "$deferrableTable" "$deferrableName" "$deferrableOriginalDefinition"

constraintValidatedCovered=0
ownedCheckConstraint="$(PostgresScalar "SELECT quote_ident(table_rel.relname)||'|'||quote_ident(constraint_meta.conname)||'|'||pg_get_constraintdef(constraint_meta.oid,false) FROM pg_constraint constraint_meta JOIN pg_class table_rel ON table_rel.oid=constraint_meta.conrelid JOIN pg_namespace table_namespace ON table_namespace.oid=table_rel.relnamespace WHERE table_namespace.nspname='public' AND table_rel.relname IN ${CANONICAL_TABLE_SQL} AND constraint_meta.contype='c' ORDER BY table_rel.relname,constraint_meta.conname LIMIT 1;")"
if [[ "$ownedCheckConstraint" == *'|'* ]]; then
    IFS='|' read -r checkTable checkName checkOriginalDefinition <<<"$ownedCheckConstraint"
    PostgresSql --command "ALTER TABLE public.${checkTable} DROP CONSTRAINT ${checkName}; ALTER TABLE public.${checkTable} ADD CONSTRAINT ${checkName} ${checkOriginalDefinition} NOT VALID;" >/dev/null
    ExpectVerifierFailure constraint-validated
    RestoreOwnedConstraint "$checkTable" "$checkName" "$checkOriginalDefinition"
    constraintValidatedCovered=1
fi

ownedForeignKey="$(PostgresScalar "SELECT quote_ident(local_rel.relname)||'|'||quote_ident(constraint_meta.conname)||'|'||(SELECT string_agg(quote_ident(attribute_meta.attname),',' ORDER BY key_position.ordinality) FROM unnest(constraint_meta.conkey) WITH ORDINALITY key_position(attnum,ordinality) JOIN pg_attribute attribute_meta ON attribute_meta.attrelid=constraint_meta.conrelid AND attribute_meta.attnum=key_position.attnum)||'|'||quote_ident(referenced_namespace.nspname)||'|'||quote_ident(referenced_rel.relname)||'|'||(SELECT string_agg(quote_ident(attribute_meta.attname),',' ORDER BY key_position.ordinality) FROM unnest(constraint_meta.confkey) WITH ORDINALITY key_position(attnum,ordinality) JOIN pg_attribute attribute_meta ON attribute_meta.attrelid=constraint_meta.confrelid AND attribute_meta.attnum=key_position.attnum)||'|'||pg_get_constraintdef(constraint_meta.oid,false) FROM pg_constraint constraint_meta JOIN pg_class local_rel ON local_rel.oid=constraint_meta.conrelid JOIN pg_namespace local_namespace ON local_namespace.oid=local_rel.relnamespace JOIN pg_class referenced_rel ON referenced_rel.oid=constraint_meta.confrelid JOIN pg_namespace referenced_namespace ON referenced_namespace.oid=referenced_rel.relnamespace WHERE local_namespace.nspname='public' AND local_rel.relname IN ${CANONICAL_TABLE_SQL} AND constraint_meta.contype='f' ORDER BY local_rel.relname,constraint_meta.conname LIMIT 1;")"
if [[ "$ownedForeignKey" == *'|'* ]]; then
    IFS='|' read -r foreignKeyTable foreignKeyName foreignKeyColumns referencedSchema referencedTable referencedColumns foreignKeyOriginalDefinition <<<"$ownedForeignKey"
    foreignKeyBase="FOREIGN KEY (${foreignKeyColumns}) REFERENCES ${referencedSchema}.${referencedTable} (${referencedColumns}) MATCH SIMPLE ON UPDATE NO ACTION ON DELETE NO ACTION"

    if [[ "$constraintValidatedCovered" == 0 ]]; then
        PostgresSql --command "ALTER TABLE public.${foreignKeyTable} DROP CONSTRAINT ${foreignKeyName}; ALTER TABLE public.${foreignKeyTable} ADD CONSTRAINT ${foreignKeyName} ${foreignKeyBase} NOT VALID;" >/dev/null
        ExpectVerifierFailure constraint-validated
        RestoreOwnedConstraint "$foreignKeyTable" "$foreignKeyName" "$foreignKeyOriginalDefinition"
        constraintValidatedCovered=1
    fi

    PostgresSql --command "ALTER TABLE public.${foreignKeyTable} DROP CONSTRAINT ${foreignKeyName}; ALTER TABLE public.${foreignKeyTable} ADD CONSTRAINT ${foreignKeyName} FOREIGN KEY (${foreignKeyColumns}) REFERENCES ${referencedSchema}.${referencedTable} (${referencedColumns}) MATCH SIMPLE ON UPDATE CASCADE ON DELETE NO ACTION;" >/dev/null
    ExpectVerifierFailure foreign-key-update-action
    RestoreOwnedConstraint "$foreignKeyTable" "$foreignKeyName" "$foreignKeyOriginalDefinition"

    PostgresSql --command "ALTER TABLE public.${foreignKeyTable} DROP CONSTRAINT ${foreignKeyName}; ALTER TABLE public.${foreignKeyTable} ADD CONSTRAINT ${foreignKeyName} FOREIGN KEY (${foreignKeyColumns}) REFERENCES ${referencedSchema}.${referencedTable} (${referencedColumns}) MATCH SIMPLE ON UPDATE NO ACTION ON DELETE CASCADE;" >/dev/null
    ExpectVerifierFailure foreign-key-delete-action
    RestoreOwnedConstraint "$foreignKeyTable" "$foreignKeyName" "$foreignKeyOriginalDefinition"

    PostgresSql --command "ALTER TABLE public.${foreignKeyTable} DROP CONSTRAINT ${foreignKeyName}; ALTER TABLE public.${foreignKeyTable} ADD CONSTRAINT ${foreignKeyName} FOREIGN KEY (${foreignKeyColumns}) REFERENCES ${referencedSchema}.${referencedTable} (${referencedColumns}) MATCH FULL ON UPDATE NO ACTION ON DELETE NO ACTION;" >/dev/null
    ExpectVerifierFailure foreign-key-match-type
    RestoreOwnedConstraint "$foreignKeyTable" "$foreignKeyName" "$foreignKeyOriginalDefinition"

    foreignKeyShadowSchema="current_schema_fk_shadow_${RUN_TOKEN}"
    PostgresSql --command "CREATE SCHEMA ${foreignKeyShadowSchema}; CREATE TABLE ${foreignKeyShadowSchema}.${referencedTable} (LIKE ${referencedSchema}.${referencedTable} INCLUDING ALL); ALTER TABLE public.${foreignKeyTable} DROP CONSTRAINT ${foreignKeyName}; ALTER TABLE public.${foreignKeyTable} ADD CONSTRAINT ${foreignKeyName} FOREIGN KEY (${foreignKeyColumns}) REFERENCES ${foreignKeyShadowSchema}.${referencedTable} (${referencedColumns}) MATCH SIMPLE ON UPDATE NO ACTION ON DELETE NO ACTION;" >/dev/null
    ExpectVerifierFailure foreign-key-referenced-schema
    RestoreOwnedConstraint "$foreignKeyTable" "$foreignKeyName" "$foreignKeyOriginalDefinition"
    PostgresSql --command "DROP SCHEMA ${foreignKeyShadowSchema} CASCADE;" >/dev/null
    RunStartupVerifier >/dev/null
else
    if [[ "$constraintValidatedCovered" == 0 ]]; then
        WriteNotApplicableEvidence constraint-validated 'canonical schema exposes no owned CHECK or foreign-key constraint whose validation state PostgreSQL can mark NOT VALID'
        WriteStageReceipt constraint-validated not-applicable 'canonical schema exposes no owned CHECK or foreign-key constraint whose validation state PostgreSQL can mark NOT VALID'
    fi
    for foreignKeyOnlyStage in foreign-key-update-action foreign-key-delete-action foreign-key-match-type foreign-key-referenced-schema; do
        WriteNotApplicableEvidence "$foreignKeyOnlyStage" 'canonical schema exposes no owned foreign-key constraint; lane did not create a second authority to manufacture coverage'
        WriteStageReceipt "$foreignKeyOnlyStage" not-applicable 'canonical schema exposes no owned foreign-key constraint; lane did not create a second authority to manufacture coverage'
    done
fi

WriteStageReceipt stale-envelope-cluster-swap rejected "unchanged canonical old-instance envelope failed exact PostgreSQL system_identifier admission on the same host port; replacement catalog remained byte-identical at ${staleCatalogDigest}; no prepared, verified, or runtime-ready receipt"

terminalPrepared="$OUTPUT_ROOT/terminal.prepared.json"
terminalFinal="$OUTPUT_ROOT/terminal.json"
STAGE_RECEIPT_LIST="$(IFS=:; printf '%s' "${STAGE_RECEIPTS[*]}")" \
POSITIVE_READY="$(RuntimeReadyPath "$positiveRunId")" \
SOURCE_COMMIT_VALUE="$SOURCE_COMMIT" RUN_ID_VALUE="$RUN_PREFIX" OUTPUT_ROOT_VALUE="$OUTPUT_ROOT" \
ROOT_DIR_VALUE="$ROOT_DIR" \
MATRIX_FILE_VALUE="$MATRIX_FILE" COVERAGE_REGISTRY_VALUE="$COVERAGE_REGISTRY_FILE" \
MATRIX_PARSER_VALUE="$MATRIX_PARSER_FILE" \
MATRIX_PARSER_DEPENDENCY_VALUE="$MATRIX_PARSER_DEPENDENCY_FILE" \
SOURCE_MATRIX_PARSER_VALUE="$SOURCE_MATRIX_PARSER_FILE" \
SOURCE_MATRIX_PARSER_DEPENDENCY_VALUE="$SOURCE_MATRIX_PARSER_DEPENDENCY_FILE" \
    node --input-type=module - "$terminalPrepared" <<'NODE'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const output = process.argv[2]
const stageFiles = process.env.STAGE_RECEIPT_LIST.split(':')
const stages = stageFiles.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value
const contentDigest = (value) => {
  const unsigned = { ...value, contentDigest: null }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(unsigned))).digest('hex')}`
}
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const committedBytes = (relativePath) => execFileSync(
  'git',
  ['-C', process.env.ROOT_DIR_VALUE, 'show', `${process.env.SOURCE_COMMIT_VALUE}:${relativePath}`]
)
const matrixBytes = committedBytes('tests/matrix.yml')
const coverageRegistryBytes = committedBytes('tests/coverage-registry.json')
const matrixParserBytes = committedBytes('tools/test-matrix/parse-matrix.mjs')
const matrixParserDependencyBytes = committedBytes('tools/yaml/parse-document.mjs')
assert.equal(digest(fs.readFileSync(process.env.MATRIX_FILE_VALUE)), digest(matrixBytes))
assert.equal(digest(fs.readFileSync(process.env.COVERAGE_REGISTRY_VALUE)), digest(coverageRegistryBytes))
assert.equal(digest(fs.readFileSync(process.env.MATRIX_PARSER_VALUE)), digest(matrixParserBytes))
assert.equal(digest(fs.readFileSync(process.env.MATRIX_PARSER_DEPENDENCY_VALUE)), digest(matrixParserDependencyBytes))
assert.equal(digest(fs.readFileSync(process.env.SOURCE_MATRIX_PARSER_VALUE)), digest(matrixParserBytes))
assert.equal(digest(fs.readFileSync(process.env.SOURCE_MATRIX_PARSER_DEPENDENCY_VALUE)), digest(matrixParserDependencyBytes))
const { parseMatrix } = await import(pathToFileURL(process.env.SOURCE_MATRIX_PARSER_VALUE))
const matrix = parseMatrix(matrixBytes.toString('utf8'))
const tier = matrix.tiers.find((entry) => entry.id === 'current-schema-bootstrap-integration')
assert.ok(tier, 'canonical current-schema bootstrap matrix tier is missing')
assert.ok(tier.coverage.includes('current-schema-receipt-lifecycle'))
const coverageRegistry = JSON.parse(coverageRegistryBytes.toString('utf8'))
assert.equal(coverageRegistry.schema, 'fsusblog.coverage-registry.v1')
const coverageEntry = coverageRegistry.entries.find(
  (entry) => entry.id === 'current-schema-receipt-lifecycle'
)
assert.ok(coverageEntry, 'canonical current-schema receipt lifecycle coverage entry is missing')
assert.deepEqual(coverageEntry.tierIds, [tier.id])
const mandatoryStageRoster = coverageEntry.stageRoster
const allowedNotApplicableStages = coverageEntry.allowedNotApplicableStages
const requiredRetainedEvidenceKinds = coverageEntry.requiredRetainedEvidenceKinds
const requiredRawCatalogFacts = coverageEntry.requiredRawCatalogFacts
for (const [label, values] of [
  ['stage roster', mandatoryStageRoster],
  ['allowed not-applicable stages', allowedNotApplicableStages],
  ['required retained evidence kinds', requiredRetainedEvidenceKinds],
  ['required raw catalog facts', requiredRawCatalogFacts]
])
{
  assert.ok(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array`)
  assert.ok(values.every((value) => typeof value === 'string' && value.length > 0))
  assert.equal(new Set(values).size, values.length, `${label} must be unique`)
}
assert.ok(allowedNotApplicableStages.every((stage) => mandatoryStageRoster.includes(stage)))
for (const stage of stages)
{
  assert.equal(stage.schema, 'fsusblog.current-schema-bootstrap-integration-stage.v1')
  assert.ok(stage.status === 'verified' || stage.status === 'not-applicable')
  assert.equal(stage.qualificationEligible, stage.status === 'verified')
  assert.equal(stage.contentDigest, contentDigest(stage))
}
const actualStageNames = stages.map((stage) => stage.stage)
assert.equal(stages.length, mandatoryStageRoster.length)
assert.equal(new Set(actualStageNames).size, actualStageNames.length)
assert.deepEqual(actualStageNames, mandatoryStageRoster)
const notApplicableStages = stages.filter((stage) => stage.status === 'not-applicable')
for (const stage of notApplicableStages)
{
  assert.ok(allowedNotApplicableStages.includes(stage.stage), `unexpected not-applicable stage: ${stage.stage}`)
  assert.equal(stage.expectedOutcome, 'not-applicable')
  assert.ok(stage.detail.length > 0)
}
for (const stage of stages.filter((entry) => entry.status === 'verified'))
{
  const expected = stage.stage === 'positive' || stage.stage === 'type-default-precision'
    ? 'verified'
    : 'rejected'
  assert.equal(stage.expectedOutcome, expected)
}
const runtimeReadyBytes = fs.readFileSync(process.env.POSITIVE_READY)
const runtimeReady = JSON.parse(runtimeReadyBytes)
assert.equal(runtimeReady.schema, 'fsusblog.current-schema-runtime-ready.v1')
assert.equal(runtimeReady.status, 'verified')
assert.equal(runtimeReady.qualificationEligible, true)
assert.equal(runtimeReady.sourceCommit, process.env.SOURCE_COMMIT_VALUE)
assert.equal(runtimeReady.contentDigest, contentDigest(runtimeReady))
const classify = (name) => {
  if (name.startsWith('stage-')) return 'stage-receipt'
  if (name.startsWith('evidence-')) return 'command-evidence'
  if (name.endsWith('-service-envelope.json')) return 'service-envelope'
  if (name.startsWith('current-schema-test-materialization-')) return 'materializer-receipt'
  if (name.startsWith('current-schema-runtime-ready-')) return 'runtime-ready-receipt'
  if (name.endsWith('.facts')) return 'raw-catalog-facts'
  if (name.endsWith('.log')) return 'command-log'
  return 'supporting-evidence'
}
const outputEntries = fs.readdirSync(process.env.OUTPUT_ROOT_VALUE, { withFileTypes: true })
for (const entry of outputEntries)
{
  assert.equal(entry.name.startsWith('terminal.'), false, `run evidence root contains a preexisting terminal authority: ${entry.name}`)
  assert.ok(entry.isFile(), `run evidence root contains a non-regular entry: ${entry.name}`)
  const entryPath = path.join(process.env.OUTPUT_ROOT_VALUE, entry.name)
  const stat = fs.lstatSync(entryPath)
  assert.equal(stat.isSymbolicLink(), false, `run evidence root contains a symlink: ${entry.name}`)
  assert.equal(stat.nlink, 1, `run evidence root contains a hardlink alias: ${entry.name}`)
  assert.equal(fs.realpathSync(entryPath), entryPath, `run evidence path is not canonical: ${entry.name}`)
}
const bundleInventory = outputEntries
  .map((entry) => {
    const absolutePath = path.join(process.env.OUTPUT_ROOT_VALUE, entry.name)
    const bytes = fs.readFileSync(absolutePath)
    return {
      path: absolutePath,
      relativePath: entry.name,
      kind: classify(entry.name),
      bytes: bytes.length,
      sha256: digest(bytes)
    }
  })
  .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
for (const requiredKind of requiredRetainedEvidenceKinds)
{
  assert.ok(bundleInventory.some((entry) => entry.kind === requiredKind), `bundle omitted ${requiredKind}`)
}
assert.deepEqual(
  bundleInventory
    .filter((entry) => entry.kind === 'raw-catalog-facts')
    .map((entry) => entry.relativePath),
  requiredRawCatalogFacts
)
const services = [...new Map(stages
  .flatMap((stage) => stage.commandEvidence)
  .map((evidence) => [`${evidence.container.id}:${evidence.database.systemIdentifier}`, {
    container: evidence.container,
    database: evidence.database
  }])).values()]
const terminal = {
  schema: 'fsusblog.current-schema-bootstrap-integration.v1',
  status: 'verified',
  qualificationEligible: true,
  runId: process.env.RUN_ID_VALUE,
  sourceCommit: process.env.SOURCE_COMMIT_VALUE,
  stagePolicy: {
    authority: {
      matrix: {
        path: process.env.MATRIX_FILE_VALUE,
        sha256: digest(matrixBytes),
        tierId: tier.id,
        coverageIds: tier.coverage,
        parser: {
          path: process.env.MATRIX_PARSER_VALUE,
          sha256: digest(matrixParserBytes),
          dependencyPath: process.env.MATRIX_PARSER_DEPENDENCY_VALUE,
          dependencySha256: digest(matrixParserDependencyBytes)
        }
      },
      coverageRegistry: {
        path: process.env.COVERAGE_REGISTRY_VALUE,
        sha256: digest(coverageRegistryBytes),
        coverageId: coverageEntry.id
      }
    },
    mandatoryRoster: mandatoryStageRoster,
    exactCount: mandatoryStageRoster.length,
    uniqueCount: new Set(actualStageNames).size,
    allowedNotApplicableStages,
    requiredRetainedEvidenceKinds,
    requiredRawCatalogFacts,
    notApplicableStages: notApplicableStages.map((stage) => ({ stage: stage.stage, detail: stage.detail })),
    disposition: 'all mandatory stages are present exactly once; not-applicable is accepted only from the explicit allowlist and remains visible'
  },
  services,
  runtimeReady: {
    path: process.env.POSITIVE_READY,
    sha256: digest(runtimeReadyBytes),
    contentDigest: runtimeReady.contentDigest
  },
  stages: stages.map((stage, index) => ({
    ordinal: index + 1,
    path: stageFiles[index],
    sha256: digest(fs.readFileSync(stageFiles[index])),
    stage: stage.stage,
    status: stage.status,
    qualificationEligible: stage.qualificationEligible,
    expectedOutcome: stage.expectedOutcome,
    firstFailure: stage.firstFailure,
    commandEvidence: stage.commandEvidence,
    contentDigest: stage.contentDigest
  })),
  bundleInventory,
  firstFailures: stages
    .filter((stage) => stage.firstFailure !== null)
    .map((stage) => ({ stage: stage.stage, firstFailure: stage.firstFailure })),
  contentDigest: null
}
terminal.contentDigest = digest(JSON.stringify(canonicalize(terminal)))
fs.writeFileSync(output, `${JSON.stringify(terminal, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
NODE

MATRIX_FILE_VALUE="$MATRIX_FILE" COVERAGE_REGISTRY_VALUE="$COVERAGE_REGISTRY_FILE" \
MATRIX_PARSER_VALUE="$MATRIX_PARSER_FILE" \
MATRIX_PARSER_DEPENDENCY_VALUE="$MATRIX_PARSER_DEPENDENCY_FILE" \
SOURCE_MATRIX_PARSER_VALUE="$SOURCE_MATRIX_PARSER_FILE" \
SOURCE_MATRIX_PARSER_DEPENDENCY_VALUE="$SOURCE_MATRIX_PARSER_DEPENDENCY_FILE" \
SOURCE_COMMIT_VALUE="$SOURCE_COMMIT" ROOT_DIR_VALUE="$ROOT_DIR" \
POSITIVE_RUN_ID_VALUE="$positiveRunId" POSITIVE_ENVELOPE_VALUE="$positiveEnvelope" \
SERVER_DLL_VALUE="$SERVER_DLL" CATALOG_FILE_VALUE="$CATALOG_FILE" \
RECEIPT_VERIFIER_VALUE="$SOURCE_RECEIPT_VERIFIER" CONNECTION_STRING_VALUE="$CONNECTION_STRING" \
    node --input-type=module - "$terminalPrepared" "$terminalFinal" "$OUTPUT_ROOT" <<'NODE'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [terminalPath, terminalFinalPath, outputRoot] = process.argv.slice(2)
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const contentDigest = (value) => digest(JSON.stringify(canonicalize({ ...value, contentDigest: null })))
const requireExactKeys = (value, keys, label) => assert.deepEqual(
  Object.keys(value).sort(),
  [...keys].sort(),
  `${label} key set mismatch`
)
const materializerExpectedCodes = new Map([
  ['partial-schema', 'current_schema_materializer_public_schema_not_empty'],
  ['composite-type', 'current_schema_materializer_public_schema_not_empty'],
  ['nonrelation-object', 'current_schema_materializer_public_schema_not_empty'],
  ['publication-fault', 'current_schema_materializer_publication_fault_after_commit']
])
const readPinnedSingleLink = (file, label) => {
  const resolved = path.resolve(file)
  assert.equal(resolved, file, `${label} path is not canonical`)
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try
  {
    const before = fs.fstatSync(fd, { bigint: true })
    assert.ok(before.isFile(), `${label} is not a regular file`)
    assert.equal(before.nlink, 1n, `${label} is not single-link`)
    const bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd, { bigint: true })
    const pathStat = fs.lstatSync(resolved, { bigint: true })
    for (const field of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
    {
      assert.equal(before[field], after[field], `${label} changed during read: ${field}`)
      assert.equal(after[field], pathStat[field], `${label} path changed during read: ${field}`)
    }
    assert.equal(fs.realpathSync(resolved), resolved, `${label} path is not physical`)
    return {
      bytes,
      stat: Object.fromEntries(
        ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
          .map((field) => [field, after[field]])
      )
    }
  }
  finally
  {
    fs.closeSync(fd)
  }
}
const terminalBytes = readPinnedSingleLink(terminalPath, 'prepared terminal').bytes
const terminal = JSON.parse(terminalBytes.toString('utf8'))
requireExactKeys(terminal, [
  'schema', 'status', 'qualificationEligible', 'runId', 'sourceCommit', 'stagePolicy',
  'services', 'runtimeReady', 'stages', 'bundleInventory', 'firstFailures', 'contentDigest'
], 'terminal')
requireExactKeys(terminal.stagePolicy, [
  'authority', 'mandatoryRoster', 'exactCount', 'uniqueCount', 'allowedNotApplicableStages',
  'requiredRetainedEvidenceKinds', 'requiredRawCatalogFacts', 'notApplicableStages',
  'disposition'
], 'terminal stage policy')
requireExactKeys(terminal.stagePolicy.authority, ['matrix', 'coverageRegistry'], 'terminal stage policy authority')
requireExactKeys(terminal.stagePolicy.authority.matrix, [
  'path', 'sha256', 'tierId', 'coverageIds', 'parser'
], 'terminal matrix authority')
requireExactKeys(terminal.stagePolicy.authority.matrix.parser, [
  'path', 'sha256', 'dependencyPath', 'dependencySha256'
], 'terminal matrix parser authority')
requireExactKeys(terminal.stagePolicy.authority.coverageRegistry, ['path', 'sha256', 'coverageId'], 'terminal coverage authority')
requireExactKeys(terminal.runtimeReady, ['path', 'sha256', 'contentDigest'], 'terminal runtime-ready binding')
for (const item of terminal.stagePolicy.notApplicableStages)
{
  requireExactKeys(item, ['stage', 'detail'], 'terminal not-applicable stage')
}
for (const item of terminal.services)
{
  requireExactKeys(item, ['container', 'database'], 'terminal service')
  requireExactKeys(item.container, ['name', 'id', 'image', 'network'], 'terminal service container')
  requireExactKeys(item.database, ['host', 'port', 'name', 'oid', 'systemIdentifier'], 'terminal service database')
}
for (const item of terminal.bundleInventory)
{
  requireExactKeys(item, ['path', 'relativePath', 'kind', 'bytes', 'sha256'], 'terminal bundle entry')
}
for (const item of terminal.firstFailures)
{
  requireExactKeys(item, ['stage', 'firstFailure'], 'terminal first failure')
}
assert.equal(terminal.schema, 'fsusblog.current-schema-bootstrap-integration.v1')
assert.equal(terminal.status, 'verified')
assert.equal(terminal.qualificationEligible, true)
assert.equal(terminal.sourceCommit, process.env.SOURCE_COMMIT_VALUE)
const unsigned = { ...terminal, contentDigest: null }
assert.equal(terminal.contentDigest, digest(JSON.stringify(canonicalize(unsigned))))
const committedBytes = (relativePath) => execFileSync(
  'git',
  ['-C', process.env.ROOT_DIR_VALUE, 'show', `${process.env.SOURCE_COMMIT_VALUE}:${relativePath}`]
)
const matrixBytes = committedBytes('tests/matrix.yml')
const coverageRegistryBytes = committedBytes('tests/coverage-registry.json')
const matrixParserBytes = committedBytes('tools/test-matrix/parse-matrix.mjs')
const matrixParserDependencyBytes = committedBytes('tools/yaml/parse-document.mjs')
assert.equal(digest(fs.readFileSync(process.env.MATRIX_FILE_VALUE)), digest(matrixBytes))
assert.equal(digest(fs.readFileSync(process.env.COVERAGE_REGISTRY_VALUE)), digest(coverageRegistryBytes))
assert.equal(digest(fs.readFileSync(process.env.MATRIX_PARSER_VALUE)), digest(matrixParserBytes))
assert.equal(digest(fs.readFileSync(process.env.MATRIX_PARSER_DEPENDENCY_VALUE)), digest(matrixParserDependencyBytes))
assert.equal(digest(fs.readFileSync(process.env.SOURCE_MATRIX_PARSER_VALUE)), digest(matrixParserBytes))
assert.equal(digest(fs.readFileSync(process.env.SOURCE_MATRIX_PARSER_DEPENDENCY_VALUE)), digest(matrixParserDependencyBytes))
const { parseMatrix } = await import(pathToFileURL(process.env.SOURCE_MATRIX_PARSER_VALUE))
const matrix = parseMatrix(matrixBytes.toString('utf8'))
const tier = matrix.tiers.find((entry) => entry.id === 'current-schema-bootstrap-integration')
assert.ok(tier)
assert.ok(tier.coverage.includes('current-schema-receipt-lifecycle'))
const coverageRegistry = JSON.parse(coverageRegistryBytes.toString('utf8'))
const coverageEntry = coverageRegistry.entries.find(
  (entry) => entry.id === 'current-schema-receipt-lifecycle'
)
assert.ok(coverageEntry)
assert.deepEqual(coverageEntry.tierIds, [tier.id])
assert.deepEqual(terminal.stagePolicy.authority, {
  matrix: {
    path: process.env.MATRIX_FILE_VALUE,
    sha256: digest(matrixBytes),
    tierId: tier.id,
    coverageIds: tier.coverage,
    parser: {
      path: process.env.MATRIX_PARSER_VALUE,
      sha256: digest(matrixParserBytes),
      dependencyPath: process.env.MATRIX_PARSER_DEPENDENCY_VALUE,
      dependencySha256: digest(matrixParserDependencyBytes)
    }
  },
  coverageRegistry: {
    path: process.env.COVERAGE_REGISTRY_VALUE,
    sha256: digest(coverageRegistryBytes),
    coverageId: coverageEntry.id
  }
})
assert.deepEqual(terminal.stagePolicy.mandatoryRoster, coverageEntry.stageRoster)
assert.deepEqual(
  terminal.stagePolicy.allowedNotApplicableStages,
  coverageEntry.allowedNotApplicableStages
)
assert.deepEqual(
  terminal.stagePolicy.requiredRetainedEvidenceKinds,
  coverageEntry.requiredRetainedEvidenceKinds
)
assert.deepEqual(terminal.stagePolicy.requiredRawCatalogFacts, coverageEntry.requiredRawCatalogFacts)
assert.equal(terminal.stagePolicy.exactCount, terminal.stagePolicy.mandatoryRoster.length)
assert.equal(terminal.stagePolicy.uniqueCount, terminal.stagePolicy.exactCount)
assert.equal(
  terminal.stagePolicy.disposition,
  'all mandatory stages are present exactly once; not-applicable is accepted only from the explicit allowlist and remains visible'
)
assert.deepEqual(terminal.stages.map((stage) => stage.stage), terminal.stagePolicy.mandatoryRoster)
const actualEntries = fs.readdirSync(outputRoot, { withFileTypes: true })
for (const entry of actualEntries)
{
  if (entry.name.startsWith('terminal.'))
  {
    assert.equal(entry.name, path.basename(terminalPath), `run evidence root contains an unexpected terminal authority: ${entry.name}`)
  }
  assert.ok(entry.isFile(), `run evidence root contains a non-regular entry: ${entry.name}`)
  const entryPath = path.join(outputRoot, entry.name)
  const stat = fs.lstatSync(entryPath)
  assert.equal(stat.isSymbolicLink(), false, `run evidence root contains a symlink: ${entry.name}`)
  assert.equal(stat.nlink, 1, `run evidence root contains a hardlink alias: ${entry.name}`)
  assert.equal(fs.realpathSync(entryPath), entryPath, `run evidence path is not canonical: ${entry.name}`)
}
const actualBundleFiles = actualEntries
  .filter((entry) => entry.name !== path.basename(terminalPath))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right))
assert.deepEqual(terminal.bundleInventory.map((entry) => entry.relativePath), actualBundleFiles)
const bundleSnapshots = new Map(actualBundleFiles.map((name) => {
  const file = path.join(outputRoot, name)
  return [file, readPinnedSingleLink(file, `bundle entry ${name}`)]
}))
const bundleBytes = (file) => {
  const snapshot = bundleSnapshots.get(file)
  assert.ok(snapshot, `unbound bundle path read: ${file}`)
  return snapshot.bytes
}
const boundRuntimeReadyBytes = bundleBytes(terminal.runtimeReady.path)
const boundRuntimeReady = JSON.parse(boundRuntimeReadyBytes)
requireExactKeys(boundRuntimeReady, [
  'schema', 'status', 'qualificationEligible', 'runId', 'sourceCommit',
  'materializationReceipt', 'assembly', 'serviceIdentity', 'databaseIdentity',
  'canonicalIdentity', 'observedDatabaseDigest', 'tableCount', 'candidateVerification',
  'contentDigest'
], 'bound runtime-ready receipt')
assert.equal(terminal.runtimeReady.sha256, digest(boundRuntimeReadyBytes))
assert.equal(terminal.runtimeReady.contentDigest, boundRuntimeReady.contentDigest)
assert.equal(boundRuntimeReady.schema, 'fsusblog.current-schema-runtime-ready.v1')
assert.equal(boundRuntimeReady.status, 'verified')
assert.equal(boundRuntimeReady.qualificationEligible, true)
assert.equal(boundRuntimeReady.runId, process.env.POSITIVE_RUN_ID_VALUE)
assert.equal(boundRuntimeReady.sourceCommit, terminal.sourceCommit)
assert.equal(boundRuntimeReady.contentDigest, contentDigest(boundRuntimeReady))
execFileSync(process.execPath, [
  process.env.RECEIPT_VERIFIER_VALUE,
  '--mode', 'verify',
  '--receipt-root', outputRoot,
  '--run-id', process.env.POSITIVE_RUN_ID_VALUE,
  '--source-commit', process.env.SOURCE_COMMIT_VALUE,
  '--assembly', process.env.SERVER_DLL_VALUE,
  '--service-catalog', process.env.CATALOG_FILE_VALUE,
  '--service-envelope', process.env.POSITIVE_ENVELOPE_VALUE
], {
  env: {
    ...process.env,
    ConnectionStrings__DefaultConnection: `${process.env.CONNECTION_STRING_VALUE};Search Path=public`
  },
  stdio: 'pipe'
})
const runtimeReadyAfterReverify = readPinnedSingleLink(
  terminal.runtimeReady.path,
  'runtime-ready receipt after independent candidate revalidation'
)
assert.equal(digest(runtimeReadyAfterReverify.bytes), digest(boundRuntimeReadyBytes))
const runtimeReadySnapshot = bundleSnapshots.get(terminal.runtimeReady.path)
for (const field of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
{
  assert.equal(
    runtimeReadyAfterReverify.stat[field],
    runtimeReadySnapshot.stat[field],
    `runtime-ready receipt changed across independent candidate revalidation: ${field}`
  )
}
assert.equal(new Set(terminal.bundleInventory.map((entry) => entry.path)).size, terminal.bundleInventory.length)
const bundleByPath = new Map(terminal.bundleInventory.map((entry) => [entry.path, entry]))
for (const entry of terminal.bundleInventory)
{
  assert.equal(entry.path, path.join(outputRoot, entry.relativePath))
  const bytes = bundleBytes(entry.path)
  assert.equal(entry.bytes, bytes.length)
  assert.equal(entry.sha256, digest(bytes))
}
for (const requiredKind of coverageEntry.requiredRetainedEvidenceKinds)
{
  assert.ok(
    terminal.bundleInventory.some((entry) => entry.kind === requiredKind),
    `bundle omitted ${requiredKind}`
  )
}
assert.deepEqual(
  terminal.bundleInventory
    .filter((entry) => entry.kind === 'raw-catalog-facts')
    .map((entry) => entry.relativePath),
  coverageEntry.requiredRawCatalogFacts
)
const stageReceiptPaths = []
const commandEvidencePaths = []
const referencedCommandLogs = new Set()
const referencedCommandArguments = []
const derivedServices = new Map()
const derivedNotApplicableStages = []
const derivedFirstFailures = []
for (const stage of terminal.stages)
{
  requireExactKeys(stage, [
    'ordinal', 'path', 'sha256', 'stage', 'status', 'qualificationEligible',
    'expectedOutcome', 'firstFailure', 'commandEvidence', 'contentDigest'
  ], 'terminal stage binding')
  const bytes = bundleBytes(stage.path)
  stageReceiptPaths.push(stage.path)
  assert.equal(stage.sha256, digest(bytes))
  const receipt = JSON.parse(bytes)
  assert.equal(stage.ordinal, stageReceiptPaths.length)
  requireExactKeys(receipt, [
    'schema', 'status', 'qualificationEligible', 'stage', 'expectedOutcome', 'detail',
    'runId', 'sourceCommit', 'container', 'database', 'commandEvidence', 'firstFailure',
    'contentDigest'
  ], 'stage receipt')
  requireExactKeys(receipt.container, ['name', 'id'], 'stage receipt container')
  requireExactKeys(receipt.database, ['name', 'oid', 'systemIdentifier'], 'stage receipt database')
  assert.equal(receipt.schema, 'fsusblog.current-schema-bootstrap-integration-stage.v1')
  assert.equal(receipt.stage, stage.stage)
  assert.equal(receipt.status, stage.status)
  assert.equal(receipt.qualificationEligible, stage.qualificationEligible)
  assert.equal(receipt.expectedOutcome, stage.expectedOutcome)
  assert.equal(receipt.firstFailure, stage.firstFailure)
  assert.equal(receipt.sourceCommit, terminal.sourceCommit)
  assert.equal(receipt.runId, terminal.runId)
  assert.equal(receipt.contentDigest, contentDigest(receipt))
  assert.equal(receipt.contentDigest, stage.contentDigest)
  assert.deepEqual(receipt.commandEvidence, stage.commandEvidence)
  if (receipt.status === 'not-applicable')
  {
    assert.ok(terminal.stagePolicy.allowedNotApplicableStages.includes(receipt.stage))
    derivedNotApplicableStages.push({ stage: receipt.stage, detail: receipt.detail })
  }
  if (receipt.firstFailure !== null)
  {
    derivedFirstFailures.push({ stage: receipt.stage, firstFailure: receipt.firstFailure })
  }
  for (const command of receipt.commandEvidence)
  {
    requireExactKeys(command, [
      'path', 'sha256', 'contentDigest', 'commandId', 'expectedOutcome', 'command', 'argv',
      'startedAt', 'endedAt', 'exit', 'stdout', 'stderr', 'firstFailure', 'container', 'database'
    ], 'stage command binding')
    requireExactKeys(command.exit, ['status', 'signal'], 'stage command exit')
    requireExactKeys(command.stdout, ['path', 'sha256'], 'stage command stdout')
    requireExactKeys(command.stderr, ['path', 'sha256'], 'stage command stderr')
    requireExactKeys(command.container, ['name', 'id', 'image', 'network'], 'stage command container')
    requireExactKeys(command.database, ['host', 'port', 'name', 'oid', 'systemIdentifier'], 'stage command database')
    const commandBytes = bundleBytes(command.path)
    const evidence = JSON.parse(commandBytes)
    requireExactKeys(evidence, [
      'schema', 'status', 'qualificationEligible', 'stage', 'commandId', 'expectedOutcome',
      'command', 'argv', 'startedAt', 'endedAt', 'exit', 'stdout', 'stderr', 'firstFailure',
      'run', 'container', 'database', 'contentDigest'
    ], 'command evidence')
    requireExactKeys(evidence.exit, ['status', 'signal'], 'command evidence exit')
    requireExactKeys(evidence.stdout, ['path', 'sha256'], 'command evidence stdout')
    requireExactKeys(evidence.stderr, ['path', 'sha256'], 'command evidence stderr')
    requireExactKeys(evidence.run, ['id', 'sourceCommit'], 'command evidence run')
    requireExactKeys(evidence.container, ['name', 'id', 'image', 'network'], 'command evidence container')
    requireExactKeys(evidence.database, ['host', 'port', 'name', 'oid', 'systemIdentifier'], 'command evidence database')
    commandEvidencePaths.push(command.path)
    referencedCommandLogs.add(command.stdout.path)
    referencedCommandLogs.add(command.stderr.path)
    referencedCommandArguments.push(...command.argv)
    assert.equal(command.sha256, digest(commandBytes))
    assert.equal(evidence.schema, 'fsusblog.current-schema-bootstrap-integration-command.v1')
    assert.equal(evidence.status, 'observed')
    assert.equal(evidence.qualificationEligible, false)
    assert.equal(evidence.stage, stage.stage)
    assert.equal(evidence.contentDigest, contentDigest(evidence))
    for (const key of [
      'contentDigest', 'commandId', 'expectedOutcome', 'command', 'argv', 'startedAt', 'endedAt',
      'exit', 'stdout', 'stderr', 'firstFailure', 'container', 'database'
    ])
    {
      assert.deepEqual(command[key], evidence[key])
    }
    assert.equal(evidence.run.id, terminal.runId)
    assert.equal(evidence.run.sourceCommit, terminal.sourceCommit)
    assert.ok(Number.isFinite(Date.parse(evidence.startedAt)))
    assert.ok(Number.isFinite(Date.parse(evidence.endedAt)))
    assert.ok(Date.parse(evidence.endedAt) >= Date.parse(evidence.startedAt))
    assert.equal(
      evidence.exit.signal,
      evidence.exit.status > 128 && evidence.exit.status <= 192
        ? evidence.exit.status - 128
        : null
    )
    if (evidence.expectedOutcome === 'rejected')
    {
      assert.notEqual(evidence.exit.status, 0)
      assert.ok(typeof evidence.firstFailure === 'string' && evidence.firstFailure.length > 0)
      if (evidence.commandId === 'startup-verifier')
      {
        assert.equal(evidence.exit.status, 42)
        assert.equal(evidence.exit.signal, null)
        assert.match(evidence.firstFailure, /^fsusblog\.current-schema-mismatch\.v1:/u)
      }
      if (evidence.commandId === 'materializer' && materializerExpectedCodes.has(stage.stage))
      {
        assert.equal(evidence.exit.status, 1)
        assert.equal(evidence.exit.signal, null)
        const failures = bundleBytes(evidence.stdout.path).toString('utf8')
          .split(/\r?\n/u)
          .filter((line) => line.trim().startsWith('{'))
          .map((line) => JSON.parse(line))
          .filter((document) => document.status === 'failed' && typeof document.code === 'string')
        assert.deepEqual(failures, [{
          status: 'failed',
          code: materializerExpectedCodes.get(stage.stage)
        }])
      }
    }
    else
    {
      assert.ok(['verified', 'not-applicable'].includes(evidence.expectedOutcome))
      assert.equal(evidence.exit.status, 0)
      assert.equal(evidence.firstFailure, null)
    }
    assert.equal(command.stdout.sha256, digest(bundleBytes(command.stdout.path)))
    assert.equal(command.stderr.sha256, digest(bundleBytes(command.stderr.path)))
    assert.equal(bundleByPath.get(command.path)?.kind, 'command-evidence')
    assert.equal(bundleByPath.get(command.stdout.path)?.kind, 'command-log')
    assert.equal(bundleByPath.get(command.stderr.path)?.kind, 'command-log')
    derivedServices.set(`${command.container.id}:${command.database.systemIdentifier}`, {
      container: command.container,
      database: command.database
    })
  }
}
assert.deepEqual(terminal.services, [...derivedServices.values()])
assert.deepEqual(terminal.stagePolicy.notApplicableStages, derivedNotApplicableStages)
assert.deepEqual(terminal.firstFailures, derivedFirstFailures)
assert.deepEqual(
  [...stageReceiptPaths].sort(),
  terminal.bundleInventory
    .filter((entry) => entry.kind === 'stage-receipt')
    .map((entry) => entry.path)
    .sort()
)
assert.deepEqual(
  [...commandEvidencePaths].sort(),
  terminal.bundleInventory
    .filter((entry) => entry.kind === 'command-evidence')
    .map((entry) => entry.path)
    .sort()
)
for (const logPath of referencedCommandLogs)
{
  assert.equal(bundleByPath.get(logPath)?.kind, 'command-log')
}
for (const envelope of terminal.bundleInventory.filter((entry) => entry.kind === 'service-envelope'))
{
  assert.ok(referencedCommandArguments.includes(envelope.path), `unreferenced service envelope: ${envelope.path}`)
}
const assertBundleSnapshotStable = (publicationName) => {
  const entries = fs.readdirSync(outputRoot, { withFileTypes: true })
  const expectedNames = [...actualBundleFiles, publicationName].sort((left, right) => left.localeCompare(right))
  assert.deepEqual(
    entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right)),
    expectedNames
  )
  for (const entry of entries)
  {
    assert.ok(entry.isFile(), `run evidence root changed to a non-regular entry: ${entry.name}`)
    const entryPath = path.join(outputRoot, entry.name)
    const stat = fs.lstatSync(entryPath, { bigint: true })
    assert.equal(stat.isSymbolicLink(), false, `run evidence root changed to a symlink: ${entry.name}`)
    assert.equal(stat.nlink, 1n, `run evidence root changed to a hardlink alias: ${entry.name}`)
    assert.equal(fs.realpathSync(entryPath), entryPath, `run evidence path stopped being canonical: ${entry.name}`)
    const snapshot = bundleSnapshots.get(entryPath)
    if (snapshot)
    {
      for (const field of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
      {
        assert.equal(stat[field], snapshot.stat[field], `bundle entry changed before publication: ${entry.name}/${field}`)
      }
    }
  }
}
assertBundleSnapshotStable(path.basename(terminalPath))
assert.equal(digest(readPinnedSingleLink(terminalPath, 'prepared terminal before publication').bytes), digest(terminalBytes))
const publicationCandidate = path.join(outputRoot, `.terminal-publication-${process.pid}-${randomUUID()}`)
let publicationFd
try
{
  publicationFd = fs.openSync(
    publicationCandidate,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  )
  fs.writeFileSync(publicationFd, terminalBytes)
  fs.fsyncSync(publicationFd)
}
finally
{
  if (publicationFd !== undefined) fs.closeSync(publicationFd)
}
fs.unlinkSync(terminalPath)
const directoryFd = fs.openSync(outputRoot, fs.constants.O_RDONLY)
try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
assert.equal(
  execFileSync('git', ['-C', process.env.ROOT_DIR_VALUE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  process.env.SOURCE_COMMIT_VALUE
)
assert.equal(
  execFileSync('git', ['-C', process.env.ROOT_DIR_VALUE, 'status', '--porcelain=v1'], { encoding: 'utf8' }),
  ''
)
assertBundleSnapshotStable(path.basename(publicationCandidate))
assert.equal(
  digest(readPinnedSingleLink(publicationCandidate, 'terminal publication candidate').bytes),
  digest(terminalBytes)
)
fs.linkSync(publicationCandidate, terminalFinalPath)
fs.unlinkSync(publicationCandidate)
NODE
printf '[current-schema-bootstrap-integration] verified %s\n' "$terminalFinal" >&3
