import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const laneFile = path.join(root, 'tools/test/lanes/current-schema-bootstrap-integration.sh')
const lane = fs.readFileSync(laneFile, 'utf8')
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
const coverageRegistry = JSON.parse(fs.readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'))
const lifecycleCoverage = coverageRegistry.entries.find(
  (entry) => entry.id === 'current-schema-receipt-lifecycle'
)
assert.ok(lifecycleCoverage)
const mandatoryStageRoster = lifecycleCoverage.stageRoster
const allowedNotApplicableStages = lifecycleCoverage.allowedNotApplicableStages

test('current schema bootstrap lane owns isolated pinned PostgreSQL and exact cleanup', () => {
  assert.match(lane, /^set -eEuo pipefail$/mu)
  assert.match(lane, /^umask 077$/mu)
  assert.match(lane, /mktemp -d "\/var\/tmp\/fsusblog-current-schema-bootstrap-\$\{RUN_TOKEN\}\.XXXXXX"/u)
  assert.match(lane, /--image-reference postgres/u)
  assert.match(lane, /docker image inspect "\$POSTGRES_IMAGE"/u)
  assert.match(lane, /--pull never/u)
  assert.match(lane, /docker network create "\$NETWORK_NAME"/u)
  assert.match(lane, /--publish 127\.0\.0\.1::5432/u)
  assert.match(lane, /docker rm -f -v "\$POSTGRES_SWAP_CONTAINER"/u)
  assert.match(lane, /docker rm -f -v "\$POSTGRES_CONTAINER"/u)
  assert.match(lane, /docker network rm "\$NETWORK_NAME"/u)
  assert.match(lane, /rm -rf -- "\$TEMP_ROOT"/u)
  assert.match(lane, /exec >"\$LANE_STDOUT" 2>"\$LANE_STDERR"/u)
  assert.match(lane, /mkdir -p "\$\(dirname "\$OUTPUT_ROOT"\)"[\s\S]*?mkdir "\$OUTPUT_ROOT"/u)
  assert.match(lane, /fsusblog\.current-schema-bootstrap-integration-first-failure\.v1/u)
  assert.match(lane, /trap 'failureStatus=\$\?; RecordFirstFailure/u)
  assert.doesNotMatch(lane, /docker (?:system|volume|container|image) prune/u)
})

test('current schema bootstrap lane source-binds build and canonical receipt chain', () => {
  assert.match(lane, /SOURCE_COMMIT="\$\(git -C "\$ROOT_DIR" rev-parse HEAD\)"/u)
  assert.match(lane, /status --porcelain=v1/u)
  assert.match(lane, /--configuration Release[\s\S]*?-p:FsusBlogCommitSha="\$SOURCE_COMMIT"/u)
  assert.match(lane, /execution-envelope-services\.mjs/u)
  assert.match(lane, /materialize-current-schema-test/u)
  assert.match(lane, /--service-envelope "\$envelope"[\s\S]*?--service-catalog "\$CATALOG_FILE"/u)
  assert.match(lane, /verify-current-schema-test-materialization-receipt\.mjs/u)
  assert.match(lane, /env ConnectionStrings__DefaultConnection="\$\{CONNECTION_STRING\};Search Path=public"[\s\\]*\n\s*node "\$RECEIPT_VERIFIER"/u)
  assert.match(lane, /ExpectCanonicalReceiptVerifierFailure publication-fault/u)
  assert.match(lane, /fsusblog\.current-schema-runtime-ready\.v1/u)
  assert.match(lane, /fsusblog\.current-schema-bootstrap-integration\.v1/u)
  assert.match(lane, /contentDigest = digest\(/u)
  assert.match(lane, /assert\.equal\(runtimeReady\.contentDigest, contentDigest\(runtimeReady\)\)/u)
  assert.match(lane, /git -C "\$ROOT_DIR" show "\$SOURCE_COMMIT:tools\/test-matrix\/parse-matrix\.mjs"/u)
  assert.match(lane, /SOURCE_MATRIX_PARSER_VALUE[\s\S]*?pathToFileURL\(process\.env\.SOURCE_MATRIX_PARSER_VALUE\)/u)
  assert.match(lane, /RECEIPT_VERIFIER_VALUE[\s\S]*?'--mode', 'verify'/u)
})

test('current schema bootstrap lane exercises positive and fail-closed PostgreSQL drift stages', () => {
  assert.equal(mandatoryStageRoster.length, 38)
  assert.equal(new Set(mandatoryStageRoster).size, mandatoryStageRoster.length)
  assert.match(lane, /assert\.deepEqual\(actualStageNames, mandatoryStageRoster\)/u)
  assert.match(lane, /FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT=after-commit/u)
  assert.match(lane, /FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT=after-prepared-hold/u)
  assert.match(lane, /crashCommand=\(setsid env[\s\S]*?--run-id "\$crashRunId"/u)
  assert.match(lane, /crashPgid="\$\(ps -o pgid= -p "\$crashPid"/u)
  assert.match(lane, /"\$crashPgid" == "\$crashPid" && "\$crashPgid" != "\$lanePgid"/u)
  assert.match(lane, /process identity does not match the exact materializer candidate/u)
  assert.match(lane, /kill -KILL -- "-\$crashPgid"/u)
  assert.match(lane, /crashExitStatus=0\nwait "\$crashPid" >\/dev\/null 2>&1 \|\| crashExitStatus=\$\?/u)
  assert.doesNotMatch(lane, /set \+e\nwait "\$crashPid"/u)
  assert.match(lane, /while pgrep -g "\$crashPgid"/u)
  assert.match(lane, /retained a surviving candidate/u)
  assert.doesNotMatch(lane, /RunMaterializer "\$crashRunId"[\s\S]*?after-prepared-hold[\s\S]*?&/u)
  assert.match(lane, /WritePublicCatalogFacts "\$partialBeforeFacts"[\s\S]*?WritePublicCatalogFacts "\$partialAfterFacts"[\s\S]*?cmp -s/u)
  assert.match(lane, /ExpectMaterializerFailure partial-schema[\s\S]*?current_schema_materializer_public_schema_not_empty/u)
  assert.match(lane, /CREATE TYPE public\.current_schema_composite_sentinel AS/u)
  assert.match(lane, /WritePublicCatalogFacts "\$compositeBeforeFacts"[\s\S]*?ExpectMaterializerFailure composite-type[\s\S]*?ReceiptPath "\$compositeRunId"\)\.prepared[\s\S]*?WritePublicCatalogFacts "\$compositeAfterFacts"[\s\S]*?cmp -s/u)
  assert.match(lane, /ExpectMaterializerFailure composite-type[\s\S]*?current_schema_materializer_public_schema_not_empty/u)
  assert.match(lane, /ExpectMaterializerFailure nonrelation-object[\s\S]*?current_schema_materializer_public_schema_not_empty/u)
  assert.match(lane, /ExpectMaterializerFailure publication-fault[\s\S]*?current_schema_materializer_publication_fault_after_commit/u)
  assert.match(lane, /assert\.deepEqual\(documents, \[\{ status: 'failed', code: process\.env\.EXPECTED_CODE_VALUE \}\]\)/u)
  assert.match(lane, /qualificationEligible, false/u)
  assert.match(lane, /CurrentSchemaStartupVerifier/u)
  assert.match(lane, /SET DEFAULT '__current_schema_drift__'/u)
  assert.match(lane, /DROP INDEX public\.\$\{indexName\}; CREATE INDEX \$\{indexName\}/u)
  assert.match(lane, /DESC NULLS LAST/u)
  assert.match(lane, /ASC NULLS FIRST/u)
  assert.match(lane, /WHERE \$\{indexColumn\} IS NOT NULL/u)
  assert.match(lane, /USING hash/u)
  assert.match(lane, /pg_catalog\.text_pattern_ops/u)
  assert.match(lane, /COLLATE \$\{alternateIndexCollation\}/u)
  assert.match(lane, /FROM pg_collation collation_meta/u)
  assert.doesNotMatch(lane, /FROM pg_collation collation\b/u)
  assert.match(lane, /INCLUDE \(\$\{includedColumn\}\)/u)
  assert.match(lane, /NULLS NOT DISTINCT/u)
  assert.doesNotMatch(lane, /CREATE (?:UNIQUE )?INDEX current_schema_drift/u)
  assert.match(lane, /RestoreOwnedIndex "\$indexName" "\$indexOriginalDefinition"/u)
  assert.match(lane, /timestamp\(0\) without time zone/u)
  assert.match(lane, /timestamp\(6\) normalized to the canonical unspecified default precision/u)
  assert.match(lane, /ALTER COLUMN \$\{collationColumn\} TYPE \$\{collationPhysicalType\} COLLATE \$\{alternateColumnCollation\}/u)
  assert.match(lane, /for identityKind in 'BY DEFAULT' 'ALWAYS'/u)
  assert.match(lane, /ADD GENERATED \$\{identityKind\} AS IDENTITY/u)
  assert.match(lane, /RestoreOwnedSequence/u)
  for (const sequenceOption of [
    'START WITH',
    'INCREMENT BY',
    'MINVALUE 0',
    'MAXVALUE',
    'sequenceCacheDrift',
    'sequenceCycleDrift',
    'sequenceCycleRestore',
    'AS bigint',
    'RENAME TO',
    'SET SCHEMA',
    'OWNED BY NONE'
  ])
  {
    assert.match(lane, new RegExp(sequenceOption, 'u'))
  }
  assert.match(lane, /DEFERRABLE INITIALLY IMMEDIATE/u)
  assert.match(lane, /DEFERRABLE INITIALLY DEFERRED/u)
  assert.match(lane, /constraint_meta\.contype IN \('p','u'\)/u)
  assert.match(lane, /RestoreOwnedConstraint "\$deferrableTable" "\$deferrableName" "\$deferrableOriginalDefinition"/u)
  assert.match(lane, /ownedCheckConstraint=.*constraint_meta\.contype='c'/u)
  assert.match(lane, /NOT VALID/u)
  assert.match(lane, /ON UPDATE CASCADE ON DELETE NO ACTION/u)
  assert.match(lane, /ON UPDATE NO ACTION ON DELETE CASCADE/u)
  assert.match(lane, /MATCH FULL/u)
  assert.match(lane, /CREATE TABLE \$\{foreignKeyShadowSchema\}\.\$\{referencedTable\} \(LIKE/u)
  assert.match(lane, /REFERENCES \$\{foreignKeyShadowSchema\}\.\$\{referencedTable\}/u)
  assert.match(lane, /RestoreOwnedConstraint/u)
  assert.match(lane, /WriteServiceEnvelope "\$staleRunId" "\$staleEnvelope"[\s\S]*?docker rm -f -v "\$POSTGRES_CONTAINER"[\s\S]*?RunMaterializerWithoutLiveAdmissionEvidence stale-envelope-cluster-swap materializer rejected/u)
  assert.doesNotMatch(lane, /(?:cp|sed|jq)[^\n]*staleEnvelope/u)
  assert.doesNotMatch(lane, /node[^\n]*staleEnvelope/u)
  assert.match(lane, /current_schema_materializer_database_observation_mismatch/u)
  assert.match(lane, /ReceiptPath "\$staleRunId"\)\.prepared/u)
  assert.match(lane, /RuntimeReadyPath "\$staleRunId"/u)
  assert.match(lane, /WritePublicCatalogFacts "\$staleBeforeFacts"[\s\S]*?WritePublicCatalogFacts "\$staleAfterFacts"[\s\S]*?cmp -s/u)
  assert.match(lane, /unchanged canonical old-instance envelope failed exact PostgreSQL system_identifier admission/u)
})

test('current schema bootstrap terminal binds exact durable evidence and rejects a missing stage mutation', () => {
  assert.match(lane, /COVERAGE_REGISTRY_FILE="\$ROOT_DIR\/tests\/coverage-registry\.json"/u)
  assert.match(lane, /coverageEntry\.stageRoster/u)
  assert.match(lane, /coverageEntry\.allowedNotApplicableStages/u)
  assert.match(lane, /coverageEntry\.requiredRetainedEvidenceKinds/u)
  assert.match(lane, /coverageEntry\.requiredRawCatalogFacts/u)
  assert.doesNotMatch(lane, /^MANDATORY_STAGE_ROSTER=\(/mu)
  assert.doesNotMatch(lane, /^ALLOWED_NOT_APPLICABLE_STAGES=\(/mu)
  assert.equal(new Set(mandatoryStageRoster).size, mandatoryStageRoster.length)
  assert.deepEqual(allowedNotApplicableStages, [
    'type-precision',
    'type-default-precision',
    'constraint-validated',
    'foreign-key-update-action',
    'foreign-key-delete-action',
    'foreign-key-match-type',
    'foreign-key-referenced-schema'
  ])
  assert.match(lane, /fsusblog\.current-schema-bootstrap-integration-command\.v1/u)
  assert.match(lane, /startedAt: process\.env\.STARTED_AT_VALUE/u)
  assert.match(lane, /endedAt: process\.env\.ENDED_AT_VALUE/u)
  assert.match(lane, /exit: \{ status: exitStatus, signal: exitSignal \}/u)
  assert.match(lane, /entry\.expectedOutcome === 'rejected'[\s\S]*?entry\.exit\.status !== 0[\s\S]*?entry\.firstFailure !== null/u)
  assert.match(lane, /entry\.expectedOutcome === 'not-applicable'[\s\S]*?entry\.exit\.status === 0/u)
  assert.match(lane, /stdout: \{ path: process\.env\.STDOUT_PATH_VALUE, sha256: digest\(stdout\) \}/u)
  assert.match(lane, /stderr: \{ path: process\.env\.STDERR_PATH_VALUE, sha256: digest\(stderr\) \}/u)
  assert.match(lane, /firstFailure/u)
  assert.match(lane, /fsusblog\.current-schema-mismatch\.v1/u)
  assert.match(lane, /expected typed schema-mismatch status 42/u)
  assert.match(lane, /systemIdentifier: process\.env\.SYSTEM_IDENTIFIER_VALUE/u)
  assert.match(lane, /assert\.deepEqual\(actualStageNames, mandatoryStageRoster\)/u)
  assert.match(lane, /new Set\(actualStageNames\)\.size/u)
  assert.match(lane, /unexpected not-applicable stage/u)
  assert.deepEqual(lifecycleCoverage.requiredRetainedEvidenceKinds, [
    'stage-receipt',
    'command-evidence',
    'service-envelope',
    'materializer-receipt',
    'runtime-ready-receipt',
    'raw-catalog-facts',
    'command-log'
  ])
  for (const kind of lifecycleCoverage.requiredRetainedEvidenceKinds)
  {
    assert.match(lane, new RegExp(`'${kind}'`, 'u'))
  }
  assert.deepEqual(lifecycleCoverage.requiredRawCatalogFacts, [
    'composite-type-after.facts',
    'composite-type-before.facts',
    'partial-schema-after.facts',
    'partial-schema-before.facts',
    'stale-envelope-after.facts',
    'stale-envelope-before.facts'
  ])
  assert.match(lane, /bundleInventory/u)
  assert.match(lane, /run evidence root contains a non-regular entry/u)
  assert.match(lane, /run evidence root contains a hardlink alias/u)
  assert.match(lane, /readPinnedSingleLink\(terminalPath, 'prepared terminal'\)/u)
  assert.match(lane, /bundleSnapshots[\s\S]*?assertBundleSnapshotStable/u)
  assert.match(lane, /fs\.unlinkSync\(terminalPath\)[\s\S]*?assertBundleSnapshotStable\(path\.basename\(publicationCandidate\)\)/u)
  assert.match(lane, /git', \['-C', process\.env\.ROOT_DIR_VALUE, 'status', '--porcelain=v1'\]/u)
  assert.match(lane, /requireExactKeys\(terminal,[\s\S]*?requireExactKeys\(receipt,[\s\S]*?requireExactKeys\(evidence,/u)
  assert.match(lane, /boundRuntimeReadyBytes = bundleBytes\(terminal\.runtimeReady\.path\)[\s\S]*?boundRuntimeReady\.contentDigest, contentDigest\(boundRuntimeReady\)/u)
  assert.match(lane, /publication-preflight\.candidate[\s\S]*?assert\.throws\(\(\) => fs\.linkSync\(candidate, destination\), \{ code: 'EEXIST' \}\)/u)
  assert.match(lane, /fs\.linkSync\(publicationCandidate, terminalFinalPath\)\nfs\.unlinkSync\(publicationCandidate\)\nNODE/u)
  assert.match(lane, /committedBytes = \(relativePath\)[\s\S]*?'git'[\s\S]*?SOURCE_COMMIT_VALUE[\s\S]*?relativePath/u)
  assert.doesNotMatch(lane, /COPYFILE_EXCL/u)
  assert.doesNotMatch(lane, /fs\.renameSync\(publicationCandidate, terminalFinalPath\)/u)
  assert.doesNotMatch(lane, /--update=none-fail/u)
  assert.doesNotMatch(lane, /filter\(\(entry\) => !entry\.name\.startsWith\('terminal\.'\)\)/u)
  assert.doesNotMatch(lane, /mv "\$terminalPrepared" "\$terminalFinal"/u)
  assert.match(lane, /assert\.equal\(entry\.sha256, digest\(bytes\)\)/u)
  assert.match(lane, /assert\.equal\(command\.stdout\.sha256, digest\(bundleBytes\(command\.stdout\.path\)\)\)/u)
  assert.match(lane, /assert\.equal\(command\.sha256, digest\(commandBytes\)\)/u)
  assert.match(lane, /assert\.deepEqual\(terminal\.stagePolicy\.mandatoryRoster, coverageEntry\.stageRoster\)/u)
  assert.match(lane, /assert\.deepEqual\(terminal\.services, \[\.\.\.derivedServices\.values\(\)\]\)/u)
  assert.match(lane, /assert\.deepEqual\(terminal\.stagePolicy\.notApplicableStages, derivedNotApplicableStages\)/u)
  assert.match(lane, /assert\.deepEqual\(terminal\.firstFailures, derivedFirstFailures\)/u)
  assert.match(lane, /assert\.deepEqual\(terminal\.bundleInventory\.map\(\(entry\) => entry\.relativePath\), actualBundleFiles\)/u)
  assert.match(lane, /unreferenced service envelope/u)
  const verifyRoster = (actual) => assert.deepEqual(actual, mandatoryStageRoster)
  assert.doesNotThrow(() => verifyRoster([...mandatoryStageRoster]))
  assert.throws(
    () => verifyRoster(mandatoryStageRoster.filter((stage) => stage !== 'publication-fault')),
    assert.AssertionError
  )
})

test('matrix registers the self-bootstrapping serial runtime lane and exclusive owners', () => {
  const tier = matrix.tiers.find((entry) => entry.id === 'current-schema-bootstrap-integration')
  assert.ok(tier)
  assert.equal(tier.executionClass, 'runtime')
  assert.equal(tier.selfBootstraps, true)
  assert.equal(tier.parallelizable, false)
  assert.deepEqual(tier.services, ['postgres'])
  assert.deepEqual(tier.executionDependsOn, ['behavior-doc-static-admission'])
  assert.ok(tier.coverage.includes(lifecycleCoverage.id))
  assert.deepEqual(lifecycleCoverage.tierIds, [tier.id])
  assert.ok(tier.exclusiveResources.includes('docker-runtime'))
  assert.ok(tier.exclusiveResources.includes('local-ports'))
  assert.ok(tier.exclusiveResources.includes('database-writes'))
  assert.ok(tier.exclusiveResources.includes('backend-build-output'))
  assert.equal(tier.command, 'tools/test/lanes/current-schema-bootstrap-integration.sh')
  assert.deepEqual(tier.artifacts, ['.tmp/current-schema-bootstrap-integration/*/**'])
  assert.ok(tier.evidence.includes('.tmp/current-schema-bootstrap-integration/*/**'))
  assert.ok(tier.evidence.includes('.tmp/current-schema-bootstrap-integration/*/terminal.json'))
  assert.ok(lifecycleCoverage.evidencePaths.includes('.tmp/current-schema-bootstrap-integration/*/**'))
})
