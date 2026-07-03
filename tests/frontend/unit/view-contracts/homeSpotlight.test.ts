import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import {
  resolveHomeSecondaryLayout,
  selectHomeSpotlightCandidates
} from '@/view-contracts/homeSpotlight'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

const featured = (id: number, coverImageUrl: string, views = id): FeaturedArticleItem => ({
  id,
  title: `Article ${id}`,
  coverImageUrl,
  views,
  createTime: new Date(2026, 0, id).toISOString(),
  category: {
    id: 1,
    name: 'Demo'
  }
})

const hot = (id: number): PopularArticleSummaryResponse => ({
  id,
  title: `Hot ${id}`,
  views: id * 10
})

describe('homeSpotlight view contract', () => {
  it('filters out missing and whitespace covers while preserving backend candidate order', () => {
    const candidates = selectHomeSpotlightCandidates([
      featured(1, ''),
      featured(2, '   '),
      featured(3, '/uploads/three.webp', 1),
      featured(4, '/uploads/four.webp', 999)
    ])

    expect(candidates.map((article) => article.id)).toEqual([3, 4])
  })

  it('limits spotlight candidates', () => {
    const candidates = selectHomeSpotlightCandidates([
      featured(1, '/a.webp'),
      featured(2, '/b.webp'),
      featured(3, '/c.webp')
    ], 2)

    expect(candidates.map((article) => article.id)).toEqual([1, 2])
  })

  it('selects text-first layout when hot articles exist but spotlight has no valid cover', () => {
    expect(resolveHomeSecondaryLayout({
      loading: false,
      spotlightCandidates: [],
      hotArticles: [hot(1)]
    })).toBe('text-first')
  })

  it('does not render a secondary home section without loading, spotlight, or recommendations', () => {
    expect(resolveHomeSecondaryLayout({
      loading: false,
      spotlightCandidates: [],
      hotArticles: []
    })).toBe('none')
  })

  it('keeps loading and spotlight layouts explicit', () => {
    expect(resolveHomeSecondaryLayout({
      loading: true,
      spotlightCandidates: [],
      hotArticles: []
    })).toBe('loading')
    expect(resolveHomeSecondaryLayout({
      loading: false,
      spotlightCandidates: [featured(1, '/cover.webp')],
      hotArticles: []
    })).toBe('spotlight')
  })

  it('keeps the hot aside scoped to spotlight home shells', () => {
    const homeFeedSurface = readRepoFile('src/frontend/src/components/public/HomeFeedSurface.vue')
    const publicHomeContent = readRepoFile('src/frontend/src/components/public/pages/PublicHomePageContent.vue')
    const pageAssemblies = readRepoFile('src/frontend/src/public-renderers/pageAssemblies.ts')
    const homeView = readRepoFile('src/frontend/src/views/Home.vue')
    const publicShell = readRepoFile('src/frontend/src/bootstrap/publicShell.ts')

    expect(homeFeedSurface).toContain('v-if="showAside"')
    expect(homeFeedSurface).toContain('data-readable-region')
    expect(homeFeedSurface).toContain("showAside ? 'w-full max-w-[760px] grow lg:max-w-none lg:w-2/3' : 'mx-auto w-full max-w-[760px]'")
    expect(publicHomeContent).toContain('<HomeFeedSurface :show-aside="showAside">')
    expect(pageAssemblies).toContain('const showAside = false')
    expect(pageAssemblies).toContain('h(FeaturedArticlesSection')
    expect(pageAssemblies).toContain("aside: () => createCommentVNode('v-if', true)")
    expect(pageAssemblies).toContain('h(HomeTextFirstRecommendations')
    expect(homeView).toContain(':show-aside="showHomeAside"')
    expect(homeView).toContain('const showHomeAside = false')
    expect(homeView).toContain('<HomeTextFirstRecommendations')
    expect(publicShell.indexOf("document.getElementById('fsus-home-hot-articles-slot-content')"))
      .toBeLessThan(publicShell.indexOf('const sentinel = document.getElementById(HOME_HOT_ARTICLES_SENTINEL_ID)'))
  })
})
