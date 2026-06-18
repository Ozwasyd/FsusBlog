import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public hydration invariant guards', () => {
  const articleDetail = readRepoFile('src/frontend/src/views/ArticleDetail.vue')
  const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')
  const themeRuntime = readRepoFile('src/frontend/src/services/themeRuntime.ts')
  const themeModeToggle = readRepoFile('src/frontend/src/components/ui/ThemeModeToggle.vue')
  const clientHydrate = readRepoFile('src/frontend/src/public-renderers/clientHydrate.ts')
  const homeView = readRepoFile('src/frontend/src/views/Home.vue')
  const homeSpotlight = readRepoFile('src/frontend/src/view-contracts/homeSpotlight.ts')
  const hydrationSmoke = readRepoFile('tests/frontend/checks/public/public-hydration-smoke.mjs')
  const refreshHydrationCheck = readRepoFile('tests/frontend/checks/public/check-public-refresh-hydration.mjs')
  const clockHydrationCheck = readRepoFile('tests/frontend/checks/public/check-public-clock-hydration-matrix.mjs')
  const browserEnvHydrationCheck = readRepoFile('tests/frontend/checks/public/check-public-browser-env-hydration-matrix.mjs')
  const payloadFixtureHydrationCheck = readRepoFile('tests/frontend/checks/public/check-public-payload-fixture-matrix.mjs')
  const domDiffHydrationCheck = readRepoFile('tests/frontend/checks/public/check-public-dom-diff-hydration.mjs')
  const hydrationMatrixGovernanceCheck = readRepoFile('tests/frontend/checks/public/check-public-hydration-matrix-governance.mjs')
  const hydrationMatrixRegistry = readRepoFile('tests/frontend/checks/public/public-hydration-matrix.registry.json')

  it('keeps the public hydration checker fatal for Vue hydration warnings', () => {
    expect(refreshHydrationCheck).toContain('HYDRATION_KEYWORDS')
    expect(refreshHydrationCheck).toContain("page.on('console'")
    expect(refreshHydrationCheck).toContain("type === 'warn' || type === 'warning' || type === 'error'")
    expect(refreshHydrationCheck).toContain('isHydrationIssue(text)')
    expect(refreshHydrationCheck).toContain('fsusblog.public-hydration-detector.v1')
    expect(refreshHydrationCheck).toContain('runDetectorCanary')
    expect(refreshHydrationCheck).toContain('writeSummary')
    expect(refreshHydrationCheck).toContain('fatalHydrationIssueCount')
    expect(refreshHydrationCheck).toContain('isFatalHydrationIssue')
    expect(refreshHydrationCheck).not.toContain('PASS${warnSuffix}')
  })

  it('keeps public hydration smoke sidecar-primary with inline fallback evidence', () => {
    expect(hydrationSmoke).toContain('fsusblog.public-hydration-sidecar-smoke.v1')
    expect(hydrationSmoke).toContain('public-hydration-sidecar-summary.json')
    expect(hydrationSmoke).toContain('readHydrationPayload')
    expect(hydrationSmoke).toContain('sidecar-primary')
    expect(hydrationSmoke).toContain('inline-fallback')
    expect(hydrationSmoke).toContain('application/vnd.fsus.aeds')
    expect(hydrationSmoke).toContain('max-age=31536000')
    expect(hydrationSmoke).toContain('assertMissingSidecarFailureVisible')
    expect(hydrationSmoke).toContain('missing public hydration sidecar')
    expect(hydrationSmoke).toContain("toString('base64url')")
  })

  it('keeps public hydration smoke settle window aligned with cold AOT workers', () => {
    expect(hydrationSmoke).toContain(
      "const aotSettleTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_PUBLIC_AOT_SETTLE_TIMEOUT_MS, 30000)"
    )
  })

  it('keeps the public hydration matrix tied to manifest route kinds and phase cells', () => {
    expect(refreshHydrationCheck).toContain('PUBLIC_PAGE_MANIFEST_FILE')
    expect(refreshHydrationCheck).toContain('assertScenarioCoverageAgainstPublicPageManifest')
    expect(refreshHydrationCheck).toContain('fsusblog.public-hydration-route-phase-matrix.v1')
    for (const route of ['/privacy', '/guidelines', '/copyright', '/search?q=hydration', '/category/0', '/tag/0', '/article/0']) {
      expect(refreshHydrationCheck).toContain(route)
    }
    for (const phase of ['direct-first-load', 'reload', 'atomic-navigation', 'browser-back-forward', 'hash-navigation', 'full-spa-takeover', 'non-aot-search-fallback']) {
      expect(refreshHydrationCheck).toContain(phase)
    }
    for (const assertion of ['single-app-root', 'hydration-metrics-route-key', 'aot-head-nodes-unique', 'no-stale-public-hydration-payload']) {
      expect(refreshHydrationCheck).toContain(assertion)
    }
    expect(refreshHydrationCheck).toContain('phaseResults')
  })

  it('keeps invalid article fallback from depending on networkidle', () => {
    expect(refreshHydrationCheck).toContain("name: 'invalid-article-aot-fallback'")
    expect(refreshHydrationCheck).toContain("directWaitUntil: 'domcontentloaded'")
    expect(refreshHydrationCheck).toContain("route.directWaitUntil || 'networkidle'")
  })

  it('keeps public hydration clock, timezone, and locale drift covered', () => {
    expect(clockHydrationCheck).toContain('fsusblog.public-hydration-clock-matrix.v1')
    expect(clockHydrationCheck).toContain('CLOCK_CASES')
    expect(clockHydrationCheck).toContain('near-midnight-plus-fifteen-minutes')
    expect(clockHydrationCheck).toContain('ARTICLE_TIMESTAMPS')
    expect(clockHydrationCheck).toContain('installSsrDomGlobals')
    expect(clockHydrationCheck).toContain('timezoneId')
    expect(clockHydrationCheck).toContain('locale')
    expect(clockHydrationCheck).toContain('addInitScript')
    expect(clockHydrationCheck).toContain('freezeClockScript')
    expect(clockHydrationCheck).toContain('renderTimestamp')
    expect(clockHydrationCheck).toContain('renderTimeZone')
    expect(clockHydrationCheck).toContain('detailView.header.meta.fullTime')
    expect(clockHydrationCheck).toContain('relatedTimes')
    expect(clockHydrationCheck).toContain('timeNodes')
    expect(clockHydrationCheck).toContain('public-hydration-clock-matrix-summary.json')
  })

  it('keeps public hydration browser state and media environment drift covered', () => {
    expect(browserEnvHydrationCheck).toContain('fsusblog.public-hydration-browser-env-matrix.v1')
    expect(browserEnvHydrationCheck).toContain('ENVIRONMENT_CELLS')
    for (const dimension of ['themePreference', 'sessionState', 'storageBehavior', 'motionPreference', 'colorScheme', 'viewport']) {
      expect(browserEnvHydrationCheck).toContain(dimension)
    }
    expect(browserEnvHydrationCheck).toContain('encodeCurrentUserSnapshotFrame')
    expect(browserEnvHydrationCheck).toContain('reducedMotion')
    expect(browserEnvHydrationCheck).toContain('colorScheme: cell.colorScheme')
    expect(browserEnvHydrationCheck).toContain('auth-gated-until-after-hydration')
    expect(browserEnvHydrationCheck).toContain('storage-cleared-after-reload')
    expect(browserEnvHydrationCheck).toContain('public-hydration-browser-env-summary.json')
  })

  it('keeps public hydration payload boundary and rich-content fixtures covered', () => {
    expect(payloadFixtureHydrationCheck).toContain('fsusblog.public-hydration-payload-fixture-matrix.v1')
    expect(payloadFixtureHydrationCheck).toContain('PUBLIC_PAYLOAD_FIXTURES')
    for (const dimension of ['article-list:empty', 'home-secondary:boundary-ordering', 'article-body:code-blocks', 'filter:tag-by-name', 'archive:large', 'footer:complete', 'payload:duplicate-scalars-absent']) {
      expect(payloadFixtureHydrationCheck).toContain(dimension)
    }
    expect(payloadFixtureHydrationCheck).toContain('rich article body keeps wrapper, role, class contract')
    expect(payloadFixtureHydrationCheck).toContain('optional arrays missing')
    expect(payloadFixtureHydrationCheck).toContain('head/title metadata')
    expect(payloadFixtureHydrationCheck).toContain('coverage.missingDimensions')
    expect(payloadFixtureHydrationCheck).toContain('public-hydration-payload-fixture-summary.json')
  })

  it('keeps public hydration normalized SSR-vs-CSR DOM diff coverage active', () => {
    expect(domDiffHydrationCheck).toContain('fsusblog.public-hydration-dom-diff.v1')
    expect(domDiffHydrationCheck).toContain('renderPublicHydrationSnapshot')
    expect(domDiffHydrationCheck).toContain('normalizeDomNode')
    expect(domDiffHydrationCheck).toContain('compareNormalizedTrees')
    expect(domDiffHydrationCheck).toContain('runTextMismatchCanary')
    for (const token of ['id', 'class', 'href', 'src', 'alt', 'title', 'datetime', 'role', 'aria-', 'data-public-', 'data-aot-action']) {
      expect(domDiffHydrationCheck).toContain(token)
    }
    expect(domDiffHydrationCheck).toContain('runtime-only islands are allowlisted explicitly')
    expect(domDiffHydrationCheck).toContain('public-hydration-dom-diff-summary.json')
  })

  it('keeps public hydration matrix governance tied to lanes and release evidence', () => {
    expect(hydrationMatrixGovernanceCheck).toContain('fsusblog.public-hydration-matrix-summary.v1')
    expect(hydrationMatrixGovernanceCheck).toContain('fsusblog.public-hydration-matrix-registry.v1')
    expect(hydrationMatrixGovernanceCheck).toContain('public-hydration-matrix.registry.json')
    expect(hydrationMatrixGovernanceCheck).toContain('AOT public page kind coverage drift')
    expect(hydrationMatrixGovernanceCheck).toContain('FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS')
    for (const field of ['gitSha', 'rendererVersion', 'route', 'pageKind', 'phase', 'browser', 'viewport', 'state', 'clock', 'fixtureId', 'fatalHydrationIssueCount', 'durationMs']) {
      expect(hydrationMatrixGovernanceCheck).toContain(field)
    }
    for (const lane of ['"id": "fast"', '"id": "release"', '"id": "nightly-full"']) {
      expect(hydrationMatrixRegistry).toContain(lane)
    }
    expect(hydrationMatrixRegistry).toContain('"shardStrategies"')
    expect(hydrationMatrixRegistry).toContain('"requiredArtifacts": ["detector", "clock", "browserEnv", "payloadFixture", "domDiff"]')
    expect(hydrationMatrixRegistry).toContain('"costClass": "PR"')
    expect(hydrationMatrixRegistry).toContain('"costClass": "release"')
    expect(hydrationMatrixRegistry).toContain('"costClass": "nightly"')
  })

  it('keeps ArticleDetail runtime widgets out of SSR and initial hydration DOM', () => {
    expect(articleDetail).toContain('const canRenderBodyRuntime = ref(false)')
    expect(articleDetail).toContain('Hydration invariant: runtime-only article widgets stay out of SSR')
    expect(articleDetail).toContain('void nextTick(() =>')
    expect(articleDetail).toContain('canRenderBodyRuntime.value = true')
    expect(articleDetail).toContain('<template v-if="canRenderBodyRuntime" #header-actions>')
    expect(articleDetail).toContain('<template v-if="canRenderBodyRuntime" #body>')
    expect(articleDetail).toContain('<ArticleTocPanel\n      v-if="canRenderBodyRuntime"')
    expect(articleDetail).toContain('<ArticleImageLightbox\n      v-if="canRenderBodyRuntime"')
    expect(articleDetail).not.toContain('<ArticleMobileActionBar')
  })

  it('documents and preserves public shell runtime gates', () => {
    expect(blogLayout).toContain('Hydration invariant: runtime shell state remains SSR-compatible')
    expect(blogLayout).toContain('setTimeout(() =>')
    expect(blogLayout).toContain('showRuntime: isMounted.value && runtimeReady.value')
    expect(blogLayout).toContain('spaSearch: isMounted.value && runtimeReady.value')
    expect(blogLayout).toContain('isRuntimeAuthResolved: isMounted.value && runtimeReady.value')
  })

  it('keeps theme preference reconciliation after public AOT hydration', () => {
    expect(themeRuntime).toContain('Hydration invariant: public AOT starts from DOM-safe system mode')
    expect(themeRuntime.indexOf('if (isHydratingPublicAotShell())')).toBeLessThan(themeRuntime.indexOf('return readDomThemeMode()'))
    expect(themeModeToggle).toContain('onMounted(() =>')
    expect(themeModeToggle).toContain('reconcileThemeRuntimeAfterHydration()')
  })

  it('protects whitespace normalization and home secondary layout determinism', () => {
    expect(clientHydrate).toContain('Hydration invariant: strip whitespace-only SSR text nodes')
    expect(clientHydrate.indexOf('removeWhitespaceTextNodes(container)')).toBeLessThan(clientHydrate.indexOf('app.mount(container, true)'))
    expect(homeView).toContain('Hydration invariant: secondary home layout uses the same pure selector')
    expect(homeSpotlight).toContain("export type HomeSecondaryLayout = 'loading' | 'spotlight' | 'text-first' | 'none'")
    expect(homeSpotlight).toContain('selectHomeSpotlightCandidates')
    expect(homeSpotlight).toContain('resolveHomeSecondaryLayout')
  })

  it('keeps removed mobile action bar out of the hydration surface', () => {
    expect(articleDetail).not.toContain('ArticleMobileActionBar')
    expect(articleDetail).not.toContain('data-mobile-reading-actions')
  })
})
