#!/usr/bin/env node

import { cp, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePublicAotConcurrency } from '../test/resolve-public-aot-concurrency.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568'
const waitMs = Number(process.env.FSUSBLOG_PUBLIC_AOT_WAIT_MS || 15000)
const timeoutMs = Number(
  process.env.FSUSBLOG_PUBLIC_AOT_FETCH_TIMEOUT_MS
  || process.env.FSUSBLOG_HTTP_TIMEOUT_MS
  || Math.min(Math.max(waitMs, 15000), 60000)
)
const manifestToken = process.env.FSUSBLOG_PUBLIC_AOT_MANIFEST_TOKEN || ''
const sidecarSourceDir = process.env.FSUSBLOG_PUBLIC_AOT_SIDECAR_SOURCE_DIR
  || join(repoRoot, 'src', 'backend', 'wwwroot', 'aot-cache', 'payloads')
const sidecarPreviewDistDir = process.env.FSUSBLOG_PUBLIC_AOT_SIDECAR_DIST_DIR
  || join(repoRoot, 'src', 'frontend', 'dist', 'aot-cache', 'payloads')

function parseArgs(argv) {
  const configuredConcurrency = process.env.FSUSBLOG_PUBLIC_AOT_CONCURRENCY
  const options = {
    scope: 'all',
    changedSince: '',
    concurrencyCap: configuredConcurrency === undefined || configuredConcurrency.trim() === ''
      ? null
      : parseConcurrency(configuredConcurrency, 'FSUSBLOG_PUBLIC_AOT_CONCURRENCY'),
    failFast: false,
    jsonReport: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--scope' && next) {
      options.scope = next
      index += 1
    } else if (arg.startsWith('--scope=')) {
      options.scope = arg.slice('--scope='.length)
    } else if (arg === '--changed-since' && next) {
      options.changedSince = next
      index += 1
    } else if (arg.startsWith('--changed-since=')) {
      options.changedSince = arg.slice('--changed-since='.length)
    } else if (arg === '--concurrency' && next) {
      options.concurrencyCap = parseConcurrency(next, '--concurrency')
      index += 1
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrencyCap = parseConcurrency(arg.slice('--concurrency='.length), '--concurrency')
    } else if (arg === '--fail-fast') {
      options.failFast = true
    } else if (arg === '--json-report') {
      options.jsonReport = true
    }
  }

  const dynamicConcurrency = resolvePublicAotConcurrency({
    env: process.env,
    workersPerCpu: 2,
    memoryPerWorkerGiB: 0.125
  })
  options.concurrency = Math.min(dynamicConcurrency, options.concurrencyCap ?? Number.POSITIVE_INFINITY)
  return options
}

function parseConcurrency(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function withTimeout(promise, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return {
    controller,
    promise: promise(controller.signal).finally(() => clearTimeout(timer))
  }
}

function buildManifestUrl(options) {
  const url = new URL('/internal/public-aot/manifest', baseUrl)
  url.searchParams.set('scope', options.changedSince ? 'changed' : options.scope)
  if (options.changedSince) {
    url.searchParams.set('changedSince', options.changedSince)
  }
  return url
}

async function fetchManifest(options) {
  const headers = { Accept: 'application/json' }
  if (manifestToken) {
    headers['X-Fsus-Public-Aot-Token'] = manifestToken
  }

  const { promise } = withTimeout((signal) => fetch(buildManifestUrl(options), {
    signal,
    headers
  }), timeoutMs)
  const response = await promise
  if (!response.ok) {
    throw new Error(`manifest => ${response.status}`)
  }

  const body = await response.json()
  const manifest = body?.data ?? body?.Data ?? body
  const routes = manifest?.routes ?? manifest?.Routes ?? []
  if (!Array.isArray(routes)) {
    throw new Error('manifest routes missing')
  }

  return routes
    .map((route) => ({
      pageId: route.pageId ?? route.PageId,
      kind: route.kind ?? route.Kind,
      routeKey: route.routeKey ?? route.RouteKey,
      path: route.path ?? route.Path,
      priority: Number(route.priority ?? route.Priority ?? 0)
    }))
    .filter((route) => typeof route.path === 'string' && route.path.startsWith('/'))
    .sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path))
}

async function fetchPublicAotHealth() {
  const headers = { Accept: 'application/json' }
  if (manifestToken) {
    headers['X-Fsus-Public-Aot-Token'] = manifestToken
  }

  const { promise } = withTimeout((signal) => fetch(new URL('/internal/public-aot/health', baseUrl), {
    signal,
    headers
  }), timeoutMs)
  const response = await promise
  if (!response.ok) {
    throw new Error(`health => ${response.status}`)
  }

  const body = await response.json()
  const report = body?.data ?? body?.Data ?? body
  const status = report?.status ?? report?.Status
  const probe = report?.sampleWorkerProbe ?? report?.SampleWorkerProbe
  const probeStatus = probe?.status ?? probe?.Status
  if (status !== 'ok' || probeStatus !== 'ok') {
    throw new Error(`health => ${status ?? 'unknown'}/${probeStatus ?? 'unknown'}`)
  }
}

