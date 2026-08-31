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

test('current schema bootstrap lane owns isolated pinned PostgreSQL and exact cleanup', () => {
  assert.match(lane, /^set -euo pipefail$/mu)
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
  assert.match(lane, /ConnectionStrings__DefaultConnection="\$\{CONNECTION_STRING\};Search Path=public"[\s\\]*\n\s*node "\$RECEIPT_VERIFIER"/u)
  assert.match(lane, /ExpectCanonicalReceiptVerifierFailure publication-fault/u)
  assert.match(lane, /fsusblog\.current-schema-runtime-ready\.v1/u)
  assert.match(lane, /fsusblog\.current-schema-bootstrap-integration\.v1/u)
  assert.match(lane, /contentDigest = `sha256:/u)
  assert.match(lane, /assert\.equal\(runtimeReady\.contentDigest, contentDigest\(runtimeReady\)\)/u)
})

test('current schema bootstrap lane exercises positive and fail-closed PostgreSQL drift stages', () => {
  for (const stage of [
    'partial-schema',
    'composite-type',
    'nonrelation-object',
    'publication-fault',
    'prepared-crash',
    'positive',
    'extra-default',
    'index-direction',
    'index-null-placement',
    'index-predicate',
    'index-access-method',
    'index-operator-class',
    'index-collation',
    'index-include',
    'index-nulls-not-distinct',
    'type-precision',
    'type-default-precision',
    'column-collation',
    'sequence-start',
    'sequence-increment',
    'sequence-minimum',
    'sequence-maximum',
    'sequence-cache',
    'sequence-cycle',
    'sequence-data-type',
    'sequence-name',
    'sequence-schema',
    'sequence-ownership',
    'constraint-deferrable',
    'constraint-initially-deferred',
    'constraint-validated',
    'foreign-key-update-action',
    'foreign-key-delete-action',
    'foreign-key-match-type',
    'foreign-key-referenced-schema',
    'stale-envelope-cluster-swap'
  ])
  {
    assert.match(lane, new RegExp(stage, 'u'))
  }
  assert.match(lane, /FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT=after-commit/u)
  assert.match(lane, /FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT=after-prepared-hold/u)
  assert.match(lane, /setsid env[\s\S]*?--run-id "\$crashRunId"/u)
  assert.match(lane, /crashPgid="\$\(ps -o pgid= -p "\$crashPid"/u)
  assert.match(lane, /"\$crashPgid" == "\$crashPid" && "\$crashPgid" != "\$lanePgid"/u)
  assert.match(lane, /process identity does not match the exact materializer candidate/u)
  assert.match(lane, /kill -KILL -- "-\$crashPgid"/u)
  assert.match(lane, /while pgrep -g "\$crashPgid"/u)
  assert.match(lane, /retained a surviving candidate/u)
  assert.doesNotMatch(lane, /RunMaterializer "\$crashRunId"[\s\S]*?after-prepared-hold[\s\S]*?&/u)
  assert.match(lane, /WritePublicCatalogFacts "\$partialBeforeFacts"[\s\S]*?WritePublicCatalogFacts "\$partialAfterFacts"[\s\S]*?cmp -s/u)
  assert.match(lane, /CREATE TYPE public\.current_schema_composite_sentinel AS/u)
  assert.match(lane, /WritePublicCatalogFacts "\$compositeBeforeFacts"[\s\S]*?ExpectMaterializerFailure composite-type[\s\S]*?ReceiptPath "\$compositeRunId"\)\.prepared[\s\S]*?WritePublicCatalogFacts "\$compositeAfterFacts"[\s\S]*?cmp -s/u)
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
  assert.match(lane, /replacement PostgreSQL system identifier was rejected before DDL/u)
})

test('matrix registers the self-bootstrapping serial runtime lane and exclusive owners', () => {
  const tier = matrix.tiers.find((entry) => entry.id === 'current-schema-bootstrap-integration')
  assert.ok(tier)
  assert.equal(tier.executionClass, 'runtime')
  assert.equal(tier.selfBootstraps, true)
  assert.equal(tier.parallelizable, false)
  assert.deepEqual(tier.services, ['postgres'])
  assert.deepEqual(tier.executionDependsOn, ['behavior-doc-static-admission'])
  assert.ok(tier.exclusiveResources.includes('docker-runtime'))
  assert.ok(tier.exclusiveResources.includes('local-ports'))
  assert.ok(tier.exclusiveResources.includes('database-writes'))
  assert.ok(tier.exclusiveResources.includes('backend-build-output'))
  assert.equal(tier.command, 'tools/test/lanes/current-schema-bootstrap-integration.sh')
  assert.ok(tier.artifacts.includes('.tmp/current-schema-bootstrap-integration/*/terminal.json'))
  assert.ok(tier.evidence.includes('.tmp/current-schema-bootstrap-integration/*/terminal.json'))
})
