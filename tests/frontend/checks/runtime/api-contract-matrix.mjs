#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { decodeApiErrorFrame, decodeAedsFrame, decodeKnownFrame } from '../../support/aeds-envelope.mjs'
import { buildPowHeaders, fetchChallenge } from '../../support/auth-helpers.mjs'
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs'
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs'
import { extractBackendBinaryRoutes, loadProtocol } from '../support/crossStackMatrix.mjs'

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568'
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000)
const execFileAsync = promisify(execFile)
const resetSecurityTestState = process.env.FSUSBLOG_RESET_SECURITY_TEST_STATE !== '0'
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || process.env.FSUSBLOG_REDIS_CONTAINER_NAME || 'fsusblog-redis'
const postgresContainer = process.env.FSUSBLOG_PG_CONTAINER || process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME || ''
const maxDeterministicPowDifficulty = Number.parseInt(process.env.FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY ?? '20', 10) || 20
const publicFixtureIds = readPublicFixtureIds()
const materializePath = (path) => path
  .replaceAll('{page}', '1')
  .replaceAll('{size}', '1')
  .replaceAll('{id}', String(publicFixtureIds.articleId))
  .replaceAll('{id:int}', String(publicFixtureIds.articleId))
  .replaceAll('{id:long}', String(publicFixtureIds.articleId))
  .replaceAll('{categoryId}', String(publicFixtureIds.categoryId))
  .replaceAll('{articleId:int}', String(publicFixtureIds.articleId))
  .replaceAll('{rootId:long}', '1')
  .replaceAll('{tagId}', String(publicFixtureIds.tagId))
  .replaceAll('{slug}', 'about')
  .replaceAll('{username}', 'admin')
  .replaceAll('{uploadId}', 'test-upload')

const frameValues = new Map(loadProtocol().frameTypes.map(frame => [frame.name, frame.value]))
const openapiRoutes = extractBackendBinaryRoutes()
const expectedUnavailablePublicChecks = new Set([
  'binary_get_anonymous_credential_root',
  'binary_get_anonymous_credential_circuit',
  'binary_get_anonymous_credential_blind_issuer',
  'binary_get_anonymous_credential_revocation_full',
  'binary_get_anonymous_credential_revocation_delta'
])
const optionalNotFoundPublicChecks = new Set([
  'binary_get_article_id_aeds',
  'binary_get_article_list_category_categoryId_page_size_aeds',
  'binary_get_article_list_tag_tagId_page_size_aeds',
  'binary_get_article_featured_size_aeds',
  'binary_get_anonymous_credential_revocation_full',
  'binary_get_anonymous_credential_revocation_delta'
])
const publicChecks = openapiRoutes
  .filter(route => route.method === 'GET' && route.auth === 'anonymous' && route.pow !== true && route.responseFrame && frameValues.has(route.responseFrame))
  .map(route => [route.operationId || route.path, `/api/binary${materializePath(route.path)}`, frameValues.get(route.responseFrame)])
  .slice(0, 12)

const deniedChecks = openapiRoutes
  .filter(route => route.method === 'GET' && ['user', 'admin'].includes(route.auth))
  .map(route => [route.operationId || route.path, `/api/binary${materializePath(route.path)}`, 401])
  .slice(0, 12)

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function resetLocalSecurityRiskState() {
  if (!resetSecurityTestState) {
    return
  }

  await resetLocalPersistedSecurityRiskState()

  try {
    await execFileAsync('docker', [
      'exec',
      redisContainer,
      'sh',
      '-c',
      "{ redis-cli --scan --pattern '*fsus:sec:pow-risk:*'; redis-cli --scan --pattern 'fsus:sec:pow-risk:*'; } | sort -u | xargs -r redis-cli DEL"
    ], { timeout: 5000 })
  } catch {
    // Non-local environments may not use the developer docker container.
  }
}

async function resetLocalPersistedSecurityRiskState() {
  if (!/^fsusblog-(dev|test|ci)([-_.A-Za-z0-9]*)$/.test(postgresContainer)) {
    return
  }

  try {
    await execFileAsync('docker', [
      'exec',
      postgresContainer,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-U',
      'fsusblog',
      '-d',
      'fsusblog',
      '-c',
      'delete from security_risk_event'
    ], { timeout: 5000 })
  } catch {
    // Non-local environments may not expose the runtime PostgreSQL container.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForDeterministicPow(label) {
  let lastDifficulty = 'unknown'
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const challenge = await fetchChallenge(5000)
      const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 999)
      lastDifficulty = Number.isFinite(difficulty) ? String(difficulty) : 'unknown'
      if (difficulty <= maxDeterministicPowDifficulty) {
        return
      }
    } catch {
      lastDifficulty = 'unreachable'
    }

    await delay(1000)
  }

  throw new Error(`${label} pow difficulty did not settle below ${maxDeterministicPowDifficulty}; last=${lastDifficulty}`)
}

async function resetAndWaitForPublicReadBudget() {
  await resetLocalSecurityRiskState()
  await waitForDeterministicPow('api contract matrix')
}