async function waitForPublicAotHealth() {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < waitMs) {
    try {
      await fetchPublicAotHealth()
      console.log('[warm-public-aot] health=ok')
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  if (lastError) {
    throw lastError
  }

  throw new Error('health warmup deadline exceeded')
}

async function fetchHtml(path) {
  const { promise } = withTimeout((signal) => fetch(`${baseUrl}${path}`, {
    signal,
    headers: { Accept: 'text/html,application/xhtml+xml' }
  }), timeoutMs)
  const response = await promise
  const source = response.headers.get('X-Fsus-Public-Aot-Source') || 'unknown'
  if (!response.ok) {
    throw new Error(`${path} => ${response.status}`)
  }
  await response.text()
  return source
}

function isAotHitSource(source) {
  return source === 'server-ssr'
}

async function fetchHtmlUntil(path, deadlineMs) {
  let lastError = null
  while (Date.now() < deadlineMs) {
    try {
      return await fetchHtml(path)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  if (lastError) {
    throw lastError
  }

  throw new Error(`${path} warmup deadline exceeded`)
}

async function waitForAotHit(path) {
  const startedAt = Date.now()
  let lastSource = 'unknown'
  let lastError = null
  while (Date.now() - startedAt < waitMs) {
    try {
      lastSource = await fetchHtml(path)
      lastError = null
      if (isAotHitSource(lastSource)) {
        return lastSource
      }
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  if (lastError) {
    throw lastError
  }

  return lastSource
}

async function warmRoute(route) {
  const startedAt = Date.now()
  const first = await fetchHtmlUntil(route.path, Date.now() + waitMs)
  const firstResponseMs = Date.now() - startedAt
  const settled = await waitForAotHit(route.path)
  return {
    ...route,
    first,
    settled,
    ok: isAotHitSource(settled),
    firstResponseMs,
    settledMs: Date.now() - startedAt
  }
}

async function runPool(routes, concurrency, failFast) {
  const results = []
  let cursor = 0
  let failed = false

  async function worker() {
    while (cursor < routes.length && !(failFast && failed)) {
      const route = routes[cursor]
      cursor += 1
      try {
        const result = await warmRoute(route)
        results.push(result)
        console.log(`[warm-public-aot] ${route.path} first=${result.first} settled=${result.settled} firstMs=${result.firstResponseMs} settledMs=${result.settledMs}`)
        if (!result.ok) {
          failed = true
        }
      } catch (error) {
        failed = true
        const result = {
          ...route,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }
        results.push(result)
        console.error(`[warm-public-aot] ${route.path} failed=${result.error}`)
        if (failFast) {
          break
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, routes.length) }, () => worker()))
  return results.sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path))
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function syncHydrationSidecarsToPreviewDist() {
  if (process.env.FSUSBLOG_SYNC_PUBLIC_AOT_SIDECARS_TO_DIST === '0') {
    console.log('[warm-public-aot] skipped hydration sidecar dist sync')
    return
  }

  if (!(await pathExists(sidecarSourceDir))) {
    throw new Error(`hydration sidecar source missing: ${sidecarSourceDir}`)
  }

  await mkdir(sidecarPreviewDistDir, { recursive: true })
  await cp(sidecarSourceDir, sidecarPreviewDistDir, { recursive: true, force: true })
  console.log(`[warm-public-aot] synced hydration sidecars to preview dist: ${sidecarPreviewDistDir}`)
}

async function main() {
  const startedAt = Date.now()
  const options = parseArgs(process.argv.slice(2))
  const manifestStartedAt = Date.now()
  const routes = await fetchManifest(options)
  const manifestMs = Date.now() - manifestStartedAt
  if (routes.length === 0) {
    throw new Error('manifest returned no routes')
  }

  const healthStartedAt = Date.now()
  await waitForPublicAotHealth()
  const healthMs = Date.now() - healthStartedAt
  const warmStartedAt = Date.now()
  const results = await runPool(routes, options.concurrency, options.failFast)
  const warmMs = Date.now() - warmStartedAt
  const failed = results.filter((result) => !result.ok)
  const syncStartedAt = Date.now()
  if (failed.length === 0) {
    await syncHydrationSidecarsToPreviewDist()
  }
  const syncMs = Date.now() - syncStartedAt
  console.log(`[warm-public-aot-timing] ${JSON.stringify({
    routes: routes.length,
    concurrency: options.concurrency,
    manifestMs,
    healthMs,
    warmMs,
    syncMs,
    totalMs: Date.now() - startedAt,
    failed: failed.length
  })}`)
  if (options.jsonReport) {
    console.log(JSON.stringify({
      baseUrl,
      scope: options.changedSince ? 'changed' : options.scope,
      total: routes.length,
      warmed: results.length,
      failed: failed.length,
      routes: results
    }, null, 2))
  }

  if (failed.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`[warm-public-aot] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
