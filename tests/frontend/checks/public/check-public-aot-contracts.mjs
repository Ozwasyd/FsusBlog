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
  const viteConfig = read('src/frontend/vite.config.ts')
  const indexHtml = read('src/frontend/index.html')
  const documentComposer = read('src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs')
  const documentService = read('src/backend/Infrastructure/PublicAot/PublicAotDocumentService.cs')
  const webApplicationComposition = read('src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs')
  const apiContracts = read('src/frontend/src/api/contracts.ts')
  const publicShell = read('src/frontend/src/bootstrap/publicShell.ts')
  const hydrationBootstrap = read('src/frontend/src/bootstrap/publicHydrationBootstrap.ts')
  const binaryPayload = read('src/frontend/src/bootstrap/publicAotBinaryPayload.ts')
  const aotCacheResilienceCheck = read('tests/frontend/checks/public/check-aot-cache-resilience.mjs')
  const hydrationSmoke = read('tests/frontend/checks/public/public-hydration-smoke.mjs')
  const refreshHydrationCheck = read('tests/frontend/checks/public/check-public-refresh-hydration.mjs')
  const clockHydrationCheck = read('tests/frontend/checks/public/check-public-clock-hydration-matrix.mjs')
  const browserEnvHydrationCheck = read('tests/frontend/checks/public/check-public-browser-env-hydration-matrix.mjs')
  const payloadFixtureHydrationCheck = read('tests/frontend/checks/public/check-public-payload-fixture-matrix.mjs')
  const domDiffHydrationCheck = read('tests/frontend/checks/public/check-public-dom-diff-hydration.mjs')
  const hydrationMatrixGovernanceCheck = read('tests/frontend/checks/public/check-public-hydration-matrix-governance.mjs')
  const hydrationMatrixRegistry = read('tests/frontend/checks/public/public-hydration-matrix.registry.json')
  const releaseLane = read('tools/test/legacy-test.sh')
  const testMatrix = read('tests/matrix.yml')
  const qualityGateWorkflow = read('.github/workflows/quality-gate.yml')
  const releaseEvidenceCollector = read('tools/operations/collect-release-evidence.sh')
  const shellService = read('src/backend/Infrastructure/PublicAot/PublicAotShellService.cs')
  const fileCache = read('src/backend/Infrastructure/PublicAot/PublicAotFileShellCache.cs')
  const runtimeState = read('src/backend/Infrastructure/PublicAot/PublicAotSsrRuntimeState.cs')
  const healthService = read('src/backend/Infrastructure/PublicAot/PublicAotSsrHealthService.cs')
  const publicAotEndpoints = read('src/backend/Modules/Endpoints/PublicAotEndpoints.cs')
  const runtimePublicAotServices = read('src/backend/Infrastructure/Bootstrap/RuntimePublicAotServiceCollectionExtensions.cs')
  const aedsOnlyAllowlist = read('tools/contracts/aeds-only-policy.allowlist.json')
  const publicAotHealthCommand = read('tools/operations/public-aot-health.mjs')
  const publicSeoSmoke = read('tests/frontend/checks/public/public-seo-smoke.mjs')

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
  for (const token of ['encodePublicAotPayload', 'decodePublicAotPayload', 'buildPublicEntry', 'PUBLIC_RENDERER_VERSION', 'renderPublicHydrationSnapshot', 'createPublicHydrationRootComponent', 'normalizePublicHydrationPayload']) {
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
  for (const token of ['syncHydrationSidecarsToPreviewDist', 'FSUSBLOG_SYNC_PUBLIC_AOT_SIDECARS_TO_DIST', 'aot-cache', 'payloads']) {
    if (!warmScript.includes(token)) {
      fail(`warm script must sync public AOT hydration sidecars into preview dist: ${token}`)
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
  for (const token of ['servePublicAotHydrationSidecars', 'application/vnd.fsus.aeds', 'public,max-age=31536000,immutable', 'aot-cache', 'payloads']) {
    if (!viteConfig.includes(token)) {
      fail(`Vite preview must serve public AOT hydration sidecars with release headers: ${token}`)
    }
  }
  if (!apiContracts.includes('PUBLIC_AOT_HYDRATION_MEDIA_TYPE') || !apiContracts.includes('application/vnd.fsus.aeds')) {
    fail('frontend API contracts must expose the public AOT hydration sidecar media type separately from runtime binary APIs')
  }
  for (const token of ['readBinarySidecarUrlById', 'readPublicHydrationPayloadFromUrl', 'replacePublicHydrationPayloadSnapshot']) {
    if (publicShell.includes(token)) {
      fail(`public shell navigation must not own hydration sidecar replacement after atomic takeover: ${token}`)
    }
  }
  for (const token of ['DOMParser', 'applyPublicNavigationDocument', 'replacePublicShellForNavigation']) {
    if (!publicShell.includes(token)) {
      continue
    }
    fail(`public shell must not include legacy HTML micro-router token: ${token}`)
  }
  for (const token of ['readPublicHydrationPayloadAsync', 'readPublicHydrationPayloadFromUrl', 'dataset.aedsSrc', 'PUBLIC_AOT_HYDRATION_MEDIA_TYPE']) {
    if (!hydrationBootstrap.includes(token)) {
      fail(`hydration bootstrap missing sidecar fetch token: ${token}`)
    }
  }
  if (!binaryPayload.includes('class BinaryWriter') || binaryPayload.includes('const payload: number[]') || !binaryPayload.includes("toString('base64url')") || !binaryPayload.includes('decodePublicAotPayloadBytes')) {
    fail('Public AOT payload encoder must use growable Uint8Array writer and Node base64url fast path')
  }
  for (const token of [
    'fsusblog.public-aot-cache-resilience.v1',
    'aot-cache-resilience-summary.json',
    'placeholderOnly: false',
    'fs.mkdtempSync',
    'fs.truncateSync',
    'fs.unlinkSync',
    'fs.writeFileSync',
    'sha256',
    'corrupt-document',
    'invalid-document-bytes',
    'missing-sidecar',
    'corrupt-sidecar',
    'old-asset-version',
    'html-payload-mismatch',
    'sw-stale-cache-poisoning',
    'network-recovered'
  ]) {
    if (!aotCacheResilienceCheck.includes(token)) {
      fail(`AOT cache resilience check missing destructive fixture token: ${token}`)
    }
  }
  for (const token of ['readHydrationRawPayload', 'data-aeds-src', 'arrayBuffer', "toString('base64url')"]) {
    if (!refreshHydrationCheck.includes(token)) {
      fail(`refresh hydration check missing sidecar payload token: ${token}`)
    }
  }
  for (const token of [
    'fsusblog.public-hydration-sidecar-smoke.v1',
    'public-hydration-sidecar-summary.json',
    'sidecar-primary',
    'inline-fallback',
    'readHydrationPayload',
    'data-aeds-src',
    'arrayBuffer',
    "toString('base64url')",
    'application/vnd.fsus.aeds',
    'max-age=31536000',
    'immutable',
    'assertMissingSidecarFailureVisible',
    'missing public hydration sidecar',
    'requiredSidecarKinds'
  ]) {
    if (!hydrationSmoke.includes(token)) {
      fail(`public hydration smoke missing sidecar-primary token: ${token}`)
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
  for (const token of [
    'routePolicies',
    'requiresUserState',
    'spa-public-search-fallback',
    'user-state-runtime-only',
    'must-not-write-public-aot-cache',
    'routePolicies missing ${routeName}',
    '"routeName": "Search"',
    '"routeName": "Account"'
  ]) {
    if (!hydrationMatrixRegistry.includes(token) && !hydrationMatrixGovernanceCheck.includes(token)) {
      fail(`public hydration matrix eligibility registry missing token: ${token}`)
    }
  }
  for (const token of [
    'PUBLIC_NON_AOT_ROUTE_POLICIES',
    'getPublicNonAotRoutePolicy',
    'PUBLIC_ROUTE_IDENTITY_TOKENS.publicSearchSpaFallback',
    'PUBLIC_PAGE_MANIFEST.Account.fallbackBehavior'
  ]) {
    if (!read('src/frontend/src/public-renderers/publicRouteRegistry.ts').includes(token)) {
      fail(`public route registry missing non-AOT eligibility token: ${token}`)
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
  for (const token of [
    'fsusblog.public-hydration-payload-fixture-matrix.v1',
    'PUBLIC_PAYLOAD_FIXTURES',
    'article-list:empty',
    'home-secondary:boundary-ordering',
    'article-body:code-blocks',
    'filter:tag-by-name',
    'archive:large',
    'footer:complete-config',
    'payload:duplicate-scalars-absent',
    'rich article body keeps wrapper, role, class contract',
    'optional arrays missing',
    'head/title metadata',
    'coverage.missingDimensions',
    'public-hydration-payload-fixture-summary.json'
  ]) {
    if (!payloadFixtureHydrationCheck.includes(token)) {
      fail(`payload fixture hydration check missing matrix token: ${token}`)
    }
  }
  for (const token of [
    'fsusblog.public-hydration-dom-diff.v1',
    'renderPublicHydrationSnapshot',
    'normalizeDomNode',
    'compareNormalizedTrees',
    'runTextMismatchCanary',
    'id',
    'class',
    'href',
    'src',
    'alt',
    'title',
    'datetime',
    'role',
    'aria-',
    'data-public-',
    'data-aot-action',
    'runtime-only islands are allowlisted explicitly',
    'public-hydration-dom-diff-summary.json'
  ]) {
    if (!domDiffHydrationCheck.includes(token)) {
      fail(`DOM diff hydration check missing matrix token: ${token}`)
    }
  }
  for (const token of [
    'fsusblog.public-hydration-matrix-summary.v1',
    'fsusblog.public-hydration-matrix-registry.v1',
    'public-hydration-matrix.registry.json',
    'PUBLIC_PAGE_MANIFEST',
    'AOT public page kind coverage drift',
    'FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS',
    'publicHydrationMatrix',
    'public-hydration-matrix-summary.json',
    'fatalHydrationIssueCount',
    'route',
    'phase',
    'browser',
    'state',
    'clock',
    'fixtureId'
  ]) {
    if (!hydrationMatrixGovernanceCheck.includes(token)) {
      fail(`hydration matrix governance check missing token: ${token}`)
    }
  }
  for (const token of [
    'fsusblog.public-hydration-matrix-registry.v1',
    '"id": "fast"',
    '"id": "release"',
    '"id": "nightly-full"',
    '"costClass": "PR"',
    '"costClass": "release"',
    '"costClass": "nightly"',
    '"shardStrategies"',
    '"route-phase-release"',
    '"browser-state-release"',
    '"full-cartesian-nightly"',
    '"requiredArtifacts": ["detector", "clock", "browserEnv", "payloadFixture", "domDiff"]'
  ]) {
    if (!hydrationMatrixRegistry.includes(token)) {
      fail(`hydration matrix registry missing token: ${token}`)
    }
  }
  for (const token of ['check-public-clock-hydration-matrix.mjs', 'check-public-browser-env-hydration-matrix.mjs', 'check-public-payload-fixture-matrix.mjs', 'check-public-dom-diff-hydration.mjs']) {
    if (!releaseLane.includes(token)) {
      fail(`release lane missing public hydration matrix: ${token}`)
    }
  }
  if (!releaseLane.includes('check-public-hydration-matrix-governance.mjs --lane release')) {
    fail('release lane missing public hydration matrix governance checker')
  }
  if (!releaseLane.includes('check:aot-cache-resilience')) {
    fail('resilience/release lane missing destructive AOT cache resilience check')
  }
  for (const token of ['public-hydration-clock-matrix', 'public-hydration-clock-matrix-summary.json', 'public-hydration-browser-env-matrix', 'public-hydration-browser-env-summary.json', 'public-hydration-payload-fixture-matrix', 'public-hydration-payload-fixture-summary.json', 'public-hydration-dom-diff', 'public-hydration-dom-diff-summary.json', 'public-hydration-sidecar', 'public-hydration-sidecar-summary.json', 'public-hydration-fast', 'public-hydration-nightly', 'public-hydration-matrix', 'public-hydration-matrix-summary.json']) {
    if (!testMatrix.includes(token)) {
      fail(`test matrix missing public hydration release evidence token: ${token}`)
    }
  }
  for (const token of ['public-aot-cache-resilience', 'aot-cache-resilience-summary.json']) {
    if (!testMatrix.includes(token)) {
      fail(`test matrix missing AOT cache resilience evidence token: ${token}`)
    }
  }
  if (!qualityGateWorkflow.includes('aot-cache-resilience-summary.json')) {
    fail('quality gate workflow missing AOT cache resilience artifact')
  }
  if (!qualityGateWorkflow.includes('public-hydration-payload-fixture-summary.json')) {
    fail('quality gate workflow missing public hydration payload fixture artifact')
  }
  if (!qualityGateWorkflow.includes('public-hydration-dom-diff-summary.json')) {
    fail('quality gate workflow missing public hydration DOM diff artifact')
  }
  if (!qualityGateWorkflow.includes('public-hydration-matrix-summary.json') || !qualityGateWorkflow.includes('./tools/test.sh public-hydration-fast --no-deps')) {
    fail('quality gate workflow missing public hydration matrix fast lane/artifact')
  }
  if (!qualityGateWorkflow.includes('public-hydration-sidecar-summary.json')) {
    fail('quality gate workflow missing public hydration sidecar artifact')
  }
  for (const token of [
    'PUBLIC_HYDRATION_CLOCK_MATRIX_SUMMARY',
    'PUBLIC_HYDRATION_CLOCK_MATRIX_STATUS_VALUE',
    'publicHydrationClockMatrixSummary',
    'publicHydrationClockMatrix',
    'PUBLIC_HYDRATION_BROWSER_ENV_SUMMARY',
    'PUBLIC_HYDRATION_BROWSER_ENV_STATUS_VALUE',
    'publicHydrationBrowserEnvSummary',
    'publicHydrationBrowserEnv',
    'PUBLIC_HYDRATION_PAYLOAD_FIXTURE_SUMMARY',
    'PUBLIC_HYDRATION_PAYLOAD_FIXTURE_STATUS_VALUE',
    'publicHydrationPayloadFixtureSummary',
    'publicHydrationPayloadFixture',
    'PUBLIC_HYDRATION_DOM_DIFF_SUMMARY',
    'PUBLIC_HYDRATION_DOM_DIFF_STATUS_VALUE',
    'publicHydrationDomDiffSummary',
    'publicHydrationDomDiff',
    'PUBLIC_HYDRATION_SIDECAR_SUMMARY',
    'PUBLIC_HYDRATION_SIDECAR_STATUS_VALUE',
    'publicHydrationSidecarSummary',
    'publicHydrationSidecar',
    'PUBLIC_HYDRATION_MATRIX_SUMMARY',
    'PUBLIC_HYDRATION_MATRIX_STATUS_VALUE',
    'publicHydrationMatrixSummary',
    'publicHydrationMatrix',
    'AOT_CACHE_RESILIENCE_SUMMARY',
    'AOT_CACHE_RESILIENCE_STATUS_VALUE',
    'aotCacheResilienceSummary',
    'publicAotCacheResilience'
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
  for (const token of ['frontend', 'ResolveVersionedEntryPathForTests', 'public_aot_cache_stale_compatible', 'public_aot_cache_sidecar_hash_mismatch']) {
    if (!fileCache.includes(token)) {
      fail(`Public AOT file cache missing artifact versioning token: ${token}`)
    }
  }
  for (const token of ['PublicAotSsrCircuitState', 'PublicAotSsrFailureClass', 'TryBeginBackfill', 'route-quarantined', 'half-open-probe', 'RecordBackfillFailure']) {
    if (!runtimeState.includes(token)) {
      fail(`Public AOT SSR runtime state missing breaker/quarantine token: ${token}`)
    }
  }
  for (const token of ['PublicAotSsrHealthReport', 'ProbeNodeAsync', 'validateBundle', 'CreateSnapshot']) {
    if (!healthService.includes(token)) {
      fail(`Public AOT SSR health service missing diagnostic token: ${token}`)
    }
  }
  for (const token of ['/internal/public-aot', '/health', 'PublicAotSsrHealthService', 'JsonApiResponse<PublicAotSsrHealthReport>', 'Cache-Control']) {
    if (!publicAotEndpoints.includes(token)) {
      fail(`Public AOT endpoint missing SSR health token: ${token}`)
    }
  }
  for (const token of ['PublicAotSsrRuntimeState', 'PublicAotSsrHealthService']) {
    if (!runtimePublicAotServices.includes(token)) {
      fail(`Public AOT runtime service registration missing token: ${token}`)
    }
  }
  for (const token of ['/internal/public-aot/health', 'JsonApiResponse<PublicAotSsrHealthReport>']) {
    if (!aedsOnlyAllowlist.includes(token)) {
      fail(`AEDS-only allowlist missing Public AOT health exemption token: ${token}`)
    }
  }
  for (const token of ['/internal/public-aot/health', 'X-Fsus-Public-Aot-Token', 'FSUSBLOG_PUBLIC_AOT_TOKEN']) {
    if (!publicAotHealthCommand.includes(token)) {
      fail(`Public AOT health command missing token: ${token}`)
    }
  }
  for (const token of [
    'assertDistributionCanonicalCoherence',
    '/sitemap.xml',
    '/feed/rss.xml',
    '/feed/atom.xml',
    '/feed/feed.json',
    'mainEntityOfPage',
    'datePublished',
    'dateModified',
    'BlogPosting',
    'canonical origin mismatch'
  ]) {
    if (!publicSeoSmoke.includes(token)) {
      fail(`public SEO smoke missing canonical/structured-data coherence token: ${token}`)
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
