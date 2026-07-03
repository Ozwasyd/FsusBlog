#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { readPublicFixtureIds } from '../../tests/frontend/support/public-fixtures.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const matrixFile = path.join(root, '.tmp/contracts/endpoint-depth-matrix.json')
const outFile = path.join(root, '.tmp/release-evidence/endpoint-depth-summary.json')
const baseUrl = (process.env.FSUSBLOG_BASE_URL || process.env.FSUSBLOG_DEBUG_BACKEND_URL || 'http://127.0.0.1:7568').replace(/\/$/, '')
const maxCases = positiveInt(process.env.FSUSBLOG_ENDPOINT_DEPTH_RUNTIME_CASES, 48)
const timeoutMs = positiveInt(process.env.FSUSBLOG_ENDPOINT_DEPTH_TIMEOUT_MS, 15000)
const expectedUnavailablePublicChecks = new Set([
  'binary_get_anonymous_credential_root',
  'binary_get_anonymous_credential_circuit'
])
const publicFixtureIds = readPublicFixtureIds()

const AEDS_MAGIC = 0x53444541
const AEDS_VERSION = 2
const AEDS_HEADER_LENGTH = 16
const FRAME_TYPES = loadFrameTypes()

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function loadFrameTypes() {
  const protocolFile = path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json')
  const protocol = JSON.parse(fs.readFileSync(protocolFile, 'utf8'))
  const result = new Map()
  for (const frame of protocol.frameTypes ?? []) {
    result.set(frame.name, Number(frame.value))
    result.set(Number(frame.value), frame.name)
  }
  return result
}

function crc16(bytes) {
  let crc = 0xffff
  for (const value of bytes) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1)
    }
  }
  return crc & 0xffff
}

function makeFrame(frameName, payload = new Uint8Array(0)) {
  const frameType = FRAME_TYPES.get(frameName) ?? FRAME_TYPES.get('EmptySuccess') ?? 240
  const frame = new Uint8Array(AEDS_HEADER_LENGTH + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, AEDS_MAGIC, true)
  view.setUint8(4, AEDS_VERSION)
  view.setUint8(5, AEDS_HEADER_LENGTH)
  view.setUint16(6, 0, true)
  view.setUint16(8, frameType, true)
  view.setUint32(10, payload.byteLength, true)
  view.setUint16(14, crc16(payload), true)
  frame.set(payload, AEDS_HEADER_LENGTH)
  return frame
}

function malformedBody(protocolCase, expectedFrame = 'EmptySuccess') {
  if (protocolCase === 'truncated') return makeFrame(expectedFrame).slice(0, 12)
  if (protocolCase === 'oversized') {
    const frame = makeFrame(expectedFrame)
    new DataView(frame.buffer).setUint32(10, 1024 * 1024, true)
    return frame
  }
  if (protocolCase === 'wrong-frame') return makeFrame(expectedFrame === 'ApiError' ? 'CategoryList' : 'ApiError')
  const frame = makeFrame(expectedFrame)
  new DataView(frame.buffer).setUint32(0, 0x44414544, true)
  return frame
}

function materializePath(template) {
  return template.replace(/\{([^}:]+)(?::[^}]+)?\}/g, (_, name) => {
    const values = {
      articleId: String(publicFixtureIds.articleId),
      categoryId: String(publicFixtureIds.categoryId),
      commentId: '1',
      conversationId: '1',
      id: String(publicFixtureIds.articleId),
      page: '1',
      pathKey: 'home',
      size: '10',
      slug: 'about',
      tagId: String(publicFixtureIds.tagId),
      uploadId: 'endpoint-depth-smoke'
    }
    return values[name] ?? '1'
  })
}

