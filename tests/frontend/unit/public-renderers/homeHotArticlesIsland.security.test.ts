import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PopularArticleSummaryResponse } from '@/api/article'
import {
  mountHomeHotArticlesIsland,
  unmountHomeHotArticlesIsland
} from '@/public-renderers/homeHotArticlesIsland'

const { getHotArticlesMock } = vi.hoisted(() => ({
  getHotArticlesMock: vi.fn()
}))

vi.mock('@/api/article', () => ({
  getHotArticles: getHotArticlesMock
}))

describe('home hot articles island security', () => {
  const xssFlag = '__fsusHomeHotTitleXss'

  beforeEach(() => {
    document.body.innerHTML = '<div id="fsus-home-hot-articles-slot-content"></div>'
    delete (globalThis as Record<string, unknown>)[xssFlag]
    getHotArticlesMock.mockReset()
  })

  afterEach(() => {
    unmountHomeHotArticlesIsland()
    document.body.innerHTML = ''
    delete (globalThis as Record<string, unknown>)[xssFlag]
  })

  it('renders hot article titles as text instead of parsing attacker HTML', async () => {
    const payload = `</a><img src=x onerror="globalThis.${xssFlag} = 1"><a>`
    const articles: PopularArticleSummaryResponse[] = [
      {
        id: 42,
        title: payload,
        views: 1234
      }
    ]

    getHotArticlesMock.mockResolvedValue(articles)

    await mountHomeHotArticlesIsland('home')

    const slot = document.getElementById('fsus-home-hot-articles-slot-content')
    expect(slot).not.toBeNull()
    expect(slot?.querySelector('img')).toBeNull()
    expect(slot?.querySelector('svg')).toBeNull()
    expect(slot?.querySelector('script')).toBeNull()

    const links = slot?.querySelectorAll('a') ?? []
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('/article/42')
    expect(links[0]?.textContent).toContain(payload)
    expect(links[0]?.hasAttribute('onerror')).toBe(false)
    expect(links[0]?.hasAttribute('onclick')).toBe(false)
    expect((globalThis as Record<string, unknown>)[xssFlag]).toBeUndefined()
  })
})
