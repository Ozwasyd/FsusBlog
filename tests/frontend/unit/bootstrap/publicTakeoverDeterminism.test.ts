import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createPublicTakeoverSeed,
  normalizePublicComplianceConfig,
  normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity'
import { PUBLIC_SITE_IDENTITY_DEFAULTS } from '@/public-renderers/publicSiteIdentityDefaults'
import { PUBLIC_SHELL_DEFAULTS } from '@/public-renderers/publicShellState'
import {
  beginPublicTakeoverCommit,
  beginPublicTakeoverNavigation,
  beginPublicTakeoverPrewarm,
  canTransitionPublicTakeoverPhase,
  completePublicTakeoverCommit,
  completePublicTakeoverNavigation,
  getPublicRuntimeOwner,
  getPublicTakeoverPhase,
  markPublicTakeoverPrepared,
  resetPublicTakeover,
  transitionPublicTakeoverPhase
} from '@/bootstrap/publicTakeoverState'
import {
  abortPublicShellLifetime,
  getPublicShellLifetimeAbortCount,
  resetPublicShellLifetime
} from '@/bootstrap/publicShellLifetime'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public takeover site identity', () => {
  const indexHtml = readRepoFile('src/frontend/index.html')
  const publicShellPrimitives = readRepoFile('src/frontend/src/bootstrap/publicShellPrimitives.ts')
  const webManifest = JSON.parse(readRepoFile('src/frontend/public/manifest.webmanifest')) as {
    name: string
    short_name: string
    description: string
  }

  it('keeps frontend shell defaults aligned to the public site identity contract', () => {
    expect(PUBLIC_SHELL_DEFAULTS.siteTitle).toBe(PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle)
    expect(PUBLIC_SITE_IDENTITY_DEFAULTS.siteDescription).toBe('工程记录、性能实验、UI 系统与 FsusBlog 构建过程。')
    expect(PUBLIC_SITE_IDENTITY_DEFAULTS.siteKeywords).toBe('.NET, 前端性能, 系统设计, UI 系统, 技术博客, FsusBlog')
    expect(PUBLIC_SITE_IDENTITY_DEFAULTS.manifestName).toBe(PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle)
    expect(PUBLIC_SITE_IDENTITY_DEFAULTS.manifestShortName).toBe('FsusBlog')
  })

  it('keeps first-paint assets aligned to the public identity default', () => {
    expect(indexHtml).toContain(`<title>${PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle}</title>`)
    expect(indexHtml).toContain(`data-fsus-loader-title>${PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle}</span>`)
    expect(indexHtml).toContain(`data-fsus-loader-status>正在加载 ${PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle}</span>`)
    expect(indexHtml).not.toContain('>站点<')
    expect(indexHtml).not.toContain('正在加载站点')

    expect(webManifest.name).toBe(PUBLIC_SITE_IDENTITY_DEFAULTS.manifestName)
    expect(webManifest.short_name).toBe(PUBLIC_SITE_IDENTITY_DEFAULTS.manifestShortName)
    expect(webManifest.description).toBe(PUBLIC_SITE_IDENTITY_DEFAULTS.siteDescription)

    expect(publicShellPrimitives).toContain('PUBLIC_SITE_IDENTITY_DEFAULTS')
    expect(publicShellPrimitives).toContain('function readLoaderSiteIdentity')
    expect(publicShellPrimitives).toContain('createDefaultLoaderIdentity')
    expect(publicShellPrimitives).toContain('syncLoaderDocumentHead(identity)')
    expect(publicShellPrimitives).toContain('document.title = identity.siteTitle')
    expect(publicShellPrimitives).toContain("descriptionMeta.setAttribute('content', identity.siteDescription)")
    expect(publicShellPrimitives).toContain('statusEl.textContent = `正在加载 ${title}`')
  })

  it('normalizes site title and compliance through one shared contract', () => {
    expect(normalizePublicSiteTitle('  ')).toBe("Fsu's Blog")
    expect(normalizePublicSiteTitle('  Fsu Blog  ')).toBe('Fsu Blog')

    const compliance = normalizePublicComplianceConfig({
      enabled: true,
      regionMode: 'mainland-cn',
      copyrightOwner: ' Fsu ',
      copyrightStartYear: '2021',
      icpRecordNumber: ' ICP-1 ',
      policeRecordNumber: ' Police-1 '
    })

    expect(compliance).toMatchObject({
      enabled: true,
      regionMode: 'mainland-cn',
      copyrightOwner: 'Fsu',
      copyrightStartYear: 2021,
      icpRecordNumber: 'ICP-1',
      icpRecordUrl: 'https://beian.miit.gov.cn/',
      policeRecordNumber: 'Police-1',
      policeRecordUrl: 'https://beian.mps.gov.cn/'
    })
  })

  it('creates an immutable takeover seed from the public hydration payload', () => {
    const seed = createPublicTakeoverSeed({
      pageKind: 'Home',
      routeKey: 'home',
      rendererVersion: 'test',
      title: '',
      siteTitle: '',
      siteDescription: '  seeded description  ',
      siteLogoUrl: '/logo-light.svg',
      siteLogoDarkUrl: '/logo-dark.svg',
      siteWordmarkUrl: '/wordmark.svg',
      compliance: { enabled: true, copyrightOwner: ' Seed Owner ' },
      renderYear: 2026,
      currentPage: 1,
      pageSize: 10,
      total: 0,
      view: {
        articles: [],
        pagination: {
          currentPage: 1,
          totalPages: 1,
          canGoPrev: false,
          canGoNext: false,
          pageIndicatorText: '1 / 1'
        },
        empty: { title: 'empty', actionText: 'home' }
      },
      featuredArticles: [],
      hotArticles: []
    })

    expect(seed).toMatchObject({
      siteTitle: "Fsu's Blog",
      siteDescription: 'seeded description',
      siteLogoUrl: '/logo-light.svg',
      siteLogoDarkUrl: '/logo-dark.svg',
      siteWordmarkUrl: '/wordmark.svg',
      renderYear: 2026,
      compliance: {
        enabled: true,
        copyrightOwner: 'Seed Owner'
      }
    })
  })

  it('keeps frontend and backend default SEO titles aligned', () => {
    for (const path of [
      'src/shared/Contracts/Outputs/ServerResponseContracts.cs',
      'src/backend/Models/ReadModels/SystemReadModels.cs',
      'src/backend/Models/Requests/SystemRequests.cs'
    ]) {
      const source = readRepoFile(path)
      expect(source).toContain('PublicSiteIdentityDefaults.SiteTitle')
      expect(source).toContain('PublicSiteIdentityDefaults.SiteDescription')
      expect(source).toContain('PublicSiteIdentityDefaults.SiteKeywords')
      expect(source).toContain('PublicSiteIdentityDefaults.ManifestName')
      expect(source).toContain('PublicSiteIdentityDefaults.ManifestShortName')
      expect(source).not.toContain("Fsus's Blog")
      expect(source).not.toContain('= "FORWARD"')
      expect(source).not.toContain('= "记录"')
    }
  })
})

