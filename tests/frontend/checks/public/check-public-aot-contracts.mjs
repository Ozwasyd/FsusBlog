#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const clientRoot = process.cwd()
const repoRoot = join(clientRoot, '..', '..')
const distServerRoot = join(clientRoot, 'dist', 'server')
const bundlePath = join(distServerRoot, 'public-ssr.mjs')
const bundleWorkerPath = join(distServerRoot, 'server-public-ssr.bundle.mjs')
const coreWorkerPath = join(distServerRoot, 'server-public-ssr.worker-core.mjs')

function fail(message) {
  console.error(`[public-aot-contracts] ${message}`)
  process.exit(1)
}

function read(relativePath) {
  const absolutePath = join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) {
    fail(`missing source file: ${relativePath}`)
  }
  return readFileSync(absolutePath, 'utf8')
}

function installSsrDomGlobals() {
  if (typeof globalThis.Element === 'undefined') {
    globalThis.Element = class Element {}
  }
  if (typeof globalThis.HTMLElement === 'undefined') {
    globalThis.HTMLElement = class HTMLElement extends globalThis.Element {}
  }
  if (typeof globalThis.SVGElement === 'undefined') {
    globalThis.SVGElement = class SVGElement extends globalThis.Element {}
  }
  if (typeof globalThis.ShadowRoot === 'undefined') {
    globalThis.ShadowRoot = class ShadowRoot extends globalThis.Element {}
  }
}

function assertStaticContracts() {
  const prodWorker = read('src/frontend/scripts/server-public-ssr.bundle.mjs')
  const devWorker = read('src/frontend/scripts/server-public-ssr.vite.mjs')
  const renderer = read('src/backend/Infrastructure/PublicAot/PublicAotNodeSsrRenderer.cs')
  const renderPublicPage = read('src/frontend/src/public-renderers/renderPublicPage.ts')
  const buildScript = read('tools/frontend/build.mjs')
  const warmScript = read('tools/frontend/warm-public-aot-cache.mjs')
  const indexHtml = read('src/frontend/index.html')
  const documentComposer = read('src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs')
  const publicShell = read('src/frontend/src/bootstrap/publicShell.ts')
  const binaryPayload = read('src/frontend/src/bootstrap/publicAotBinaryPayload.ts')
  const shellService = read('src/backend/Infrastructure/PublicAot/PublicAotShellService.cs')
  const fileCache = read('src/backend/Infrastructure/PublicAot/PublicAotFileShellCache.cs')

  if (prodWorker.includes("from 'vite'") || prodWorker.includes('createServer') || prodWorker.includes('ssrLoadModule')) {
    fail('production bundle worker must not import or create Vite runtime')
  }
  for (const token of ['createServer', 'ssrLoadModule']) {
    if (!devWorker.includes(token)) {
      fail(`development Vite worker missing ${token}`)
    }
  }
  for (const token of ['server-public-ssr.bundle.mjs', 'server-public-ssr.vite.mjs', 'public_aot_production_worker_must_use_prebuilt_bundle']) {
    if (!renderer.includes(token)) {
      fail(`backend renderer missing production/development worker token: ${token}`)
    }
  }
  for (const token of ['encodePublicAotPayload', 'decodePublicAotPayload', 'buildPublicEntry', 'PUBLIC_RENDERER_VERSION']) {
    if (!renderPublicPage.includes(token)) {
      fail(`SSR bundle entry must export ${token}`)
    }
  }
  if (!buildScript.includes('vite-public-ssr-build') || !buildScript.includes("'server'")) {
    fail('frontend release build must build and sync dist/server')
  }
  for (const token of ['/internal/public-aot/manifest', '--concurrency', '--json-report', '--fail-fast']) {
    if (!warmScript.includes(token)) {
      fail(`warm script must consume route manifest and expose bounded warm controls: ${token}`)
    }
  }
  if (warmScript.includes('/article/1') || warmScript.includes('publicPaths')) {
    fail('warm script must not hard-code public route guesses')
  }
  for (const token of ['<!--fsus:aot:head-start-->', '<!--fsus:aot:head-end-->', '<!--fsus:aot:app-->', '<!--fsus:aot:payloads-->', '<!--fsus:aot:spa-boot-->']) {
    if (!indexHtml.includes(token)) {
      fail(`index.html missing Public AOT sentinel: ${token}`)
    }
    if (!documentComposer.includes(token)) {
      fail(`document composer missing Public AOT sentinel contract: ${token}`)
    }
  }
  if (!documentComposer.includes('data-fsus-aot-head')) {
    fail('document composer must mark all Public AOT-managed head nodes')
  }
  if (!publicShell.includes("querySelectorAll('[data-fsus-aot-head]')")) {
    fail('public shell micro-navigation must replace all Public AOT-managed head nodes')
  }
  if (!binaryPayload.includes('class BinaryWriter') || binaryPayload.includes('const payload: number[]') || !binaryPayload.includes("toString('base64url')")) {
    fail('Public AOT payload encoder must use growable Uint8Array writer and Node base64url fast path')
  }
  for (const token of ['PublicAotStateContextKey', 'IsStaleCompatibleCacheEntry', 'stale-refresh-queued']) {
    if (!shellService.includes(token)) {
      fail(`Public AOT shell service missing SWR state token: ${token}`)
    }
  }
  for (const token of ['frontend', 'ResolveVersionedEntryPathForTests', 'public_aot_cache_stale_compatible']) {
    if (!fileCache.includes(token)) {
      fail(`Public AOT file cache missing artifact versioning token: ${token}`)
    }
  }
}

