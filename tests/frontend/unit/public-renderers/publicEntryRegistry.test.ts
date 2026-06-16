import { describe, expect, it, vi } from 'vitest'

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

import { decodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { getSharedPublicPageManifestEntry, PUBLIC_PAGE_MANIFEST } from '@/public-renderers/generated/publicPageManifest'
import { renderShell } from '@/public-renderers/publicEntryCore'
import { buildPublicEntry } from '@/public-renderers/publicEntryRegistry'

describe('publicEntryRegistry shared coverage', () => {
  it('builds entries for every shared SEO page kind', async () => {
    const cases = [
      { kind: 'Home', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', pageIndex: 1, pageSize: 10, total: 0, articles: [], featuredArticles: [], hotArticles: [] } },
      { kind: 'ArticleDetail', options: { id: 1, title: 'Article', bodyContent: 'Body', summary: 'Summary', siteTitle: 'FsusBlog', siteDescription: 'desc' } },
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
