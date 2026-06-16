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
  const mobileActionBar = readRepoFile('src/frontend/src/components/article/ArticleMobileActionBar.vue')
  const homeView = readRepoFile('src/frontend/src/views/Home.vue')
  const homeSpotlight = readRepoFile('src/frontend/src/view-contracts/homeSpotlight.ts')
  const refreshHydrationCheck = readRepoFile('tests/frontend/checks/public/check-public-refresh-hydration.mjs')
  const clockHydrationCheck = readRepoFile('tests/frontend/checks/public/check-public-clock-hydration-matrix.mjs')
  const browserEnvHydrationCheck = readRepoFile('tests/frontend/checks/public/check-public-browser-env-hydration-matrix.mjs')

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

  it('keeps the public hydration matrix tied to manifest route kinds and phase cells', () => {
    expect(refreshHydrationCheck).toContain('PUBLIC_PAGE_MANIFEST_FILE')
    expect(refreshHydrationCheck).toContain('assertScenarioCoverageAgainstPublicPageManifest')
    expect(refreshHydrationCheck).toContain('fsusblog.public-hydration-route-phase-matrix.v1')
    for (const route of ['/privacy', '/guidelines', '/copyright', '/search?q=hydration', '/category/0', '/tag/0', '/article/0']) {
      expect(refreshHydrationCheck).toContain(route)
    }
    for (const phase of ['direct-first-load', 'reload', 'micro-navigation', 'browser-back-forward', 'hash-navigation', 'full-spa-takeover', 'non-aot-search-fallback']) {
      expect(refreshHydrationCheck).toContain(phase)
    }
    for (const assertion of ['single-app-root', 'hydration-metrics-route-key', 'aot-head-nodes-unique', 'no-stale-public-hydration-payload']) {
      expect(refreshHydrationCheck).toContain(assertion)
    }
    expect(refreshHydrationCheck).toContain('phaseResults')
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

  it('keeps ArticleDetail runtime widgets out of SSR and initial hydration DOM', () => {
    expect(articleDetail).toContain('const canRenderBodyRuntime = ref(false)')
    expect(articleDetail).toContain('Hydration invariant: runtime-only article widgets stay out of SSR')
    expect(articleDetail).toContain('void nextTick(() =>')
    expect(articleDetail).toContain('canRenderBodyRuntime.value = true')
    expect(articleDetail).toContain('<template v-if="canRenderBodyRuntime" #header-actions>')
    expect(articleDetail).toContain('<template v-if="canRenderBodyRuntime" #body>')
    expect(articleDetail).toContain('<ArticleTocPanel\n      v-if="canRenderBodyRuntime"')
    expect(articleDetail).toContain('<ArticleImageLightbox\n      v-if="canRenderBodyRuntime"')
    expect(articleDetail).toContain('<ArticleMobileActionBar\n      v-if="canRenderBodyRuntime"')
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

  it('locally suppresses mobile action bar appear until FsusUI exposes a hydration-aware transition API', () => {
    expect(mobileActionBar).toContain('Hydration invariant: do not use Transition appear')
    expect(mobileActionBar).not.toContain('<FsuTransition :name="fsusBlogMotionPresets.mobileBar" appear')
    expect(mobileActionBar).not.toContain('<FsuTransition :name="fsusBlogMotionPresets.mobileBar" :appear="true"')
  })
})
