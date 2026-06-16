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
  const documentService = read('src/backend/Infrastructure/PublicAot/PublicAotDocumentService.cs')
  const webApplicationComposition = read('src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs')
  const apiContracts = read('src/frontend/src/api/contracts.ts')
  const publicShell = read('src/frontend/src/bootstrap/publicShell.ts')
  const hydrationBootstrap = read('src/frontend/src/bootstrap/publicHydrationBootstrap.ts')
  const binaryPayload = read('src/frontend/src/bootstrap/publicAotBinaryPayload.ts')
  const refreshHydrationCheck = read('tests/frontend/checks/public/check-public-refresh-hydration.mjs')
  const clockHydrationCheck = read('tests/frontend/checks/public/check-public-clock-hydration-matrix.mjs')
  const browserEnvHydrationCheck = read('tests/frontend/checks/public/check-public-browser-env-hydration-matrix.mjs')
  const releaseLane = read('tools/test/legacy-test.sh')
  const testMatrix = read('tests/matrix.yml')
  const releaseEvidenceCollector = read('tools/operations/collect-release-evidence.sh')
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
  for (const token of ['BuildBinaryPayloadSidecarMarker', 'data-aeds-src', 'BuildPayloadSidecarUrl']) {
    if (!documentComposer.includes(token)) {
      fail(`document composer missing hydration sidecar token: ${token}`)
    }
  }
  if (!documentService.includes('WriteHydrationPayloadSidecarAsync') || !documentService.includes('DecodePayloadFrameBytes')) {
    fail('document service must write hydration payload sidecars as raw AEDS frames')
  }
  for (const token of ['PublicAotHydrationSidecarMediaType', 'application/vnd.fsus.aeds', '/aot-cache/payloads/', 'ImmutableStaticAssetCacheControl']) {
    if (!webApplicationComposition.includes(token)) {
      fail(`static asset pipeline missing public AOT sidecar serving token: ${token}`)
    }
  }
  if (!publicShell.includes("querySelectorAll('[data-fsus-aot-head]')")) {
    fail('public shell micro-navigation must replace all Public AOT-managed head nodes')
  }
  if (!apiContracts.includes('PUBLIC_AOT_HYDRATION_MEDIA_TYPE') || !apiContracts.includes('application/vnd.fsus.aeds')) {
    fail('frontend API contracts must expose the public AOT hydration sidecar media type separately from runtime binary APIs')
  }
  for (const token of ['readBinarySidecarUrlById', 'readPublicHydrationPayloadFromUrl', 'replacePublicHydrationPayloadSnapshot']) {
    if (!publicShell.includes(token)) {
      fail(`public shell micro-navigation missing hydration sidecar token: ${token}`)
    }
  }
  for (const token of ['readPublicHydrationPayloadAsync', 'readPublicHydrationPayloadFromUrl', 'dataset.aedsSrc', 'PUBLIC_AOT_HYDRATION_MEDIA_TYPE']) {
    if (!hydrationBootstrap.includes(token)) {
      fail(`hydration bootstrap missing sidecar fetch token: ${token}`)
    }
  }
  if (!binaryPayload.includes('class BinaryWriter') || binaryPayload.includes('const payload: number[]') || !binaryPayload.includes("toString('base64url')") || !binaryPayload.includes('decodePublicAotPayloadBytes')) {
    fail('Public AOT payload encoder must use growable Uint8Array writer and Node base64url fast path')
  }
  for (const token of ['readHydrationRawPayload', 'data-aeds-src', 'arrayBuffer', "toString('base64url')"]) {
    if (!refreshHydrationCheck.includes(token)) {
      fail(`refresh hydration check missing sidecar payload token: ${token}`)
    }
  }
  for (const token of ['fsusblog.public-hydration-detector.v1', "type === 'warn' || type === 'warning' || type === 'error'", 'runDetectorCanary', 'writeSummary', 'fatalHydrationIssueCount', 'isFatalHydrationIssue']) {
    if (!refreshHydrationCheck.includes(token)) {
      fail(`refresh hydration check missing fatal detector token: ${token}`)
    }
  }
  for (const token of ['PUBLIC_PAGE_MANIFEST_FILE', 'assertScenarioCoverageAgainstPublicPageManifest', 'fsusblog.public-hydration-route-phase-matrix.v1', 'phaseResults', 'direct-first-load', 'browser-back-forward', 'hash-navigation', 'non-aot-search-fallback']) {
    if (!refreshHydrationCheck.includes(token)) {
      fail(`refresh hydration check missing route-phase matrix token: ${token}`)
    }
  }
  if (refreshHydrationCheck.includes('PASS${warnSuffix}')) {
    fail('refresh hydration check must not allow hydration warnings to pass with a warning suffix')
  }
  for (const token of [
    'fsusblog.public-hydration-clock-matrix.v1',
    'CLOCK_CASES',
    'near-midnight-plus-fifteen-minutes',
    'ARTICLE_TIMESTAMPS',
    'installSsrDomGlobals',
    'timezoneId',
    'locale',
    'addInitScript',
    'freezeClockScript',
    'renderTimestamp',
    'renderTimeZone',
    'detailView.header.meta.fullTime',
    'relatedTimes',
    'timeNodes',
    'public-hydration-clock-matrix-summary.json'
  ]) {
    if (!clockHydrationCheck.includes(token)) {
      fail(`clock hydration check missing deterministic matrix token: ${token}`)
    }
  }
  if (!releaseLane.includes('check-public-clock-hydration-matrix.mjs')) {
    fail('release lane must run the deterministic public hydration clock matrix')
  }
  for (const token of [
    'fsusblog.public-hydration-browser-env-matrix.v1',
    'ENVIRONMENT_CELLS',
    'themePreference',
    'sessionState',
    'storageBehavior',
    'motionPreference',
    'colorScheme',
    'viewport',
    'encodeCurrentUserSnapshotFrame',
    'reducedMotion',
    'colorScheme: cell.colorScheme',
    'auth-gated-until-after-hydration',
    'storage-cleared-after-reload',
    'public-hydration-browser-env-summary.json'
  ]) {
    if (!browserEnvHydrationCheck.includes(token)) {
      fail(`browser environment hydration check missing matrix token: ${token}`)
    }
  }
  for (const token of ['check-public-clock-hydration-matrix.mjs', 'check-public-browser-env-hydration-matrix.mjs']) {
    if (!releaseLane.includes(token)) {
      fail(`release lane missing public hydration matrix: ${token}`)
    }
  }
  for (const token of ['public-hydration-clock-matrix', 'public-hydration-clock-matrix-summary.json', 'public-hydration-browser-env-matrix', 'public-hydration-browser-env-summary.json']) {
    if (!testMatrix.includes(token)) {
      fail(`test matrix missing public hydration release evidence token: ${token}`)
    }
  }
  for (const token of [
    'PUBLIC_HYDRATION_CLOCK_MATRIX_SUMMARY',
    'PUBLIC_HYDRATION_CLOCK_MATRIX_STATUS_VALUE',
    'publicHydrationClockMatrixSummary',
    'publicHydrationClockMatrix',
    'PUBLIC_HYDRATION_BROWSER_ENV_SUMMARY',
    'PUBLIC_HYDRATION_BROWSER_ENV_STATUS_VALUE',
    'publicHydrationBrowserEnvSummary',
    'publicHydrationBrowserEnv'
  ]) {
    if (!releaseEvidenceCollector.includes(token)) {
      fail(`release evidence collector missing public hydration token: ${token}`)
    }
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
  const featuredArticle = {
    id: 1,
    title: 'Featured Article',
    coverImageUrl: '/fixtures/acceptance-cover-primary.svg',
    views: 42,
    createTime: '2026-06-15T19:32:24.1570000Z',
    category: { id: 1, name: 'Featured' }
  }
  const hotArticle = {
    id: 2,
    title: 'Hot Article',
    views: 18
  }
  const cases = [
    { kind: 'Home', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', pageIndex: 1, pageSize: 10, total: 1, articles: [], featuredArticles: [featuredArticle], hotArticles: [hotArticle] } },
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
