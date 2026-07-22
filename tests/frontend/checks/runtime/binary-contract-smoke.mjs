#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { decodeApiErrorFrame, decodeAedsFrame } from '../../support/aeds-envelope.mjs'
import { buildPowHeaders, fetchChallenge } from '../../support/auth-helpers.mjs'
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs'

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568'
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000)
const execFileAsync = promisify(execFile)
const resetSecurityTestState = process.env.FSUSBLOG_RESET_SECURITY_TEST_STATE !== '0'
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || process.env.FSUSBLOG_REDIS_CONTAINER_NAME || 'fsusblog-redis'
const maxDeterministicPowDifficulty = Number.parseInt(process.env.FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY ?? '20', 10) || 20

const successChecks = [
  ['article list', '/api/binary/article/list/home/1/3.aeds', 1],
  ['article hot', '/api/binary/article/hot/3.aeds', 3],
  ['category list', '/api/binary/category.aeds', 9],
  ['tag list', '/api/binary/tag.aeds', 10],
  // Public article comments are served as CommentTreeRootCursor (208), not the
  // legacy CommentArticleCursor (5) surface.
  ['comment cursor', '/api/binary/comment/1?limit=5', 208]
]

const denialChecks = [
  ['comment me anonymous', '/api/binary/comment/me?limit=5', 401],
  ['deleted article anonymous', '/api/binary/admin/article?page=1&size=5&isDeleted=true', 401],
  ['article status anonymous', '/api/binary/admin/article?page=1&size=5&status=0', 401],
  ['admin stats anonymous', '/api/binary/stats', 401],
  ['recent comments anonymous', '/api/binary/stats/recent-comments', 401],
  ['regions anonymous', '/api/binary/stats/regions', 401]
]

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resetLocalSecurityRiskState() {
  if (!resetSecurityTestState) {
    return
  }

  try {
    await execFileAsync('docker', [
      'exec',
      redisContainer,
      'sh',
      '-c',
      "redis-cli --scan --pattern '*fsus:sec:pow-risk:*' | xargs -r redis-cli DEL"
    ], { timeout: 5000 })
  } catch {
    // Non-local environments may not use the developer docker container.
  }
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
  await waitForDeterministicPow('binary contract smoke')
}

async function fetchBinary(name, path) {
  let response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: { Accept: 'application/octet-stream' }
  }, requestTimeoutMs)
  if (response.status === 428) {
    await resetAndWaitForPublicReadBudget()
    const powHeaders = await buildPowHeaders(`binary-contract-${name}`, requestTimeoutMs)
    response = await fetchWithTimeout(`${baseUrl}${path}`, {
      headers: {
        Accept: 'application/octet-stream',
        ...powHeaders
      }
    }, requestTimeoutMs)
  }
  assert(response.status < 500, `[${name}] binary endpoint must not return 5xx, got ${response.status}`)
  const contentType = response.headers.get('content-type') || ''
  assert(contentType.includes('application/octet-stream'), `[${name}] expected octet-stream, got ${contentType || 'none'}`)
  return { response, payload: await response.arrayBuffer() }
}

async function checkSuccess([name, path, expectedFrameType]) {
  const { response, payload } = await fetchBinary(name, path)
  assert(response.status === 200, `[${name}] expected 200, got ${response.status}`)
  const frame = decodeAedsFrame(payload)
  assert(frame.frameType === expectedFrameType, `[${name}] expected frame ${expectedFrameType}, got ${frame.frameType}`)
  console.log(`[binary-contract-smoke] ok: ${name}`)
}

async function checkDenial([name, path, expectedStatus]) {
  const { response, payload } = await fetchBinary(name, path)
  assert(response.status === expectedStatus, `[${name}] expected ${expectedStatus}, got ${response.status}`)
  const error = decodeApiErrorFrame(payload)
  assert(error.statusCode === expectedStatus, `[${name}] ApiError status mismatch: ${error.statusCode}`)
  console.log(`[binary-contract-smoke] ok: ${name}`)
}

async function main() {
  await probeReachable(`${baseUrl}/api/binary/article/list/home/1/1.aeds`, '[binary-contract-smoke backend]', requestTimeoutMs)
  await resetAndWaitForPublicReadBudget()

  for (const item of successChecks) {
    await checkSuccess(item)
  }

  for (const item of denialChecks) {
    await checkDenial(item)
  }

  console.log('[binary-contract-smoke] all checks passed')
}

main().catch((error) => {
  console.error('[binary-contract-smoke] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