function assertOctetStream(name, response) {
  const contentType = response.headers.get('content-type') || ''
  assert(contentType.includes('application/octet-stream'), `[${name}] expected application/octet-stream, got ${contentType || 'none'}`)
}

async function fetchBinary(name, path, init = {}) {
  const execute = () => fetchWithTimeout(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/octet-stream',
      ...(init.headers || {})
    }
  }, requestTimeoutMs)

  let response = await execute()
  if (response.status === 429 && resetSecurityTestState) {
    console.log(`[api-contract-rate-limit-retry] ${name}`)
    await resetLocalSecurityRiskState()
    await delay(250)
    response = await execute()
  }

  if (response.status === 428) {
    const powHeaders = await buildPowHeaders(`api-contract-${name}`, requestTimeoutMs)
    response = await fetchWithTimeout(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/octet-stream',
        ...powHeaders,
        ...(init.headers || {})
      }
    }, requestTimeoutMs)
    if (response.status === 429 && resetSecurityTestState) {
      console.log(`[api-contract-rate-limit-retry] ${name}`)
      await resetLocalSecurityRiskState()
      await delay(250)
      response = await fetchWithTimeout(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/octet-stream',
          ...powHeaders,
          ...(init.headers || {})
        }
      }, requestTimeoutMs)
    }
  }
  assert(response.status < 500 || (response.status === 503 && expectedUnavailablePublicChecks.has(name)), `[${name}] must not return unexpected 5xx, got ${response.status}`)
  if (response.status === 404 && optionalNotFoundPublicChecks.has(name)) {
    return { response, payload: new ArrayBuffer(0) }
  }
  assertOctetStream(name, response)
  return { response, payload: await response.arrayBuffer() }
}

async function checkPublic([name, path, expectedFrameType]) {
  const { response, payload } = await fetchBinary(name, path)
  if (response.status === 503 && expectedUnavailablePublicChecks.has(name)) {
    const error = decodeApiErrorFrame(payload)
    assert(error.statusCode === 503, `[${name}] expected unavailable ApiError status 503, got ${error.statusCode}`)
    assert(error.message.length > 0, `[${name}] unavailable ApiError missing message`)
    console.log(`[api-contract-matrix] ok: ${name} unavailable`)
    await resetAndWaitForPublicReadBudget()
    return
  }
  if (response.status === 404 && optionalNotFoundPublicChecks.has(name)) {
    console.log(`[api-contract-matrix] ok: ${name} optional-not-found`)
    return
  }

  assert(response.ok, `[${name}] expected 2xx, got ${response.status}`)
  const frame = decodeAedsFrame(payload)
  assert(frame.frameType === expectedFrameType, `[${name}] expected frame ${expectedFrameType}, got ${frame.frameType}`)
  if (expectedFrameType === 1) {
    const decoded = decodeKnownFrame(payload)
    for (const item of decoded.items ?? []) {
      assert(item.isDeleted === false, `[${name}] public item must expose isDeleted=false`)
      assert(item.status === 2, `[${name}] public item must expose published status`)
      assert(item.scheduledPublishAt === null, `[${name}] public item must not expose pending schedule`)
    }
  }
  console.log(`[api-contract-matrix] ok: ${name}`)
}

async function checkDenied([name, path, expectedStatus]) {
  const { response, payload } = await fetchBinary(name, path)
  assert(response.status === expectedStatus, `[${name}] expected status ${expectedStatus}, got ${response.status}`)
  const error = decodeApiErrorFrame(payload)
  assert(error.statusCode === expectedStatus, `[${name}] ApiError status mismatch: ${error.statusCode}`)
  assert(error.message.length > 0, `[${name}] ApiError missing message`)
  console.log(`[api-contract-matrix] ok: ${name}`)
}

async function checkLegacyPublicQueryRoute() {
  const response = await fetchWithTimeout(`${baseUrl}/api/binary/article?page=1&size=1`, {
    headers: { Accept: 'application/octet-stream' }
  }, requestTimeoutMs)
  assert(response.status === 400, `[legacy public query] expected 400, got ${response.status}`)
  assert(response.headers.get('cache-control') === 'no-store', '[legacy public query] must be no-store')
  assert(
    response.headers.get('x-fsus-required-route') === '/api/binary/article/list/home/{page}/{size}.aeds',
    '[legacy public query] must advertise required segment route'
  )
  console.log('[api-contract-matrix] ok: legacy public query route')
}

async function main() {
  await probeReachable(`${baseUrl}/api/binary/article/list/home/1/1.aeds`, '[api-contract-matrix backend]', requestTimeoutMs)
  await resetAndWaitForPublicReadBudget()

  for (const item of publicChecks) {
    await checkPublic(item)
  }

  for (const item of deniedChecks) {
    await checkDenied(item)
  }

  await checkLegacyPublicQueryRoute()

  console.log('[api-contract-matrix] all checks passed')
}

main().catch((error) => {
  console.error('[api-contract-matrix] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
