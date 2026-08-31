#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
RUN_TOKEN="$(node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID().replaceAll("-", "").slice(0, 16))')"
RUN_PREFIX="current-schema-bootstrap-${RUN_TOKEN}"
POSTGRES_CONTAINER="${RUN_PREFIX}-postgres"
POSTGRES_SWAP_CONTAINER="${RUN_PREFIX}-postgres-swap"
NETWORK_NAME="${RUN_PREFIX}-network"
TEMP_ROOT="$(mktemp -d "/var/tmp/fsusblog-current-schema-bootstrap-${RUN_TOKEN}.XXXXXX")"
OUTPUT_ROOT="$ROOT_DIR/.tmp/current-schema-bootstrap-integration/$RUN_TOKEN"
CATALOG_FILE="$ROOT_DIR/config/testing/test-execution-service-catalog.json"
SERVER_PROJECT="$ROOT_DIR/src/backend/FsusBlog.Server.csproj"
SERVER_DLL="$ROOT_DIR/src/backend/bin/Release/net10.0/FsusBlog.Server.dll"
RECEIPT_VERIFIER="$ROOT_DIR/tools/db/verify-current-schema-test-materialization-receipt.mjs"
SERVICE_ENVELOPE_PRODUCER="$ROOT_DIR/tools/test/execution-envelope-services.mjs"
POSTGRES_IMAGE="$(node "$SERVICE_ENVELOPE_PRODUCER" --image-reference postgres)"
POSTGRES_PORT=""
CONNECTION_STRING=""
ACTIVE_POSTGRES_CONTAINER="$POSTGRES_CONTAINER"
STAGE_RECEIPTS=()

mkdir -p "$OUTPUT_ROOT"

