import { describe, expect, it } from 'vitest'
import {
  createPublicTakeoverSeed,
  normalizePublicComplianceConfig,
  normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity'
import { PUBLIC_SITE_IDENTITY_DEFAULTS } from '@/public-renderers/publicSiteIdentityDefaults'
import { PUBLIC_SHELL_DEFAULTS } from '@/public-renderers/publicShellState'
import { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog'
import type { PublicHydrationPayload } from '@/public-renderers/types'

describe('public site identity', () => {
  it('keeps frontend shell defaults aligned to the public site identity contract', () => {
    expect(PUBLIC_SHELL_DEFAULTS.siteTitle).toBe(PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle)
    expect(PUBLIC_SITE_IDENTITY_DEFAULTS.siteDescription).toBe('工程记录、性能实验、UI 系统与 FsusBlog 构建过程。')
    expect(PUBLIC_SITE_IDENTITY_DEFAULTS.siteKeywords).toBe('.NET, 前端性能, 系统设计, UI 系统, 技术博客, FsusBlog')
    expect(PUBLIC_SITE_IDENTITY_DEFAULTS.manifestName).toBe(PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle)
    expect(PUBLIC_SITE_IDENTITY_DEFAULTS.manifestShortName).toBe('FsusBlog')
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
      renderLocale: 'zh-CN',
      localeCatalogDigest: LOCALE_CATALOG_DIGEST,
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

  it('rejects a takeover payload whose render locale is missing or invalid', () => {
    const invalid = {
      pageKind: 'Home',
      routeKey: 'home',
      rendererVersion: 'test',
      localeCatalogDigest: LOCALE_CATALOG_DIGEST
    } as unknown as PublicHydrationPayload

    expect(createPublicTakeoverSeed(invalid)).toBeNull()
  })
})
