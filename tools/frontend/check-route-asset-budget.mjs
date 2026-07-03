#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const repoRoot = resolve(process.cwd(), '../..')
const manifestPath = resolve(repoRoot, process.env.FSUSBLOG_VITE_MANIFEST || 'src/frontend/dist/.vite/manifest.json')
const evidencePath = resolve(repoRoot, '.tmp/frontend/route-asset-budget.json')

const routeBudgets = {
  public: {
    firstEntryBytes: Number(process.env.FSUSBLOG_ROUTE_PUBLIC_BYTES || 360 * 1024),
    gzipBytes: Number(process.env.FSUSBLOG_ROUTE_PUBLIC_GZIP_BYTES || 125 * 1024),
    brotliBytes: Number(process.env.FSUSBLOG_ROUTE_PUBLIC_BROTLI_BYTES || 105 * 1024),
    asyncDependencyCount: Number(process.env.FSUSBLOG_ROUTE_PUBLIC_ASYNC_COUNT || 10)
  },
  admin: {
    firstEntryBytes: Number(process.env.FSUSBLOG_ROUTE_ADMIN_BYTES || 820 * 1024),
    gzipBytes: Number(process.env.FSUSBLOG_ROUTE_ADMIN_GZIP_BYTES || 260 * 1024),
    brotliBytes: Number(process.env.FSUSBLOG_ROUTE_ADMIN_BROTLI_BYTES || 220 * 1024),
    asyncDependencyCount: Number(process.env.FSUSBLOG_ROUTE_ADMIN_ASYNC_COUNT || 18)
  },
  heavy: {
    firstEntryBytes: Number(process.env.FSUSBLOG_ROUTE_HEAVY_BYTES || 1280 * 1024),
    gzipBytes: Number(process.env.FSUSBLOG_ROUTE_HEAVY_GZIP_BYTES || 420 * 1024),
    brotliBytes: Number(process.env.FSUSBLOG_ROUTE_HEAVY_BROTLI_BYTES || 360 * 1024),
    asyncDependencyCount: Number(process.env.FSUSBLOG_ROUTE_HEAVY_ASYNC_COUNT || 24)
  }
}

const routeEntries = [
  { route: 'public-shell', entry: 'src/bootstrap/publicShell.ts', className: 'public' },
  { route: 'admin-dashboard', entry: 'src/views/admin/Dashboard.vue', className: 'heavy' },
  { route: 'admin-article-editor', entry: 'src/views/admin/article/Write.vue', className: 'heavy' },
  { route: 'admin-ops', entry: '_route-admin-ops', className: 'admin' }
]

const forbiddenPublicImports = [
  /vendor-echarts/u,
  /route-admin/u,
  /markdown-runtime/u,
  /echartsRuntime/u
]

function fail(message) {
  console.error(`[check-route-asset-budget] ${message}`)
  process.exit(1)
}

function normalizeManifestEntry(value) {
  if (!value || typeof value !== 'object') return null
  return value
}

async function readAssetBytes(file) {
  return await readFile(resolve(repoRoot, 'src/frontend/dist', file))
}

function collectEntryFiles(manifest, entryKey, options = {}) {
  if (entryKey === 'index.html') return []
  const entry = normalizeManifestEntry(manifest[entryKey])
  if (!entry) return []

  const files = []
  if (entry.file) files.push(entry.file)
  for (const css of entry.css ?? []) files.push(css)
  for (const imported of entry.imports ?? []) {
    const importedEntry = normalizeManifestEntry(manifest[imported])
    if (importedEntry?.file) files.push(importedEntry.file)
    if (options.skipHostEntryCss && imported === 'index.html') {
      continue
    }
    for (const css of importedEntry?.css ?? []) files.push(css)
  }
  return [...new Set(files)]
}

function countAsyncDependencies(manifest, entryKey) {
  if (entryKey === 'index.html') return 0
  const entry = normalizeManifestEntry(manifest[entryKey])
  return entry?.dynamicImports?.length ?? 0
}

function resolveEntryKey(manifest, requested) {
  if (manifest[requested]) return requested
  const normalizedRequested = requested.replace(/^src\//u, '')
  if (manifest[normalizedRequested]) return normalizedRequested
  const match = Object.keys(manifest).find((key) => key.endsWith(requested) || key.includes(requested))
    ?? Object.keys(manifest).find((key) => key.endsWith(normalizedRequested) || key.includes(normalizedRequested))
  return match ?? null
}

if (!existsSync(manifestPath)) {
  fail(`manifest not found: ${manifestPath}`)
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const violations = []
const routes = []

for (const routeEntry of routeEntries) {
  const entryKey = resolveEntryKey(manifest, routeEntry.entry)
  if (!entryKey) {
    violations.push({ route: routeEntry.route, reason: 'entry_missing', entry: routeEntry.entry })
    continue
  }

  const files = collectEntryFiles(manifest, entryKey, {
    // publicShell is a dynamic AOT hydration entry. The SPA host entry's
    // aggregate stylesheet is measured separately by build/asset budgets and
    // is not part of the public shell runtime chunk itself.
    skipHostEntryCss: routeEntry.route === 'public-shell'
  })
  const buffers = await Promise.all(files.map(readAssetBytes))
  const firstEntryBytes = buffers.reduce((sum, bytes) => sum + bytes.byteLength, 0)
  const gzipBytes = buffers.reduce((sum, bytes) => sum + gzipSync(bytes).byteLength, 0)
  const brotliBytes = buffers.reduce((sum, bytes) => sum + brotliCompressSync(bytes).byteLength, 0)
  const asyncDependencyCount = countAsyncDependencies(manifest, entryKey)
  const budget = routeBudgets[routeEntry.className]
  const report = {
    route: routeEntry.route,
    className: routeEntry.className,
    entry: entryKey,
    files,
    firstEntryBytes,
    gzipBytes,
    brotliBytes,
    asyncDependencyCount,
    budget
  }
  routes.push(report)

  for (const key of ['firstEntryBytes', 'gzipBytes', 'brotliBytes', 'asyncDependencyCount']) {
    if (report[key] > budget[key]) {
      violations.push({ route: routeEntry.route, reason: `${key}_over_budget`, actual: report[key], budget: budget[key] })
    }
  }

  if (routeEntry.className === 'public') {
    const forbidden = files.filter((file) => forbiddenPublicImports.some((pattern) => pattern.test(file)))
    if (forbidden.length > 0) {
      violations.push({ route: routeEntry.route, reason: 'forbidden_public_imports', forbidden })
    }
  }
}

const summary = {
  status: violations.length === 0 ? 'ok' : 'blocked',
  generatedAt: new Date().toISOString(),
  manifestPath,
  routeBudgets,
  routes,
  violations
}

await mkdir(dirname(evidencePath), { recursive: true })
await writeFile(evidencePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

if (violations.length > 0) {
  fail(`blocked ${JSON.stringify(violations, null, 2)}`)
}

console.log(`[check-route-asset-budget] ok routes=${routes.length} evidence=${evidencePath}`)
