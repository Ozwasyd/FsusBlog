#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolveAuthFixtureDirectory, resolveFixtureRoot } from '../../tests/frontend/support/fixture-paths.mjs'
import { testSessionHeaders } from '../../tests/frontend/support/test-session.mjs'
import { readRuntimeEnvironment } from '../test/bundles/runtime-environment.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontendRoot = path.join(root, 'src', 'frontend')
const defaultOutputDirectory = path.join(
  process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? path.join(root, '.tmp', 'security'),
  'authenticated-dast')
const deniedStatuses = new Set([400, 401, 403, 404, 405, 409, 413, 415, 422, 428, 429])
const fixedFailureCategories = new Set([
  'backend-invalid-origin',
  'backend-invalid-protocol',
  'backend-non-loopback-target',
  'backend-must-be-origin-only',
  'frontend-invalid-origin',
  'frontend-invalid-protocol',
  'frontend-non-loopback-target',
  'frontend-must-be-origin-only',
  'fixture-preparation-start-failed',
  'fixture-preparation-failed',
  'fixture-not-generated-by-current-lane',
  'fixture-target-mismatch',
  'fixture-user-storage-state-invalid',
  'fixture-user-storage-state-not-private',
  'fixture-admin-storage-state-invalid',
  'fixture-admin-storage-state-not-private'
])

function sanitizeNamespace(value) {
  const normalized = String(value ?? 'local')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return normalized || 'local'
}

function fixedFailureCategory(error) {
  const category = error instanceof Error ? error.message : ''
  return fixedFailureCategories.has(category) ? category : 'authenticated-dast-failed'
}

export function resolveAuthenticatedDastEnvironment(env, loadRuntimeEnvironment = readRuntimeEnvironment) {
  const namespace = sanitizeNamespace(env.FSUSBLOG_TEST_NAMESPACE)
  const hasOrigins = Boolean(
    (env.FSUSBLOG_BASE_URL || env.FSUSBLOG_DEBUG_BACKEND_URL)
    && (env.PLAYWRIGHT_BASE_URL || env.FSUSBLOG_DEBUG_FRONTEND_URL)
  )
  const runtime = hasOrigins ? {} : loadRuntimeEnvironment(root, namespace)
  const merged = { ...runtime, ...env }
  return {
    ...merged,
    FSUSBLOG_TEST_NAMESPACE: namespace,
    FSUSBLOG_BASE_URL: merged.FSUSBLOG_BASE_URL || merged.FSUSBLOG_DEBUG_BACKEND_URL,
    PLAYWRIGHT_BASE_URL: merged.PLAYWRIGHT_BASE_URL || merged.FSUSBLOG_DEBUG_FRONTEND_URL,
    FSUSBLOG_PG_CONTAINER: merged.FSUSBLOG_PG_CONTAINER || merged.FSUSBLOG_POSTGRES_CONTAINER_NAME,
    FSUSBLOG_REDIS_CONTAINER: merged.FSUSBLOG_REDIS_CONTAINER || merged.FSUSBLOG_REDIS_CONTAINER_NAME
  }
}

