#!/usr/bin/env node

import { decodeApiErrorFrame, decodeAedsFrame } from '../../support/aeds-envelope.mjs'
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs'

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000'
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000)

const publicChecks = [
  ['article list', '/api/binary/article?page=1&size=1', 1],
  ['article hot', '/api/binary/article/hot?size=1', 3],
  ['category list', '/api/binary/category', 9],
  ['tag list', '/api/binary/tag', 10]
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

async function main() {
  await probeReachable(`${baseUrl}/api/binary/article?page=1&size=1`, '[api-contract-matrix backend]', requestTimeoutMs)

  for (const item of publicChecks) {
    await checkPublic(item)
  }

  for (const item of deniedChecks) {
    await checkDenied(item)
  }

  console.log('[api-contract-matrix] all checks passed')
}

main().catch((error) => {
  console.error('[api-contract-matrix] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
