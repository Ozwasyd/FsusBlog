#!/usr/bin/env node

import { decodeApiErrorFrame, decodeAedsFrame, decodeKnownFrame } from '../../support/aeds-envelope.mjs'
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs'

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000'
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000)

const publicChecks = [
  ['article list', '/api/binary/article/list/home/1/1.aeds', 1],
  ['article hot', '/api/binary/article/hot/1.aeds', 3],
  ['category list', '/api/binary/category.aeds', 9],
  ['tag list', '/api/binary/tag.aeds', 10]
]

const deniedChecks = [
  ['comment me anonymous', '/api/binary/comment/me?limit=1', 401],
  ['stats anonymous', '/api/binary/stats', 401],
  ['recent comments anonymous', '/api/binary/stats/recent-comments', 401],
  ['regions anonymous', '/api/binary/stats/regions', 401]
]

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
