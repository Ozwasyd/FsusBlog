import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { projectPreparedPublicIds } from '../test-fixtures/receipt/projection.mjs'
import { decodeKnownFrame } from '../../tests/frontend/support/aeds-envelope.mjs'

const execFileAsync = promisify(execFile)

export const baseUrl = String(
  process.env.FSUSBLOG_BASE_URL || process.env.FSUSBLOG_DEBUG_BACKEND_URL || ''
).replace(/\/+$/u, '')
export const frontendUrl = String(
  process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_DEBUG_FRONTEND_URL || baseUrl
).replace(/\/+$/u, '')
export const timeoutMs = Number.parseInt(
  process.env.FSUSBLOG_RUNTIME_OBSERVATION_TIMEOUT_MS || '90000',
  10
)

const pgContainer = process.env.FSUSBLOG_PG_CONTAINER
  || process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME || ''
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER
  || process.env.FSUSBLOG_REDIS_CONTAINER_NAME || ''
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog'
const pgDatabase = process.env.FSUSBLOG_PG_DB || 'fsusblog'

export const fail = (message) => { throw new Error(`[runtime-observation-probe] ${message}`) }
export const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
export const digest = (value) => `sha256:${digestValue(stable(value))}`
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function fixtureProjection(fixture)
{
  let projection
  try { projection = projectPreparedPublicIds(fixture.value) }
  catch (error) { fail(`prepared fixture has no canonical public-content authority: ${error.message}`) }
  return {
    articleId: Number(projection.articleId),
    categoryId: Number(projection.categoryId),
    tagId: Number(projection.tagId),
    articleTitle: projection.articleTitle,
    searchKeyword: projection.searchKeyword,
    projectionDigest: projection.projectionDigest,
    prepareStateDigest: fixture.ref.contentDigest
  }
}

export function selectedHeaders(headers)
{
  const names = [
    'cache-control', 'content-type', 'etag', 'vary', 'x-fsus-frame-encoding',
    'x-fsus-frame-version', 'x-fsus-generation', 'x-fsus-hotread-artifact',
    'x-fsus-hotread-key', 'x-fsus-hotread-version', 'x-fsus-public-aot-state',
    'x-fsus-release-derived', 'x-fsus-release-id', 'x-fsus-release-slot'
  ]
  return Object.fromEntries(names.map((name) => [name, headers.get(name)])
    .filter(([, value]) => value != null))
}

export async function directAeds(requestPath, init = {})
{
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...init,
    headers: { Accept: 'application/octet-stream', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs)
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  let payload = null
  let decodeError = null
  if (bytes.byteLength > 0)
  {
    try { payload = decodeKnownFrame(bytes) }
    catch (error) { decodeError = error instanceof Error ? error.message : String(error) }
  }
  return {
    requestObservation: {
      method: init.method ?? 'GET',
      url: response.url,
      accept: new Headers(init.headers).get('accept') ?? 'application/octet-stream',
      ifNoneMatch: new Headers(init.headers).get('if-none-match'),
      deviceFingerprintDigest: new Headers(init.headers).has('x-fsus-device-fp')
        ? sha(new Headers(init.headers).get('x-fsus-device-fp')) : null
    },
    status: response.status,
    headers: selectedHeaders(response.headers),
    bodyDigest: sha(bytes),
    byteLength: bytes.byteLength,
    payload,
    decodeError
  }
}

export async function psqlJson(sql)
{
  if (!pgContainer) fail('probe requires FSUSBLOG_PG_CONTAINER')
  const result = await execFileAsync('docker', [
    'exec', '-i', pgContainer, 'psql', '-U', pgUser, '-d', pgDatabase,
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql
  ], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  const text = result.stdout.trim()
  if (!text) fail('database observation returned no row')
  return JSON.parse(text)
}

export async function redis(command)
{
  if (!redisContainer) fail('probe requires FSUSBLOG_REDIS_CONTAINER')
  const result = await execFileAsync(
    'docker',
    ['exec', redisContainer, 'redis-cli', '--raw', ...command],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }
  )
  return result.stdout.trim()
}

export async function eventually(label, operation)
{
  const deadline = Date.now() + timeoutMs
  let lastError
  do
  {
    try { return await operation() }
    catch (error)
    {
      lastError = error
      await sleep(500)
    }
  } while (Date.now() < deadline)
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}