export function assertLoopbackOrigin(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}-invalid-origin`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label}-invalid-protocol`)
  }
  const hostname = url.hostname.toLowerCase()
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    throw new Error(`${label}-non-loopback-target`)
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label}-must-be-origin-only`)
  }
  return url.origin
}

export function buildAuthenticatedScanPlan() {
  const sqlPayload = encodeURIComponent("' OR 1=1 --")
  const xssPayload = encodeURIComponent('<svg onload=alert(1)>')
  const templatePayload = encodeURIComponent('${7*7}{{7*7}}')
  const malformedBinary = Buffer.from([0x46, 0x41, 0x45, 0x44, 0xff, 0x00, 0x7f])
  return [
    {
      context: 'anonymous',
      storageState: null,
      checks: [
        { id: 'anonymous-user-identity-denied', method: 'GET', path: '/api/binary/auth/me', expectation: 'denied' },
        { id: 'anonymous-admin-identity-denied', method: 'GET', path: '/api/binary/auth/admin/me', expectation: 'denied' },
        { id: 'anonymous-author-console-denied', method: 'GET', path: `/api/binary/author/taxonomy/categories?keyword=${xssPayload}`, expectation: 'denied' }
      ]
    },
    {
      context: 'user',
      storageState: 'user.storage-state.json',
      checks: [
        { id: 'user-identity-authenticated', method: 'GET', path: '/api/binary/auth/me', expectation: 'allowed' },
        { id: 'user-admin-identity-denied', method: 'GET', path: '/api/binary/auth/admin/me', expectation: 'denied' },
        { id: 'user-admin-sqli-denied', method: 'GET', path: `/api/binary/admin/users?page=1&pageSize=5&keyword=${sqlPayload}`, expectation: 'denied' },
        { id: 'user-author-xss-denied', method: 'GET', path: `/api/binary/author/taxonomy/categories?keyword=${xssPayload}`, expectation: 'denied' }
      ]
    },
    {
      context: 'admin',
      storageState: 'admin.storage-state.json',
      checks: [
        { id: 'admin-identity-authenticated', method: 'GET', path: '/api/binary/auth/admin/me', expectation: 'allowed' },
        { id: 'admin-user-identity-separated', method: 'GET', path: '/api/binary/auth/me', expectation: 'denied' },
        { id: 'admin-user-search-sqli-safe', method: 'GET', path: `/api/binary/admin/users?page=1&pageSize=5&keyword=${sqlPayload}`, expectation: 'no-server-error' },
        {
          id: 'admin-system-send-csrf-malformed-denied',
          method: 'POST',
          path: '/api/binary/admin/messages/system-send',
          expectation: 'denied',
          headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/octet-stream' },
          data: malformedBinary
        }
      ]
    },
    {
      context: 'author-console',
      storageState: 'admin.storage-state.json',
      checks: [
        { id: 'author-console-authenticated', method: 'GET', path: '/api/binary/author/taxonomy/categories', expectation: 'allowed' },
        { id: 'author-console-xss-safe', method: 'GET', path: `/api/binary/author/drafts/${xssPayload}`, expectation: 'no-server-error' },
        { id: 'author-console-template-safe', method: 'GET', path: `/api/binary/author/drafts/${templatePayload}`, expectation: 'no-server-error' },
        {
          id: 'author-console-csrf-malformed-denied',
          method: 'PUT',
          path: '/api/binary/author/moderation/anonymous-comment-policy',
          expectation: 'denied',
          headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/octet-stream' },
          data: malformedBinary
        }
      ]
    }
  ]
}

export function evaluateScanStatus(status, expectation) {
  if (!Number.isInteger(status) || status < 100 || status > 599) return false
  if (expectation === 'allowed') return status >= 200 && status < 300
  if (expectation === 'denied') return deniedStatuses.has(status)
  if (expectation === 'no-server-error') return status < 500
  throw new Error(`unknown-scan-expectation:${expectation}`)
}

function fixtureIdentity(namespace) {
  return createHash('sha256').update(namespace, 'utf8').digest('hex').slice(0, 12)
}

function runFreshFixturePreparation(env, namespace) {
  const suffix = fixtureIdentity(namespace)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'tools/test-fixtures/cli.mjs',
      'run',
      '--profile',
      'auth-basic',
      '--source',
      'dev-cli',
      '--skip-verify'
    ], {
      cwd: root,
      env: {
        ...env,
        FSUSBLOG_PERSIST_AUTH_FIXTURES: '1',
        FSUSBLOG_USER_USERNAME: `binaryuser-dast-${suffix}`,
        FSUSBLOG_ADMIN_USERNAME: `binaryadmin-dast-${suffix}`,
        FSUSBLOG_DEVICE_FP: `authenticated-dast-${suffix}`
      },
      stdio: 'inherit'
    })
    child.once('error', () => reject(new Error('fixture-preparation-start-failed')))
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) resolve()
      else reject(new Error('fixture-preparation-failed'))
    })
  })
}

async function readFreshFixture(fixtureDirectory, startedAtMs, frontendOrigin) {
  const manifestFile = path.join(fixtureDirectory, 'auth-fixtures.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const generatedAtMs = Date.parse(manifest.generatedAt)
  if (!Number.isFinite(generatedAtMs) || generatedAtMs < startedAtMs - 1_000 || generatedAtMs > Date.now() + 5_000) {
    throw new Error('fixture-not-generated-by-current-lane')
  }
  if (new URL(manifest.baseUrl).hostname !== new URL(frontendOrigin).hostname) {
    throw new Error('fixture-target-mismatch')
  }
  for (const key of ['user', 'admin']) {
    const storageStateFile = manifest[key]?.storageStateFile
    if (typeof storageStateFile !== 'string' || path.basename(storageStateFile) !== storageStateFile) {
      throw new Error(`fixture-${key}-storage-state-invalid`)
    }
    const storageStatePath = path.join(fixtureDirectory, storageStateFile)
    const fileStat = await stat(storageStatePath)
    if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) {
      throw new Error(`fixture-${key}-storage-state-not-private`)
    }
  }
  return { manifest, generatedAtMs }
}

async function readRequestCookieHeader(storageStateFile) {
  const storageState = JSON.parse(await readFile(storageStateFile, 'utf8'))
  if (!Array.isArray(storageState.cookies) || storageState.cookies.length === 0) {
    throw new Error('fixture-storage-state-cookies-missing')
  }
  return storageState.cookies.map((cookie) => {
    const name = String(cookie?.name ?? '')
    const value = String(cookie?.value ?? '')
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || /[\x00-\x20\x7f;,]/u.test(value)) {
      throw new Error('fixture-storage-state-cookie-invalid')
    }
    return `${name}=${value}`
  }).join('; ')
}

async function runContextScan(requestApi, backendOrigin, fixtureDirectory, entry, timeoutMs, deviceFingerprint) {
  const cookieHeader = entry.storageState
    ? await readRequestCookieHeader(path.join(fixtureDirectory, entry.storageState))
    : null
  const context = await requestApi.newContext({
    baseURL: backendOrigin,
    extraHTTPHeaders: {
      Accept: 'application/octet-stream',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36',
      'X-Fsus-Device-Fp': deviceFingerprint,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...testSessionHeaders()
    }
  })
  const results = []
  try {
    for (const check of entry.checks) {
      try {
        const response = await context.fetch(check.path, {
          method: check.method,
          headers: check.headers,
          data: check.data,
          timeout: timeoutMs,
          failOnStatusCode: false
        })
        const status = response.status()
        results.push({
          id: check.id,
          context: entry.context,
          method: check.method,
          status,
          passed: evaluateScanStatus(status, check.expectation)
        })
        await response.dispose()
      } catch {
        results.push({ id: check.id, context: entry.context, method: check.method, status: null, passed: false })
      }
    }
  } finally {
    await context.dispose()
  }
  return results
}

function loadPlaywrightRequestApi() {
  const require = createRequire(path.join(frontendRoot, 'package.json'))
  return require('@playwright/test').request
}

async function writeSummary(outputDirectory, summary) {
  await mkdir(outputDirectory, { recursive: true })
  const outputFile = path.join(outputDirectory, 'summary.json')
  await writeFile(outputFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return Object.freeze([outputFile])
}

export async function runAuthenticatedDast({
  env = process.env,
  requestApi = null,
  prepareFixtures = runFreshFixturePreparation,
  outputDirectory = defaultOutputDirectory,
  now = () => Date.now(),
  resultOutlet = null
} = {}) {
  env = resolveAuthenticatedDastEnvironment(env)
  const startedAtMs = now()
  const namespace = sanitizeNamespace(env.FSUSBLOG_TEST_NAMESPACE)
  const fixtureRoot = path.join(resolveFixtureRoot({ env, repoRoot: root }), 'authenticated-dast')
  await rm(outputDirectory, { recursive: true, force: true })
  await rm(fixtureRoot, { recursive: true, force: true })
  let backendOrigin = null
  let frontendOrigin = null
  let fixtureGeneratedAt = null
  let results = []
  let failureCategory = null
  let failureDetail = null
  try {
    backendOrigin = assertLoopbackOrigin(env.FSUSBLOG_DEBUG_BACKEND_URL || env.FSUSBLOG_BASE_URL, 'backend')
    frontendOrigin = assertLoopbackOrigin(env.FSUSBLOG_DEBUG_FRONTEND_URL || env.PLAYWRIGHT_BASE_URL, 'frontend')
    const laneEnv = {
      ...env,
      FSUSBLOG_FIXTURE_ROOT: fixtureRoot,
      FSUSBLOG_BASE_URL: backendOrigin,
      FSUSBLOG_DEBUG_BACKEND_URL: backendOrigin,
      PLAYWRIGHT_BASE_URL: frontendOrigin,
      FSUSBLOG_DEBUG_FRONTEND_URL: frontendOrigin,
      FSUSBLOG_PG_CONTAINER: env.FSUSBLOG_POSTGRES_CONTAINER_NAME || env.FSUSBLOG_PG_CONTAINER,
      FSUSBLOG_REDIS_CONTAINER: env.FSUSBLOG_REDIS_CONTAINER_NAME || env.FSUSBLOG_REDIS_CONTAINER
    }
    await prepareFixtures(laneEnv, namespace)
    const fixtureDirectory = resolveAuthFixtureDirectory({ env: laneEnv, repoRoot: root })
    const fixture = await readFreshFixture(fixtureDirectory, startedAtMs, frontendOrigin)
    fixtureGeneratedAt = new Date(fixture.generatedAtMs).toISOString()
    const scanPlan = buildAuthenticatedScanPlan()
    const timeoutMs = Math.max(1_000, Number.parseInt(env.FSUSBLOG_HTTP_TIMEOUT_MS || '15000', 10) || 15_000)
    const activeRequestApi = requestApi ?? loadPlaywrightRequestApi()
    const deviceFingerprint = `authenticated-dast-${fixtureIdentity(namespace)}`
    const contextResults = await Promise.all(scanPlan.map((entry) => (
      runContextScan(activeRequestApi, backendOrigin, fixtureDirectory, entry, timeoutMs, deviceFingerprint)
    )))
    results = contextResults.flat()
    if (results.some((result) => !result.passed)) failureCategory = 'active-scan-check-failed'
  } catch (error) {
    failureCategory = fixedFailureCategory(error)
    failureDetail = error instanceof Error ? error.message : String(error)
  }

  let fixtureCleanup = 'success'
  try {
    await rm(fixtureRoot, { recursive: true, force: true })
  } catch {
    fixtureCleanup = 'failure'
    failureCategory ??= 'fixture-cleanup-failed'
  }

  const finishedAtMs = now()
  const failedChecks = results.filter((result) => !result.passed).map((result) => result.id)
  const status = failureCategory === null ? 'ok' : 'failure'
  const summary = {
    schema: 'fsusblog.security.authenticated-dast.v1',
    status,
    namespace,
    executionSource: 'fresh-current-lane',
    targetPolicy: {
      loopbackOnly: true,
      productionTargetAllowed: false,
      backendOrigin,
      frontendOrigin
    },
    fixture: {
      executionSource: 'fresh-current-lane',
      generatedAt: fixtureGeneratedAt,
      historicalStateAccepted: false,
      cleanup: fixtureCleanup
    },
    activeScan: {
      executed: results.length > 0,
      requestCount: results.length,
      passedCount: results.filter((result) => result.passed).length,
      failedCount: failedChecks.length,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMs)
    },
    contexts: Object.fromEntries(['anonymous', 'user', 'admin', 'author-console'].map((context) => {
      const checks = results.filter((result) => result.context === context)
      return [context, {
        executed: checks.length > 0,
        requestCount: checks.length,
        passedCount: checks.filter((result) => result.passed).length,
        failedCount: checks.filter((result) => !result.passed).length
      }]
    })),
    checks: results,
    failedChecks,
    failureCategory,
    failureDetail,
    asvs: ['V1', 'V2', 'V3', 'V4', 'V5', 'V7', 'V10'],
    wstg: ['WSTG-ATHN', 'WSTG-ATHZ', 'WSTG-SESS', 'WSTG-INPV']
  }
  const artifactPaths = await writeSummary(outputDirectory, summary)
  await resultOutlet?.({ summary, artifactPaths })
  return summary
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  runAuthenticatedDast().then((summary) => {
    console.log(`[security-authenticated-dast] ${summary.status}; requests=${summary.activeScan.requestCount}; durationMs=${summary.activeScan.durationMs}`)
    if (summary.status !== 'ok') process.exitCode = 1
  }).catch(async () => {
    process.exitCode = 1
  })
}