describe('public takeover source contracts', () => {
  beforeEach(() => {
    resetPublicTakeover({ reason: 'test-reset' })
  })

  it('uses one deterministic public takeover state machine', () => {
    expect(getPublicTakeoverPhase()).toBe('aot-idle')
    expect(getPublicRuntimeOwner()).toBe('aot')
    expect(canTransitionPublicTakeoverPhase('aot-idle', 'prewarming')).toBe(true)
    expect(canTransitionPublicTakeoverPhase('aot-idle', 'spa-active')).toBe(false)

    expect(beginPublicTakeoverPrewarm({ reason: 'idle' })).toBe(true)
    expect(getPublicTakeoverPhase()).toBe('prewarming')
    expect(markPublicTakeoverPrepared({ reason: 'route-ready' })).toBe(true)
    expect(getPublicTakeoverPhase()).toBe('prepared')
    expect(beginPublicTakeoverCommit({ reason: 'click' })).toBe(true)
    expect(getPublicRuntimeOwner()).toBe('spa')
    expect(completePublicTakeoverCommit({ reason: 'mounted' })).toBe(true)
    expect(getPublicTakeoverPhase()).toBe('spa-active')
  })

  it('rejects illegal public takeover transitions without moving owner state', () => {
    expect(transitionPublicTakeoverPhase('spa-active', { reason: 'illegal-test' })).toBe(false)
    expect(getPublicTakeoverPhase()).toBe('aot-idle')
    expect(getPublicRuntimeOwner()).toBe('aot')
  })

  it('keeps legacy public micro-navigation under AOT ownership', () => {
    expect(beginPublicTakeoverNavigation({ reason: 'micro-navigation' })).toBe(true)
    expect(getPublicTakeoverPhase()).toBe('navigating')
    expect(getPublicRuntimeOwner()).toBe('aot')
    expect(completePublicTakeoverNavigation({ reason: 'done' })).toBe(true)
    expect(getPublicTakeoverPhase()).toBe('aot-idle')
  })

  it('aborts public shell lifetime listeners exactly once', () => {
    const signal = resetPublicShellLifetime()
    let abortEvents = 0
    signal.addEventListener('abort', () => {
      abortEvents += 1
    })

    abortPublicShellLifetime('commit')
    abortPublicShellLifetime('commit-again')

    expect(abortEvents).toBe(1)
    expect(getPublicShellLifetimeAbortCount()).toBe(1)
  })

  it('renders public layout from an immutable takeover seed until takeover completes', () => {
    const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')

    expect(blogLayout).toContain('createPublicTakeoverSeed')
    expect(blogLayout).toContain('publicTakeoverPhaseState')
    expect(blogLayout).toContain('takeoverShellSeed')
  })

  it('keeps API-backed site store props out of the first public takeover shell render', () => {
    const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')

    expect(blogLayout).toContain("publicTakeoverPhaseState.value !== 'spa-active'")
    expect(blogLayout).toContain('const activeSiteIdentity = computed(() => createPublicSiteIdentity({')
    expect(blogLayout).toContain('siteDescription: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteDescription : siteStore.siteInfo.description')
    expect(blogLayout).toContain('siteTitle: activeSiteIdentity.value.siteTitle')
    expect(blogLayout).toContain('siteDescription: activeSiteIdentity.value.siteDescription')
    expect(blogLayout).toContain('siteLogoUrl: activeSiteIdentity.value.siteLogoUrl')
    expect(blogLayout).toContain('siteLogoDarkUrl: activeSiteIdentity.value.siteLogoDarkUrl')
    expect(blogLayout).toContain('siteWordmarkUrl: activeSiteIdentity.value.siteWordmarkUrl')
    expect(blogLayout).toContain('compliance: activeSiteIdentity.value.compliance')
    expect(blogLayout).toContain('renderYear: activeSiteIdentity.value.renderYear')
    expect(blogLayout.indexOf('setTimeout(() =>')).toBeLessThan(blogLayout.indexOf('void ensureSiteInfo()'))
  })

  it('syncs public document head from the same active site identity as the shell', () => {
    const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')

    expect(blogLayout).toContain('const publicDocumentTitle = computed(() =>')
    expect(blogLayout).toContain('activeSiteIdentity.value.siteTitle')
    expect(blogLayout).toContain('document.title = publicDocumentTitle.value')
    expect(blogLayout).toContain('activeSiteIdentity.value.siteDescription')
    expect(blogLayout).not.toContain('document.title = siteStore.siteInfo.title')
  })

  it('keeps first public SPA route render on AOT-compatible navigation semantics', () => {
    for (const path of [
      'src/frontend/src/views/Home.vue',
      'src/frontend/src/views/Archive.vue',
      'src/frontend/src/views/FilterView.vue'
    ]) {
      const source = readRepoFile(path)
      expect(source).toContain('usePublicSpaNavigationMode')
      expect(source).not.toContain(':spa-navigation="true"')
    }
  })

  it('wires public route prewarm to low-risk signals without replacing HTML micro-navigation', () => {
    const publicShell = readRepoFile('src/frontend/src/bootstrap/publicShell.ts')

    expect(publicShell).toContain('prewarmPublicRoute')
    expect(publicShell).toContain('resolvePublicRoutePrewarmTarget')
    expect(publicShell).toContain('schedulePublicRouteIdlePrewarm')
    expect(publicShell).toContain("'pointerenter'")
    expect(publicShell).toContain("'focusin'")
    expect(publicShell).toContain("requestPublicRoutePrewarm('/search', 'search-focus')")
    expect(publicShell).toContain('void navigateWithinPublicShell(anchor.href)')
  })
})
