import { describe, expect, it, vi } from 'vitest'

vi.mock('@/public-renderers/publicEntryCore', async () => {
  const actual = await vi.importActual<typeof import('@/public-renderers/publicEntryCore')>('@/public-renderers/publicEntryCore')
  return {
    ...actual,
    renderShell: vi.fn(async () => '<div id="fsus-aot-shell"></div>')
  }
})

import { decodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { getSharedPublicPageManifestEntry, PUBLIC_PAGE_MANIFEST } from '@/public-renderers/generated/publicPageManifest'
import { renderShell } from '@/public-renderers/publicEntryCore'
import { buildPublicEntry } from '@/public-renderers/publicEntryRegistry'

describe('publicEntryRegistry shared coverage', () => {
  it('builds entries for every shared SEO page kind', async () => {
    const cases = [
      { kind: 'Home', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', response: { total: 0, items: [] } } },
      { kind: 'ArticleDetail', options: { id: 1, title: 'Article', content: 'Body', summary: 'Summary', siteTitle: 'FsusBlog', siteDescription: 'desc' } },
      { kind: 'Filter', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', filterType: 'search', routeKey: 'search', title: '搜索', total: 0, articles: [] } },
      { kind: 'Archive', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', total: 0, articles: [] } },
      { kind: 'About', options: { siteTitle: 'FsusBlog', siteDescription: 'desc', content: 'About content' } }
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

  it('reuses the shared About canonical slug when payload options omit it', async () => {
    const result = await buildPublicEntry('About', {
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      content: 'About content'
    })

    const hydration = decodePublicAotPayload<{ about?: { slug?: string } }>(result.entry.hydrationPropsPayload)

    expect(hydration?.about?.slug).toBe(getSharedPublicPageManifestEntry('About').canonicalSlug)
  })

  it('keeps article hydration bodyHtml aligned with SSR body markup instead of raw markdown', async () => {
    const result = await buildPublicEntry('ArticleDetail', {
      id: 1,
      title: 'Article',
      content: '# Heading\n\nContent',
      summary: 'Summary',
      siteTitle: 'FsusBlog',
      siteDescription: 'desc'
    })

    const hydration = decodePublicAotPayload<{ bodyHtml?: string; detailView?: { body?: { content?: string } } }>(result.entry.hydrationPropsPayload)

    expect(hydration?.detailView?.body?.content).toBe('# Heading\n\nContent')
    expect(hydration?.bodyHtml).toContain('<h1>Heading</h1>')
    expect(hydration?.bodyHtml).toContain('<p class="markdown-renderer__text">Content</p>')
    expect(hydration?.bodyHtml).not.toContain('<div class="markdown-body')
    expect(hydration?.bodyHtml).not.toBe(hydration?.detailView?.body?.content)
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
})
