import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  loadRegistry,
  validateOwnershipAgainstBehaviorCatalog,
  root
} from '../../tools/fact-extractors/registry.mjs'
import { loadCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import { extract as extractOpenApi } from '../../tools/fact-extractors/openapi-aeds/extract.mjs'
import {
  buildOpenApiFromMatrix,
  committedOpenApiPath,
  operationsFromOpenApi,
  readJson
} from '../../tools/contracts/lib/openapi-contracts.mjs'
import {
  observationToFactObservations,
  sha256File,
  validateObservationAgainstProtocol
} from '../../tools/contracts/lib/openapi-observation.mjs'
import { loadProtocol } from '../../tools/contracts/lib/openapi-contracts.mjs'

const observationRelative = '.tmp/contracts/openapi/api-aeds-observation.json'

function sha256(buffer)
{
  return createHash('sha256').update(buffer).digest('hex')
}

function writeObservation(repositoryRoot, observation)
{
  const absolute = path.join(repositoryRoot, observationRelative)
  mkdirSync(path.dirname(absolute), { recursive: true })
  const text = `${JSON.stringify(observation, null, 2)}\n`
  writeFileSync(absolute, text)
  return {
    absolute,
    artifactDigest: sha256(Buffer.from(text, 'utf8')),
    text
  }
}

function sampleObservation(overrides = {})
{
  return {
    schema: 'fsusblog.api-aeds-observation.v1',
    protocol: 'AEDS',
    aedsVersion: 2,
    operationCount: 2,
    operationKeys: [
      'GET /api/binary/article/{id}.aeds',
      'POST /api/binary/admin/article'
    ],
    observationDigest: 'a'.repeat(64),
    operations: [
      {
        method: 'GET',
        path: '/api/binary/article/{id}.aeds',
        operationId: 'binary_get_article_id_aeds',
        protocol: 'AEDS',
        aedsVersion: 2,
        requestFrame: null,
        responseFrame: 'ArticleDetail',
        errorFrame: 'ApiError',
        auth: 'anonymous',
        permission: 'none',
        pow: false,
        rateLimit: 'public_read',
        cache: 'public-read',
        successStatus: 200
      },
      {
        method: 'POST',
        path: '/api/binary/admin/article',
        operationId: 'binary_post_admin_article',
        protocol: 'AEDS',
        aedsVersion: 2,
        requestFrame: 'ArticleWriteRequest',
        responseFrame: 'MutationId',
        errorFrame: 'ApiError',
        auth: 'admin',
        permission: 'article.write',
        pow: true,
        rateLimit: 'fixed_ip',
        cache: 'no-store',
        successStatus: 200
      }
    ],
    ...overrides
  }
}

test('registry owns binary-api-aeds-contract via openapi-aeds-fact-extractor', () =>
{
  const registry = loadRegistry()
  const result = validateOwnershipAgainstBehaviorCatalog(registry, loadCatalog(), root)
  assert.equal(result.behaviorOwners.get('binary-api-aeds-contract'), 'openapi-aeds-fact-extractor')
  const extractor = registry.extractors.find((entry) => entry.id === 'openapi-aeds-fact-extractor')
  assert.equal(extractor.kind, 'compiled-assembly')
  assert.equal(extractor.hermeticPolicy, 'exact-build-receipt')
  assert.equal(extractor.requiredBuildArtifact, 'openapi-aeds-observation')
})

test('checked-in OpenAPI projection declares compiled observation authority', () =>
{
  const openapi = readJson(committedOpenApiPath)
  assert.equal(openapi['x-fsus-contract-source']?.observation, 'compiled-endpoint-metadata')
  assert.equal(openapi['x-fsus-contract-source']?.matrix, undefined)
  assert.ok(openapi['x-fsus-observation-digest'])
  const operations = operationsFromOpenApi(openapi)
  assert.ok(operations.length >= 200)
  for (const op of operations)
  {
    assert.equal(op.operation['x-fsus-protocol'], 'AEDS')
    assert.ok(op.operationId, `${op.key} missing operationId`)
  }
})

test('buildOpenApiFromMatrix is retired and cannot re-enter as authority', () =>
{
  assert.throws(() => buildOpenApiFromMatrix(), /retired|compiled endpoint observation/iu)
})

test('1) deleting an endpoint while retaining OpenAPI fails observation validation set equality helpers', () =>
{
  const observation = sampleObservation()
  observation.operations = observation.operations.filter((op) => op.method !== 'POST')
  observation.operationCount = 1
  observation.operationKeys = ['GET /api/binary/article/{id}.aeds']
  // Projection retains POST — bidirectional set compare must surface drift.
  const openapi = readJson(committedOpenApiPath)
  const projectionKeys = new Set(
    operationsFromOpenApi(openapi).map((op) => `${op.method} ${op.fullPath}`)
  )
  const observedKeys = new Set(observation.operationKeys)
  const missing = [...projectionKeys].filter((key) => !observedKeys.has(key))
  assert.ok(missing.length > 0)
})

test('2) missing operationId fails extractor', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'))
  try
  {
    const observation = sampleObservation()
    observation.operations[0].operationId = ''
    const sealed = writeObservation(directory, observation)
    const result = extractOpenApi({
      repositoryRoot: directory,
      buildIdentity: {
        artifactId: 'openapi-aeds-observation',
        receiptDigest: 'b'.repeat(64),
        artifactDigest: sealed.artifactDigest
      }
    })
    assert.equal(result.status, 'failed')
    assert.match(result.failureReasons.join('\n'), /missing operationId|duplicate/iu)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('3) auth drift is visible in observation map fields', () =>
{
  const observation = sampleObservation()
  observation.operations[1].auth = 'user'
  const facts = observationToFactObservations(observation)
  assert.equal(facts.operations.binary_post_admin_article.auth, 'user')
  assert.notEqual(facts.operations.binary_post_admin_article.auth, 'admin')
})

test('4) rate-limit and cache metadata are required observation fields', () =>
{
  const observation = sampleObservation()
  delete observation.operations[0].rateLimit
  const errors = validateObservationAgainstProtocol(observation, loadProtocol())
  assert.ok(errors.some((error) => /rateLimit/u.test(error)))
})

test('5) response frame must exist in aeds-protocol.json', () =>
{
  const observation = sampleObservation()
  observation.operations[0].responseFrame = 'NotARealFrame'
  const errors = validateObservationAgainstProtocol(observation, loadProtocol())
  assert.ok(errors.some((error) => /NotARealFrame/u.test(error)))
})

test('6) source regex is not used for qualification in binary-contract-matrix source', () =>
{
  const source = readFileSync(
    path.join(root, 'tests/frontend/checks/runtime/binary-contract-matrix.mjs'),
    'utf8'
  )
  assert.doesNotMatch(source, /extractBackendBinaryRoutesFromSource\s*\(/u)
  assert.match(source, /source-regex non-qualifying|MUST NOT participate/u)
})

test('7) ambient bin/Debug identity is refused by extractor', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'))
  try
  {
    const sealed = writeObservation(directory, sampleObservation())
    const result = extractOpenApi({
      repositoryRoot: directory,
      buildIdentity: {
        artifactId: 'openapi-aeds-observation',
        receiptDigest: 'b'.repeat(64),
        artifactDigest: sealed.artifactDigest,
        path: 'src/backend/bin/Debug/net10.0/FsusBlog.Server.dll'
      }
    })
    assert.equal(result.status, 'failed')
    assert.match(result.failureReasons.join('\n'), /bin\/Debug|bin\/Release|ambient/iu)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('8) reverse generation markers from checked-in OpenAPI fail closed', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'))
  try
  {
    const observation = sampleObservation({
      source: 'checked-in-openapi',
      generatedFromCheckedInOpenApi: true
    })
    const sealed = writeObservation(directory, observation)
    const result = extractOpenApi({
      repositoryRoot: directory,
      buildIdentity: {
        artifactId: 'openapi-aeds-observation',
        receiptDigest: 'b'.repeat(64),
        artifactDigest: sealed.artifactDigest
      }
    })
    assert.equal(result.status, 'failed')
    assert.match(result.failureReasons.join('\n'), /reverse-generated|checked-in OpenAPI/iu)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('9) duplicate method/path fails extractor', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'))
  try
  {
    const observation = sampleObservation()
    observation.operations.push({ ...observation.operations[0], operationId: 'binary_get_article_id_aeds_dup' })
    observation.operationCount = 3
    const sealed = writeObservation(directory, observation)
    const result = extractOpenApi({
      repositoryRoot: directory,
      buildIdentity: {
        artifactId: 'openapi-aeds-observation',
        receiptDigest: 'b'.repeat(64),
        artifactDigest: sealed.artifactDigest
      }
    })
    assert.equal(result.status, 'failed')
    assert.match(result.failureReasons.join('\n'), /duplicate method\/path/u)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('extractor accepts sealed observation and emits operation map', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'))
  try
  {
    const sealed = writeObservation(directory, sampleObservation())
    const result = extractOpenApi({
      repositoryRoot: directory,
      buildIdentity: {
        artifactId: 'openapi-aeds-observation',
        receiptDigest: 'b'.repeat(64),
        artifactDigest: sealed.artifactDigest
      }
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.observations.operationCount, 2)
    assert.equal(result.observations.operations.binary_post_admin_article.auth, 'admin')
    assert.equal(result.observations.operations.binary_post_admin_article.pow, true)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('stale artifact digest (yesterday Debug swap) fails', () =>
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'))
  try
  {
    writeObservation(directory, sampleObservation())
    const result = extractOpenApi({
      repositoryRoot: directory,
      buildIdentity: {
        artifactId: 'openapi-aeds-observation',
        receiptDigest: 'b'.repeat(64),
        artifactDigest: '0'.repeat(64)
      }
    })
    assert.equal(result.status, 'failed')
    assert.match(result.failureReasons.join('\n'), /digest mismatch|stale|unbound/iu)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('second OpenAPI authority search for matrix generator is retired', () =>
{
  const openapiContracts = readFileSync(
    path.join(root, 'tools/contracts/lib/openapi-contracts.mjs'),
    'utf8'
  )
  assert.match(openapiContracts, /buildOpenApiFromMatrix is retired/u)
  const exportScript = readFileSync(path.join(root, 'tools/contracts/export-openapi.sh'), 'utf8')
  assert.doesNotMatch(exportScript, /OpenApiGenerateDocumentsOnBuild=true/u)
  assert.match(exportScript, /check-openapi-sync\.mjs/u)
  assert.doesNotMatch(exportScript, /FSUSBLOG_OPENAPI_ALLOW_SNAPSHOT_FALLBACK/u)
})