Fail() {
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

RequireCommand() {
    command -v "$1" >/dev/null 2>&1 || Fail "required command is unavailable: $1"
}

for requiredCommand in docker dotnet git node sha256sum; do
    RequireCommand "$requiredCommand"
done
[[ "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]] || Fail 'source commit must be an exact lowercase Git object identity'
[[ -z "$(git -C "$ROOT_DIR" status --porcelain=v1)" ]] \
    || Fail 'source-bound current-schema integration requires a clean worktree'

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
}

WriteStageReceipt() {
    local stage="$1"
    local outcome="$2"
    local detail="$3"
    local receipt="$OUTPUT_ROOT/stage-${stage}.json"
    STAGE_RECEIPTS+=("$receipt")
    STAGE="$stage" OUTCOME="$outcome" DETAIL="$detail" SOURCE_COMMIT_VALUE="$SOURCE_COMMIT" \
        node --input-type=module - "$receipt" <<'NODE'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

const output = process.argv[2]
const receipt = {
  schema: 'fsusblog.current-schema-bootstrap-integration-stage.v1',
  status: 'verified',
  qualificationEligible: true,
  stage: process.env.STAGE,
  expectedOutcome: process.env.OUTCOME,
  detail: process.env.DETAIL,
  sourceCommit: process.env.SOURCE_COMMIT_VALUE,
  contentDigest: null
}
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value
receipt.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(receipt))).digest('hex')}`
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

RunMaterializer() {
    local runId="$1"
    local envelope="$2"
    shift 2
    node "$SERVICE_ENVELOPE_PRODUCER" \
        --verify-envelope "$envelope" \
        --service-catalog "$CATALOG_FILE" >/dev/null
    RunMaterializerWithoutLiveAdmission "$runId" "$envelope" "$@"
}

RunMaterializerWithoutLiveAdmission() {
    local runId="$1"
    local envelope="$2"
    shift 2
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

ExpectMaterializerFailure() {
    local stage="$1"
    local runId="$2"
    local envelope="$3"
    shift 3
    local receipt
    receipt="$(ReceiptPath "$runId")"
    if RunMaterializer "$runId" "$envelope" "$@" >"$OUTPUT_ROOT/${stage}.log" 2>&1; then
        Fail "$stage unexpectedly materialized the schema"
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
    local runId="$1"
    local envelope="$2"
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
    if node "$RECEIPT_VERIFIER" \
        --receipt-root "$OUTPUT_ROOT" \
        --run-id "$runId" \
        --source-commit "$SOURCE_COMMIT" \
        --assembly "$SERVER_DLL" \
        --service-catalog "$CATALOG_FILE" \
        --service-envelope "$envelope" >"$OUTPUT_ROOT/${stage}-receipt-consumer.log" 2>&1; then
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
    Console.Error.WriteLine(exception.Message);
    return 1;
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
    if RunStartupVerifier >"$OUTPUT_ROOT/${stage}.log" 2>&1; then
        Fail "$stage unexpectedly passed the production current-schema verifier"
    fi
    WriteStageReceipt "$stage" rejected 'production CurrentSchemaStartupVerifier rejected the injected PostgreSQL drift'
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
ExpectMaterializerFailure partial-schema "$partialRunId" "$partialEnvelope"
WritePublicCatalogFacts "$partialAfterFacts"
afterPartial="$(sha256sum "$partialAfterFacts" | awk '{print $1}')"
[[ "$beforePartial" == "$afterPartial" ]] || Fail 'partial-schema rejection wrote to PostgreSQL'
cmp -s "$partialBeforeFacts" "$partialAfterFacts" \
    || Fail 'partial-schema canonical catalog facts changed despite digest comparison'
WriteStageReceipt partial-schema rejected "nonempty relation was preserved; before/after canonical catalog digest=${beforePartial}; zero materializer writes; no terminal receipt"

ResetPublicSchema
nonrelationRunId="${RUN_PREFIX}-nonrelation"
nonrelationEnvelope="$OUTPUT_ROOT/${nonrelationRunId}-service-envelope.json"
PostgresSql --command 'CREATE FUNCTION public.current_schema_nonrelation_sentinel() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;' >/dev/null
WriteServiceEnvelope "$nonrelationRunId" "$nonrelationEnvelope"
ExpectMaterializerFailure nonrelation-object "$nonrelationRunId" "$nonrelationEnvelope"
[[ "$(PostgresScalar "SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='current_schema_nonrelation_sentinel';")" == 1 ]] \
    || Fail 'nonrelation rejection did not preserve the sentinel function'
WriteStageReceipt nonrelation-object rejected 'public routine was preserved, zero materializer writes, no terminal receipt'

ResetPublicSchema
publicationRunId="${RUN_PREFIX}-publication-fault"
publicationEnvelope="$OUTPUT_ROOT/${publicationRunId}-service-envelope.json"
WriteServiceEnvelope "$publicationRunId" "$publicationEnvelope"
ExpectMaterializerFailure publication-fault "$publicationRunId" "$publicationEnvelope" \
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
RunMaterializer "$crashRunId" "$crashEnvelope" \
    env FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT=after-prepared-hold \
    >"$OUTPUT_ROOT/prepared-crash.log" 2>&1 &
crashPid=$!
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
kill -KILL "$crashPid"
wait "$crashPid" >/dev/null 2>&1 || true
AssertPreparedNoneligibleWhenPresent "$crashRunId"
[[ ! -e "$(ReceiptPath "$crashRunId")" ]] || Fail 'prepared crash left a verified terminal receipt'
rollbackDeadline=$((SECONDS + 20))
until [[ "$(PostgresScalar "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public';")" == 0 ]]; do
    ((SECONDS < rollbackDeadline)) || Fail 'prepared crash transaction did not roll back to an empty schema'
    sleep 0.2
done
WriteStageReceipt prepared-crash rejected 'SIGKILL after prepared publication left only noneligible staging evidence and PostgreSQL rolled back the open DDL transaction'

ResetPublicSchema
positiveRunId="${RUN_PREFIX}-positive"
positiveEnvelope="$OUTPUT_ROOT/${positiveRunId}-service-envelope.json"
WriteServiceEnvelope "$positiveRunId" "$positiveEnvelope"
RunMaterializer "$positiveRunId" "$positiveEnvelope" >"$OUTPUT_ROOT/positive-materializer.log"
RunCanonicalReceiptVerifier "$positiveRunId" "$positiveEnvelope"
positiveReceipt="$(ReceiptPath "$positiveRunId")"
positiveReceiptBefore="$(sha256sum "$positiveReceipt" | awk '{print $1}')"
if RunMaterializer "$positiveRunId" "$positiveEnvelope" \
    >"$OUTPUT_ROOT/positive-rerun.log" 2>&1; then
    Fail 'positive rerun unexpectedly overwrote an existing terminal materialization receipt'
fi
positiveReceiptAfter="$(sha256sum "$positiveReceipt" | awk '{print $1}')"
[[ "$positiveReceiptBefore" == "$positiveReceiptAfter" ]] \
    || Fail 'failed rerun changed the existing terminal materialization receipt'
WriteStageReceipt positive verified 'canonical materializer, startup verifier, and runtime-ready receipt consumer passed'

VERIFIER_DLL="$(CreateVerifierHarness)"
RunStartupVerifier >"$OUTPUT_ROOT/positive-startup-verifier.log"

defaultTarget="$(PostgresScalar "SELECT quote_ident(table_name)||'.'||quote_ident(column_name) FROM information_schema.columns WHERE table_schema='public' AND data_type IN ('text','character varying') AND column_default IS NULL AND is_identity='NO' ORDER BY table_name,column_name LIMIT 1;")"
[[ "$defaultTarget" == *.* ]] || Fail 'no canonical text column is available for the default drift stage'
defaultTable="${defaultTarget%%.*}"
defaultColumn="${defaultTarget#*.}"
PostgresSql --command "ALTER TABLE public.${defaultTable} ALTER COLUMN ${defaultColumn} SET DEFAULT '__current_schema_drift__';" >/dev/null
ExpectVerifierFailure extra-default
PostgresSql --command "ALTER TABLE public.${defaultTable} ALTER COLUMN ${defaultColumn} DROP DEFAULT;" >/dev/null
RunStartupVerifier >/dev/null

indexTarget="$(PostgresScalar "SELECT quote_ident(c.relname)||'.'||quote_ident(a.attname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname,a.attnum LIMIT 1;")"
[[ "$indexTarget" == *.* ]] || Fail 'no canonical column is available for index drift stages'
indexTable="${indexTarget%%.*}"
indexColumn="${indexTarget#*.}"
PostgresSql --command "CREATE INDEX current_schema_drift_desc ON public.${indexTable} (${indexColumn} DESC);" >/dev/null
ExpectVerifierFailure index-desc
PostgresSql --command 'DROP INDEX public.current_schema_drift_desc;' >/dev/null
PostgresSql --command "CREATE INDEX current_schema_drift_partial ON public.${indexTable} (${indexColumn}) WHERE ${indexColumn} IS NOT NULL;" >/dev/null
ExpectVerifierFailure index-partial
PostgresSql --command 'DROP INDEX public.current_schema_drift_partial;' >/dev/null
PostgresSql --command "CREATE UNIQUE INDEX current_schema_drift_nulls_not_distinct ON public.${indexTable} (${indexColumn}) NULLS NOT DISTINCT;" >/dev/null
ExpectVerifierFailure index-nulls-not-distinct
PostgresSql --command 'DROP INDEX public.current_schema_drift_nulls_not_distinct;' >/dev/null
RunStartupVerifier >/dev/null

precisionTarget="$(PostgresScalar "SELECT quote_ident(table_name)||'.'||quote_ident(column_name) FROM information_schema.columns WHERE table_schema='public' AND data_type='timestamp without time zone' AND datetime_precision=6 ORDER BY table_name,column_name LIMIT 1;")"
if [[ "$precisionTarget" == *.* ]]; then
    precisionTable="${precisionTarget%%.*}"
    precisionColumn="${precisionTarget#*.}"
    PostgresSql --command "ALTER TABLE public.${precisionTable} ALTER COLUMN ${precisionColumn} TYPE timestamp(3) without time zone;" >/dev/null
    ExpectVerifierFailure type-precision
    PostgresSql --command "ALTER TABLE public.${precisionTable} ALTER COLUMN ${precisionColumn} TYPE timestamp(6) without time zone;" >/dev/null
else
    WriteStageReceipt type-precision not-applicable 'canonical schema exposes no timestamp(6) column'
fi
RunStartupVerifier >/dev/null

PostgresSql --command "ALTER TABLE public.${indexTable} ADD CONSTRAINT current_schema_drift_constraint CHECK (true) NOT VALID;" >/dev/null
ExpectVerifierFailure constraint-metadata
PostgresSql --command "ALTER TABLE public.${indexTable} DROP CONSTRAINT current_schema_drift_constraint;" >/dev/null
RunStartupVerifier >/dev/null

docker rm -f -v "$POSTGRES_CONTAINER" >/dev/null
ACTIVE_POSTGRES_CONTAINER="$POSTGRES_SWAP_CONTAINER"
StartPostgres "$POSTGRES_SWAP_CONTAINER" --publish "127.0.0.1:${POSTGRES_PORT}:5432"
staleRunId="${RUN_PREFIX}-stale-envelope"
staleEnvelope="$OUTPUT_ROOT/${staleRunId}-service-envelope.json"
cp "$positiveEnvelope" "$staleEnvelope"
node --input-type=module - "$staleEnvelope" "$staleRunId" <<'NODE'
import fs from 'node:fs'

const file = process.argv[2]
const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
envelope.runId = process.argv[3]
fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 })
NODE
if RunMaterializerWithoutLiveAdmission "$staleRunId" "$staleEnvelope" \
    >"$OUTPUT_ROOT/stale-envelope-cluster-swap.log" 2>&1; then
    Fail 'stale-envelope-cluster-swap unexpectedly materialized the replacement cluster'
fi
[[ ! -e "$(ReceiptPath "$staleRunId")" ]] \
    || Fail 'stale-envelope-cluster-swap left a qualification-eligible terminal receipt'
[[ "$(PostgresScalar "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public';")" == 0 ]] \
    || Fail 'stale service envelope wrote to the replacement PostgreSQL cluster'
WriteStageReceipt stale-envelope-cluster-swap rejected 'same host port with a replacement PostgreSQL system identifier was rejected before DDL'

STAGE_RECEIPT_LIST="$(IFS=:; printf '%s' "${STAGE_RECEIPTS[*]}")" \
POSITIVE_READY="$(RuntimeReadyPath "$positiveRunId")" \
SOURCE_COMMIT_VALUE="$SOURCE_COMMIT" \
RUN_ID_VALUE="$RUN_PREFIX" \
    node --input-type=module - "$OUTPUT_ROOT/terminal.json" <<'NODE'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

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
for (const stage of stages)
{
  assert.equal(stage.schema, 'fsusblog.current-schema-bootstrap-integration-stage.v1')
  assert.equal(stage.status, 'verified')
  assert.equal(stage.qualificationEligible, true)
  assert.equal(stage.contentDigest, contentDigest(stage))
}
const runtimeReadyBytes = fs.readFileSync(process.env.POSITIVE_READY)
const runtimeReady = JSON.parse(runtimeReadyBytes)
assert.equal(runtimeReady.schema, 'fsusblog.current-schema-runtime-ready.v1')
assert.equal(runtimeReady.status, 'verified')
assert.equal(runtimeReady.qualificationEligible, true)
assert.equal(runtimeReady.sourceCommit, process.env.SOURCE_COMMIT_VALUE)
assert.equal(runtimeReady.contentDigest, contentDigest(runtimeReady))
const terminal = {
  schema: 'fsusblog.current-schema-bootstrap-integration.v1',
  status: 'verified',
  qualificationEligible: true,
  runId: process.env.RUN_ID_VALUE,
  sourceCommit: process.env.SOURCE_COMMIT_VALUE,
  runtimeReady: {
    path: process.env.POSITIVE_READY,
    sha256: `sha256:${createHash('sha256').update(runtimeReadyBytes).digest('hex')}`,
    contentDigest: runtimeReady.contentDigest
  },
  stages: stages.map((stage) => ({
    stage: stage.stage,
    expectedOutcome: stage.expectedOutcome,
    contentDigest: stage.contentDigest
  })),
  contentDigest: null
}
terminal.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(terminal))).digest('hex')}`
fs.writeFileSync(output, `${JSON.stringify(terminal, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
NODE

printf '[current-schema-bootstrap-integration] verified %s\n' "$OUTPUT_ROOT/terminal.json"
