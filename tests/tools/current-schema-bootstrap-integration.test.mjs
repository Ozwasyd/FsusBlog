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
  assert.match(lane, /ExpectCanonicalReceiptVerifierFailure publication-fault/u)
  assert.match(lane, /fsusblog\.current-schema-runtime-ready\.v1/u)
  assert.match(lane, /fsusblog\.current-schema-bootstrap-integration\.v1/u)
  assert.match(lane, /contentDigest = `sha256:/u)
  assert.match(lane, /assert\.equal\(runtimeReady\.contentDigest, contentDigest\(runtimeReady\)\)/u)
})

test('current schema bootstrap lane exercises positive and fail-closed PostgreSQL drift stages', () => {
  for (const stage of [
    'partial-schema',
    'nonrelation-object',
    'publication-fault',
    'prepared-crash',
    'positive',
    'extra-default',
    'index-desc',
    'index-partial',
    'index-nulls-not-distinct',
    'type-precision',
    'constraint-metadata',
    'stale-envelope-cluster-swap'
  ])
  {
    assert.match(lane, new RegExp(stage, 'u'))
  }
  assert.match(lane, /FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT=after-commit/u)
  assert.match(lane, /FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT=after-prepared-hold/u)
  assert.match(lane, /kill -KILL "\$crashPid"/u)
  assert.match(lane, /WritePublicCatalogFacts "\$partialBeforeFacts"[\s\S]*?WritePublicCatalogFacts "\$partialAfterFacts"[\s\S]*?cmp -s/u)
  assert.match(lane, /qualificationEligible, false/u)
  assert.match(lane, /CurrentSchemaStartupVerifier/u)
  assert.match(lane, /SET DEFAULT '__current_schema_drift__'/u)
  assert.match(lane, /DESC\);/u)
  assert.match(lane, /WHERE \$\{indexColumn\} IS NOT NULL/u)
  assert.match(lane, /NULLS NOT DISTINCT/u)
  assert.match(lane, /timestamp\(3\) without time zone/u)
  assert.match(lane, /CHECK \(true\) NOT VALID/u)
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
