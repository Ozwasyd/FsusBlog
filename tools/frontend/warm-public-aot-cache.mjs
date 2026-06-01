#!/usr/bin/env node

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000'
const timeoutMs = Number(process.env.FSUSBLOG_HTTP_TIMEOUT_MS || 15000)
const waitMs = Number(process.env.FSUSBLOG_PUBLIC_AOT_WAIT_MS || 15000)
const manifestToken = process.env.FSUSBLOG_PUBLIC_AOT_MANIFEST_TOKEN || ''

function parseArgs(argv) {
  const options = {
    scope: 'all',
    changedSince: '',
    concurrency: 4,
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
      options.concurrency = Number(next)
      index += 1
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = Number(arg.slice('--concurrency='.length))
    } else if (arg === '--fail-fast') {
      options.failFast = true
    } else if (arg === '--json-report') {
      options.jsonReport = true
    }
  }

  options.concurrency = Math.max(1, Math.min(32, Number.isFinite(options.concurrency) ? Math.trunc(options.concurrency) : 4))
  return options
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

async function waitForAotHit(path) {
  const startedAt = Date.now()
  let lastSource = 'unknown'
  while (Date.now() - startedAt < waitMs) {
    lastSource = await fetchHtml(path)
    if (lastSource !== 'spa-fallback' && lastSource !== 'spa-index') {
      return lastSource
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return lastSource
}

async function warmRoute(route) {
  const first = await fetchHtml(route.path)
  const settled = await waitForAotHit(route.path)
  return {
    ...route,
    first,
    settled,
    ok: settled !== 'spa-fallback' && settled !== 'spa-index'
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
        console.log(`[warm-public-aot] ${route.path} first=${result.first} settled=${result.settled}`)
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

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const routes = await fetchManifest(options)
  if (routes.length === 0) {
    throw new Error('manifest returned no routes')
  }

  const results = await runPool(routes, options.concurrency, options.failFast)
  const failed = results.filter((result) => !result.ok)
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