async function importBundle() {
  for (const file of [bundlePath, bundleWorkerPath, coreWorkerPath]) {
    if (!existsSync(file)) {
      fail(`missing built public SSR artifact: ${file}`)
    }
  }

  installSsrDomGlobals()
  const bundle = await import(pathToFileURL(bundlePath).href)
  for (const [name, type] of [
    ['buildPublicEntry', 'function'],
    ['encodePublicAotPayload', 'function'],
    ['decodePublicAotPayload', 'function'],
    ['PUBLIC_RENDERER_VERSION', 'string']
  ]) {
    if (typeof bundle[name] !== type) {
      fail(`built public SSR bundle has invalid export: ${name}`)
    }
  }

  return bundle
}

function sendWorkerRequest(bundle, pageKind, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundleWorkerPath], {
      cwd: distServerRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`bundle worker exited with ${signal ?? code}: ${stderr}`))
        return
      }

      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
      const separator = line.indexOf('\t')
      const encoded = separator >= 0 ? line.slice(separator + 1) : line
      const response = bundle.decodePublicAotPayload(encoded)
      if (!response?.ok || !response.entry?.html) {
        reject(new Error(`bundle worker returned invalid response for ${pageKind}: ${stdout}`))
        return
      }

      resolve(response.entry)
    })

    const requestPayload = bundle.encodePublicAotPayload({ pageKind, options })
    child.stdin.end(`smoke-${pageKind}\tbuildEntry\t${requestPayload}\n`)
  })
}

async function assertBundleWorkerSmoke(bundle) {
  const cases = [
    { kind: 'Home', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', pageIndex: 1, pageSize: 10, total: 0, articles: [], featuredArticles: [], hotArticles: [] } },
    { kind: 'About', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', content: 'About content' } },
    { kind: 'Archive', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', total: 0, articles: [] } },
    { kind: 'ArticleDetail', options: { id: 1, title: 'Article', bodyContent: '# Heading\n\nContent', summary: 'Summary', siteTitle: 'FsusBlog', siteDescription: 'desc' } },
    { kind: 'Filter', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', routeKey: 'search', title: 'Search', filter: { filterType: 'search', filterKey: 'search', filterId: 0, filterName: '', isInvalidTarget: false, pageIndex: 1, pageSize: 10, total: 0, articles: [] } } }
  ]

  for (const { kind, options } of cases) {
    const entry = await sendWorkerRequest(bundle, kind, options)
    if (!entry.rendererVersion || entry.rendererVersion !== bundle.PUBLIC_RENDERER_VERSION) {
      fail(`bundle worker rendererVersion mismatch for ${kind}`)
    }
    if (!entry.html.includes('fsus-aot-shell')) {
      fail(`bundle worker HTML missing public shell root for ${kind}`)
    }
  }
}

async function main() {
  assertStaticContracts()
  const bundle = await importBundle()
  await assertBundleWorkerSmoke(bundle)
  console.log('[public-aot-contracts] ok')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
