#!/usr/bin/env node

import { decodeApiErrorFrame, decodeAedsFrame, decodeKnownFrame } from '../../support/aeds-envelope.mjs'
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs'
import { extractBackendBinaryRoutes, loadProtocol } from '../support/crossStackMatrix.mjs'

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000'
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000)
const materializePath = (path) => path
  .replaceAll('{page}', '1')
  .replaceAll('{size}', '1')
  .replaceAll('{id:int}', '1')
  .replaceAll('{id:long}', '1')
  .replaceAll('{articleId:int}', '1')
  .replaceAll('{rootId:long}', '1')
  .replaceAll('{slug}', 'about')
  .replaceAll('{username}', 'admin')
  .replaceAll('{uploadId}', 'test-upload')

const frameValues = new Map(loadProtocol().frameTypes.map(frame => [frame.name, frame.value]))
const openapiRoutes = extractBackendBinaryRoutes()
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

function assertOctetStream(name, response) {
  const contentType = response.headers.get('content-type') || ''
  assert(contentType.includes('application/octet-stream'), `[${name}] expected application/octet-stream, got ${contentType || 'none'}`)
}

async function fetchBinary(name, path, init = {}) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/octet-stream',
      ...(init.headers || {})
    }
  }, requestTimeoutMs)
  assert(response.status < 500, `[${name}] must not return 5xx, got ${response.status}`)
  assertOctetStream(name, response)
  return { response, payload: await response.arrayBuffer() }
}

async function checkPublic([name, path, expectedFrameType]) {
  const { response, payload } = await fetchBinary(name, path)
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
