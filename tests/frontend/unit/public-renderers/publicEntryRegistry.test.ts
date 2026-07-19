import { describe, expect, it, vi } from 'vitest'

vi.mock('@/fsusui/appContext', () => ({
  provideFsusUiAppContext: vi.fn()
}))

vi.mock('@/public-renderers/scaffold', () => ({
  renderPublicAotPage: vi.fn(() => null),
  renderPublicAotShell: vi.fn(() => null)
}))

vi.mock('@/public-renderers/publicEntryCore', async () => {
  const actual = await vi.importActual<typeof import('@/public-renderers/publicEntryCore')>('@/public-renderers/publicEntryCore')
  return {
    ...actual,
    renderShell: vi.fn(async () => '<div id="fsus-aot-shell"></div>')
  }
})

vi.mock('@/fsusui/markdown', () => ({
  renderMarkdownWithFsusRuntime: vi.fn(async ({ source }: { source: string }) => ({
    ok: true,
    value: {
      html: source === '# Heading\n\nContent'
        ? '<h1>Heading</h1>\n<p class="markdown-renderer__text">Content</p>'
        : `<p class="markdown-renderer__text">${source}</p>`
    }
  }))
}))

vi.mock('@/components/home/FeaturedArticlesSection.vue', () => ({
  default: { name: 'FeaturedArticlesSectionStub', render: () => null }
}))

vi.mock('@/components/home/HomeTextFirstRecommendations.vue', () => ({
  default: { name: 'HomeTextFirstRecommendationsStub', render: () => null }
}))

vi.mock('@/components/public/pages/PublicAboutPageContent.vue', () => ({
  default: { name: 'PublicAboutPageContentStub', render: () => null }
}))

vi.mock('@/components/public/pages/PublicArchivePageContent.vue', () => ({
  default: { name: 'PublicArchivePageContentStub', render: () => null }
}))

vi.mock('@/components/public/pages/PublicArticleDetailPageContent.vue', () => ({
  default: { name: 'PublicArticleDetailPageContentStub', render: () => null }
}))

vi.mock('@/components/public/pages/PublicFilterPageContent.vue', () => ({
  default: { name: 'PublicFilterPageContentStub', render: () => null }
}))

vi.mock('@/components/public/pages/PublicHomePageContent.vue', () => ({
  default: { name: 'PublicHomePageContentStub', render: () => null }
}))

vi.mock('@/components/ui/MarkdownRenderer.vue', () => ({
  default: { name: 'MarkdownRendererStub', render: () => null }
}))

import { decodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { getSharedPublicPageManifestEntry, PUBLIC_PAGE_MANIFEST } from '@/public-renderers/generated/publicPageManifest'
import { renderShell } from '@/public-renderers/publicEntryCore'
import { createPublicHydrationRoot } from '@/public-renderers/publicHydrationRoot'
import { buildPublicEntry } from '@/public-renderers/publicEntryRegistry'
import { renderPublicAotShell } from '@/public-renderers/scaffold'
import { articleRightsFixture } from '../fixtures/articleRights'

describe('publicEntryRegistry shared coverage', () => {
  it('builds entries for every shared SEO page kind', async () => {
    const cases = [
      { kind: 'Home', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', pageIndex: 1, pageSize: 10, total: 0, articles: [], featuredArticles: [], hotArticles: [] } },
      { kind: 'ArticleDetail', options: { id: 1, title: 'Article', bodyContent: 'Body', summary: 'Summary', rights: articleRightsFixture, siteTitle: 'FsusBlog', siteDescription: 'desc' } },
      { kind: 'Filter', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', filterType: 'search', routeKey: 'search', title: '搜索', total: 0, articles: [] } },
      { kind: 'Archive', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', total: 0, articles: [] } },
      { kind: 'About', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', content: 'About content' } },
      { kind: 'Privacy', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', content: 'Privacy content' } },
      { kind: 'Guidelines', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', content: 'Guidelines content' } },
      { kind: 'Copyright', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', content: 'Copyright content' } }
    ] as const

    const renderShellMock = vi.mocked(renderShell)
    renderShellMock.mockClear()

    const entries = await Promise.all(cases.map(({ kind, options }) => buildPublicEntry(kind, options)))

    const actualPageIds = entries.map((result) => result.entry.pageId).sort((left, right) => left - right)
    const expectedPageIds = Object.values(PUBLIC_PAGE_MANIFEST)
      .filter((definition) => definition.seoEligible)
      .map((definition) => definition.pageId)
      .sort((left, right) => left - right)

    expect(actualPageIds).toEqual(expectedPageIds)
    expect(renderShellMock.mock.calls.map(([kind]) => kind).sort()).toEqual(cases.map(({ kind }) => kind).sort())
    expect(renderShellMock.mock.calls.every((call) => call[4]?.siteDescription === 'desc')).toBe(true)

    entries.forEach((result, index) => {
      const hydration = decodePublicAotPayload<{ pageKind?: string }>(result.entry.hydrationPropsPayload)
      expect(hydration?.pageKind).toBe(cases[index].kind)
    })
  })

  it('emits the shared staticPage payload for About when options omit slug', async () => {
    const result = await buildPublicEntry('About', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      content: 'About content'
    })

    const hydration = decodePublicAotPayload<{ staticPage?: { slug?: string }; about?: unknown }>(result.entry.hydrationPropsPayload)

    expect(hydration?.staticPage?.slug).toBe(getSharedPublicPageManifestEntry('About').canonicalSlug)
    expect(hydration?.about).toBeUndefined()
  })

  it('emits shared staticPage payload for public policy pages', async () => {
    const result = await buildPublicEntry('Privacy', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      content: 'Privacy content'
    })

    const hydration = decodePublicAotPayload<{ staticPage?: { slug?: string } }>(result.entry.hydrationPropsPayload)

    expect(hydration?.staticPage?.slug).toBe(getSharedPublicPageManifestEntry('Privacy').canonicalSlug)
  })

  it('keeps article hydration bodyHtml aligned with SSR body markup instead of raw markdown', async () => {
    const result = await buildPublicEntry('ArticleDetail', {
      id: 1,
      title: 'Article',
      bodyContent: '# Heading\n\nContent',
      summary: 'Summary',
      rights: articleRightsFixture,
      siteTitle: 'FsusBlog',
      siteDescription: 'desc'
    })

    const hydration = decodePublicAotPayload<{ bodyContent?: string; bodyHtml?: string; detailView?: { body?: { content?: string } } }>(result.entry.hydrationPropsPayload)

    expect(result.entry.islandsPayload).toBeNull()
    expect(hydration?.bodyContent).toBe('# Heading\n\nContent')
    expect(hydration?.detailView?.body?.content).toBe('# Heading\n\nContent')
    expect(hydration?.bodyHtml).toContain('<h1>Heading</h1>')
    expect(hydration?.bodyHtml).toContain('<p class="markdown-renderer__text">Content</p>')
    expect(hydration?.bodyHtml).not.toContain('<div class="markdown-body')
    expect(hydration?.bodyHtml).not.toBe(hydration?.detailView?.body?.content)
  })

  it('emits ArticleDetail rights in bootstrap, hydration and the view contract', async () => {
    const result = await buildPublicEntry('ArticleDetail', {
      id: 1,
      title: 'Article',
      bodyContent: 'Body',
      summary: 'Summary',
      rights: articleRightsFixture,
      siteTitle: 'FsusBlog',
      siteDescription: 'desc'
    })

    const hydration = decodePublicAotPayload<{
      rights?: unknown
      detailView?: { rights?: unknown }
    }>(result.entry.hydrationPropsPayload)
    const bootstrap = decodePublicAotPayload<{
      article?: { rights?: unknown }
    }>(result.entry.bootstrapPayload)

    expect(hydration?.rights).toEqual(articleRightsFixture)
    expect(hydration?.detailView?.rights).toEqual(articleRightsFixture)
    expect(bootstrap?.article?.rights).toEqual(articleRightsFixture)
  })

  it('keeps multi-author visible SSR metadata aligned with hydration', async () => {
    const result = await buildPublicEntry('ArticleDetail', {
      id: 1,
      title: 'Article',
      bodyContent: 'Body',
      summary: 'Summary',
      rights: articleRightsFixture,
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      authors: [
        { name: 'Alice', profileUrl: 'https://example.test/alice' },
        { name: 'Bob', profileUrl: null }
      ],
      responsibility: {
        articleId: 1,
        revisionNo: 3,
        authors: [
          { name: 'Alice', profileUrl: 'https://example.test/alice' },
          { name: 'Bob', profileUrl: null }
        ],
        reviewer: null,
        sources: [{ title: 'Spec', url: 'https://example.test/spec', sourceType: 'primary', accessedOn: null, version: null, citationNote: null }],
        update: { summary: 'Updated', reason: 'Evidence', conclusionImpact: 'clarified' },
        verification: { url: '/integrity/article/1/revisions/3', proofStatus: 'ready' }
      }
    })

    const hydration = decodePublicAotPayload<{
      responsibilityAuthors?: readonly { name: string; profileUrl: string | null }[]
      responsibilityManifest?: { sources: readonly { title: string }[] }
    }>(result.entry.hydrationPropsPayload)
    const assembly = vi.mocked(renderShell).mock.calls.at(-1)?.[2] as {
      props?: {
        responsibilityAuthors?: readonly { name: string }[]
        responsibilityManifest?: { sources: readonly { title: string }[] }
      }
    }

    expect(hydration?.responsibilityAuthors?.map(author => author.name)).toEqual(['Alice', 'Bob'])
    expect(assembly.props?.responsibilityAuthors?.map(author => author.name)).toEqual(['Alice', 'Bob'])
    expect(hydration?.responsibilityManifest?.sources[0]?.title).toBe('Spec')
    expect(assembly.props?.responsibilityManifest?.sources[0]?.title).toBe('Spec')
  })

  it('accepts the backend flat home payload shape without response nesting', async () => {
    const result = await buildPublicEntry('Home', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      pageIndex: 1,
      pageSize: 10,
      total: 1,
      articles: [
        {
          id: 1,
          title: 'Home article',
          summary: 'Summary',
          views: 3,
          createTime: '2026-06-16T00:00:00.000Z',
          category: { id: 2, name: 'Category' },
          tags: [{ id: 3, name: 'Tag' }]
        }
      ],
      featuredArticles: [],
      hotArticles: []
    })

    const bootstrap = decodePublicAotPayload<{ articles?: unknown[]; total?: number; response?: unknown }>(result.entry.bootstrapPayload)
    const hydration = decodePublicAotPayload<{ total?: number; view?: { items?: unknown[] } }>(result.entry.hydrationPropsPayload)

    expect(bootstrap?.response).toBeUndefined()
    expect(bootstrap?.total).toBe(1)
    expect(bootstrap?.articles).toHaveLength(1)
    expect(hydration?.total).toBe(1)
    expect(hydration?.view?.items).toHaveLength(1)
  })

  it('preserves page-specific route seeds and canonical pagination links in SSR assemblies', async () => {
    const renderShellMock = vi.mocked(renderShell)
    renderShellMock.mockClear()

    const home = await buildPublicEntry('Home', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      routeKey: 'home:page:2',
      pageIndex: 2,
      pageSize: 10,
      total: 30,
      articles: [],
      featuredArticles: [],
      hotArticles: []
    })
    const homeAssembly = renderShellMock.mock.calls.at(-1)?.[2] as {
      props?: { view?: { pagination?: { previous?: { href?: string }; next?: { href?: string } } } }
    }
    const homeHydration = decodePublicAotPayload<{ routeKey?: string }>(home.entry.hydrationPropsPayload)

    expect(home.entry.routeKey).toBe('home:page:2')
    expect(homeHydration?.routeKey).toBe('home:page:2')
    expect(homeAssembly.props?.view?.pagination?.previous?.href).toBe('/')
    expect(homeAssembly.props?.view?.pagination?.next?.href).toBe('/?page=3')

    await buildPublicEntry('Filter', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      routeKey: 'category:7:page:2',
      title: 'Category',
      filter: {
        filterType: 'category',
        filterKey: 'category:7',
        filterId: 7,
        filterName: 'Category',
        isInvalidTarget: false,
        pageIndex: 2,
        pageSize: 10,
        total: 30,
        articles: []
      }
    })
    const filterAssembly = renderShellMock.mock.calls.at(-1)?.[2] as {
      props?: { view?: { pagination?: { previousHref?: string; nextHref?: string } } }
    }
    expect(filterAssembly.props?.view?.pagination?.previousHref).toBe('/category/7')
    expect(filterAssembly.props?.view?.pagination?.nextHref).toBe('/category/7?page=3')
  })

  it('emits one render clock for public article detail and related-reading display times', async () => {
    const result = await buildPublicEntry('ArticleDetail', {
      id: 1,
      title: 'Article',
      bodyContent: 'Body',
      summary: 'Summary',
      rights: articleRightsFixture,
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      createTime: '2026-01-01T00:00:30Z',
      renderTimestamp: '2026-01-01T00:01:00Z',
      relatedReading: {
        related: [
          {
            id: 2,
            title: 'Related',
            summary: 'Related summary',
            createTime: '2026-01-01T00:00:30Z',
            reason: '相关'
          }
        ]
      }
    })

    const hydration = decodePublicAotPayload<{
      renderTimestamp?: string
      renderYear?: number
      renderTimeZone?: string
      detailView?: {
        header?: { meta?: { displayTime?: string } }
        relatedReading?: { items?: Array<{ displayTime?: string }> }
      }
    }>(result.entry.hydrationPropsPayload)
    const bootstrap = decodePublicAotPayload<{
      renderTimestamp?: string
      renderYear?: number
      renderTimeZone?: string
    }>(result.entry.bootstrapPayload)

    expect(hydration?.renderTimestamp).toBe('2026-01-01T00:01:00.000Z')
    expect(hydration?.renderYear).toBe(2026)
    expect(hydration?.renderTimeZone).toBe('UTC')
    expect(bootstrap?.renderTimestamp).toBe(hydration?.renderTimestamp)
    expect(bootstrap?.renderYear).toBe(hydration?.renderYear)
    expect(hydration?.detailView?.header?.meta?.displayTime).toBe('刚刚')
    expect(hydration?.detailView?.relatedReading?.items?.[0]?.displayTime).toBe('刚刚')
  })

  it('derives static page currentYear from the public render clock', async () => {
    const result = await buildPublicEntry('About', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      content: 'About content',
      renderTimestamp: '2025-12-31T23:59:30Z'
    })

    const hydration = decodePublicAotPayload<{
      renderTimestamp?: string
      renderYear?: number
      view?: { header?: { currentYear?: number } }
    }>(result.entry.hydrationPropsPayload)

    expect(hydration?.renderTimestamp).toBe('2025-12-31T23:59:30.000Z')
    expect(hydration?.renderYear).toBe(2025)
    expect(hydration?.view?.header?.currentYear).toBe(2025)
  })

  it('passes the payload renderYear through the hydration root shell', async () => {
    const result = await buildPublicEntry('About', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      content: 'About content',
      renderTimestamp: '2025-12-31T23:59:30Z'
    })
    const hydration = decodePublicAotPayload<Parameters<typeof createPublicHydrationRoot>[0]>(result.entry.hydrationPropsPayload)
    const renderShellMock = vi.mocked(renderPublicAotShell)

    renderShellMock.mockClear()
    createPublicHydrationRoot(hydration!)

    expect(renderShellMock).toHaveBeenCalledTimes(1)
    expect(renderShellMock.mock.calls[0]?.[0].renderYear).toBe(2025)
    expect(renderShellMock.mock.calls[0]?.[0].siteDescription).toBe('desc')
  })

  it('derives filter search-sort visibility from shared filter semantics', async () => {
    const renderShellMock = vi.mocked(renderShell)
    renderShellMock.mockClear()

    await buildPublicEntry('Filter', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      filterType: 'search',
      routeKey: 'search',
      title: '搜索',
      total: 0,
      articles: []
    })

    await buildPublicEntry('Filter', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      filterType: 'category',
      filterId: 7,
      routeKey: 'category:7',
      title: '分类',
      total: 0,
      articles: []
    })

    expect(renderShellMock.mock.calls).toHaveLength(2)
    expect(renderShellMock.mock.calls[0]?.[2].props.showSearchSort).toBe(true)
    expect(renderShellMock.mock.calls[1]?.[2].props.showSearchSort).toBe(false)
  })

  it('accepts backend filter subobject without duplicating filter scalars in emitted payloads', async () => {
    const result = await buildPublicEntry('Filter', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      routeKey: 'category:7',
      title: 'Category',
      filter: {
        filterType: 'category',
        filterKey: 'category:7',
        filterId: 7,
        filterName: 'Category',
        isInvalidTarget: false,
        pageIndex: 1,
        pageSize: 10,
        total: 0,
        articles: []
      }
    })

    const bootstrap = decodePublicAotPayload<Record<string, unknown>>(result.entry.bootstrapPayload)
    const hydration = decodePublicAotPayload<Record<string, unknown>>(result.entry.hydrationPropsPayload)

    expect(bootstrap?.filter).toMatchObject({ filterType: 'category', filterKey: 'category:7', filterId: 7 })
    expect(hydration?.filter).toMatchObject({ filterType: 'category', filterKey: 'category:7', filterId: 7 })
    expect(bootstrap?.filterType).toBeUndefined()
    expect(hydration?.filterType).toBeUndefined()
  })
})
