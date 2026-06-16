import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createPublicTakeoverSeed,
  normalizePublicComplianceConfig,
  normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public takeover site identity', () => {
  it('normalizes site title and compliance through one shared contract', () => {
    expect(normalizePublicSiteTitle('  ')).toBe('站点')
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
      siteTitle: '站点',
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
})

describe('public takeover source contracts', () => {
  it('renders public layout from an immutable takeover seed until takeover completes', () => {
    const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')

    expect(blogLayout).toContain('createPublicTakeoverSeed')
    expect(blogLayout).toContain('publicTakeoverPhaseState')
    expect(blogLayout).toContain('takeoverShellSeed')
  })

  it('keeps API-backed site store props out of the first public takeover shell render', () => {
    const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')

    expect(blogLayout).toContain("publicTakeoverPhaseState.value !== 'hydrated'")
    expect(blogLayout).toContain('siteTitle: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteTitle : siteStore.siteInfo.title')
    expect(blogLayout).toContain('siteLogoUrl: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteLogoUrl : siteStore.siteInfo.siteLogoUrl')
    expect(blogLayout).toContain('siteLogoDarkUrl: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteLogoDarkUrl : siteStore.siteInfo.siteLogoDarkUrl')
    expect(blogLayout).toContain('siteWordmarkUrl: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteWordmarkUrl : siteStore.siteInfo.siteWordmarkUrl')
    expect(blogLayout).toContain('compliance: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.compliance : siteStore.complianceInfo')
    expect(blogLayout).toContain('renderYear: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.renderYear : runtimeRenderYear.value')
    expect(blogLayout.indexOf('setTimeout(() =>')).toBeLessThan(blogLayout.indexOf('void ensureSiteInfo()'))
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
})