function parseFrame(bytes) {
  if (bytes.byteLength < AEDS_HEADER_LENGTH) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== AEDS_MAGIC) return null
  const frameType = view.getUint16(8, true)
  const payloadLength = view.getUint32(10, true)
  return {
    version: view.getUint8(4),
    headerLength: view.getUint8(5),
    flags: view.getUint16(6, true),
    frameType,
    frameName: FRAME_TYPES.get(frameType) ?? `Unknown(${frameType})`,
    payloadLength,
    payloadLengthMatches: payloadLength === bytes.byteLength - AEDS_HEADER_LENGTH,
    crcMatches: payloadLength === bytes.byteLength - AEDS_HEADER_LENGTH
      ? crc16(bytes.subarray(AEDS_HEADER_LENGTH)) === view.getUint16(14, true)
      : false
  }
}

function uniqueById(items) {
  const seen = new Set()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

function mayAuthShortCircuit(item) {
  if (item.role !== 'anonymous') return false
  const method = item.method.toUpperCase()
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    || /\/api\/binary\/(?:admin|author|auth\/me|message|notification|upload|user)(?:\/|$)/u.test(item.path)
}

function scenarioName(item) {
  return item.scenario
    ?? (item.security && item.security !== 'none' ? item.security : null)
    ?? item.protocol
    ?? 'success-or-denied'
}

function selectedCases(cases) {
  const successCases = cases.filter((item) => item.id.endsWith(':success-or-denied'))
  const methodsByPath = new Map()
  for (const item of successCases) {
    const resolvedPath = materializePath(item.path)
    const methods = methodsByPath.get(resolvedPath) ?? new Set()
    methods.add(item.method.toUpperCase())
    methodsByPath.set(resolvedPath, methods)
  }
  const publicSuccess = successCases
    .filter((item) => item.role === 'anonymous'
      && !mayAuthShortCircuit(item)
      && item.expectedStatuses?.some((status) => status >= 200 && status < 300))
    .slice(0, 6)
  const anonymousDenied = successCases
    .filter((item) => item.role === 'anonymous'
      && (mayAuthShortCircuit(item) || item.expectedStatuses?.some((status) => status === 401 || status === 403)))
    .slice(0, 6)
  const protocolCases = cases
    .filter((item) => ['malformed-header', 'wrong-frame', 'truncated', 'oversized'].includes(item.protocol))
    .slice(0, 12)
  const powCases = cases
    .filter((item) => ['missing-pow', 'tampered-pow', 'replayed-pow', 'expired-pow'].includes(item.security))
    .slice(0, 8)
  const wrongMethod = uniqueById(successCases
    .filter((item) => {
      const method = item.method.toUpperCase()
      const alternate = method === 'GET' ? 'POST' : 'GET'
      return !methodsByPath.get(materializePath(item.path))?.has(alternate)
    })
    .map((item) => ({ ...item, id: `${item.operationId}:wrong-method`, scenario: 'wrong-method' })))
    .slice(0, 4)
  const wrongAccept = publicSuccess
    .map((item) => ({ ...item, id: `${item.operationId}:wrong-accept`, scenario: 'wrong-accept' }))
    .slice(0, 4)
  const wrongContentType = successCases
    .filter((item) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(item.method.toUpperCase()))
    .map((item) => ({ ...item, id: `${item.operationId}:wrong-content-type`, scenario: 'wrong-content-type' }))
    .slice(0, 4)

  return uniqueById([
    ...publicSuccess,
    ...anonymousDenied,
    ...protocolCases,
    ...powCases,
    ...wrongMethod,
    ...wrongAccept,
    ...wrongContentType
  ]).slice(0, maxCases)
}

function expectedStatusesFor(item) {
  const statuses = new Set(item.expectedStatuses ?? [200])
  if (expectedUnavailablePublicChecks.has(item.operationId) && scenarioName(item) === 'correct-aeds') {
    statuses.add(503)
  }
  if (item.scenario === 'wrong-method') return [400, 401, 403, 404, 405, 415]
  if (item.scenario === 'wrong-accept') return [200, 400, 401, 403, 406, 415]
  if (item.scenario === 'wrong-content-type') return [400, 401, 403, 415]
  if (mayAuthShortCircuit(item)) {
    statuses.add(401)
    statuses.add(403)
  }
  return [...statuses].sort((left, right) => left - right)
}

function requestForCase(item) {
  const method = item.scenario === 'wrong-method'
    ? (item.method.toUpperCase() === 'GET' ? 'POST' : 'GET')
    : item.method.toUpperCase()
  const headers = {
    Accept: item.scenario === 'wrong-accept' ? 'application/json' : 'application/octet-stream',
    'User-Agent': 'FsusBlog endpoint depth runtime',
    'X-Fsus-Device-Fp': `endpoint-depth-${process.env.FSUSBLOG_TEST_NAMESPACE || 'local'}`
  }
  let body = null
  if (!['GET', 'HEAD'].includes(method)) {
    headers['Content-Type'] = item.scenario === 'wrong-content-type' ? 'application/json' : 'application/octet-stream'
    if (['malformed-header', 'wrong-frame', 'truncated', 'oversized'].includes(item.protocol)) {
      body = malformedBody(item.protocol, item.expectedFrame)
    } else if (item.scenario === 'wrong-content-type') {
      body = JSON.stringify({ invalid: true })
    } else {
      body = makeFrame(item.expectedFrame === 'ApiError' ? 'EmptySuccess' : item.expectedFrame)
    }
  }
  if (['tampered-pow', 'replayed-pow', 'expired-pow'].includes(item.security)) {
    headers['X-Fsus-Pow-Proof'] = 'invalid-endpoint-depth-pow'
  }
  return { method, headers, body }
}

async function runCase(item) {
  const request = requestForCase(item)
  const resolvedPath = materializePath(item.path)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  const started = performance.now()
  try {
    const response = await fetch(`${baseUrl}${resolvedPath}`, { ...request, signal: controller.signal })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const frame = parseFrame(bytes)
    const expectedStatuses = expectedStatusesFor(item)
    const statusOk = expectedStatuses.includes(response.status)
    const frameOk = frame
      ? frame.version === AEDS_VERSION && frame.headerLength === AEDS_HEADER_LENGTH && frame.payloadLengthMatches && frame.crcMatches
      : true
    return {
      id: item.id,
      operationId: item.operationId,
      scenario: scenarioName(item),
      method: request.method,
      path: resolvedPath,
      expectedStatuses,
      status: response.status,
      statusOk,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      bytes: bytes.byteLength,
      contentType: response.headers.get('content-type'),
      frame,
      frameOk,
      sideEffectExpectation: ['wrong-method', 'wrong-content-type'].includes(item.scenario) || item.expectedFrame === 'ApiError'
        ? 'denied-request-no-side-effect'
        : 'read-only-or-invalid-request',
      ok: statusOk && frameOk
    }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  if (!fs.existsSync(matrixFile)) {
    console.error(`[endpoint-depth-runtime] missing ${matrixFile}; run generate-endpoint-depth-matrix first`)
    process.exit(1)
  }
  const matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf8'))
  const cases = selectedCases(matrix.cases ?? [])
  if (cases.length === 0) {
    console.error('[endpoint-depth-runtime] no runtime cases selected')
    process.exit(1)
  }
  const results = []
  for (const item of cases) {
    results.push(await runCase(item))
  }
  const failures = results.filter((item) => !item.ok)
  const summary = {
    status: failures.length === 0 ? 'ok' : 'failed',
    generatedAt: new Date().toISOString(),
    baseUrl,
    operationCount: matrix.operationCount,
    caseCount: matrix.caseCount,
    runtimeCaseCount: results.length,
    failureCount: failures.length,
    scenarios: [...new Set(results.map((item) => item.scenario))].sort(),
    artifact: '.tmp/contracts/endpoint-depth-matrix.json',
    results
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
  if (failures.length > 0) {
    console.error(`[endpoint-depth-runtime] failed cases=${failures.map((item) => item.id).join(', ')}`)
    process.exit(1)
  }
  console.log(`[endpoint-depth-runtime] ok runtimeCases=${results.length} matrixCases=${matrix.caseCount}`)
}

main().catch((error) => {
  console.error('[endpoint-depth-runtime] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
