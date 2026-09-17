// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type PropType, type VNode } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import { createPublicHomePageAssembly } from '@/public-renderers/pageAssemblies'
import type { ArticleListCardViewContract, ArticleListViewContract } from '@/view-contracts/articleList'

const featured = (id: number): FeaturedArticleItem => ({
  id,
  title: `Featured ${id}`,
  coverImageUrl: `/uploads/${id}.webp`,
  views: id * 100,
  createTime: '2026-07-11T00:00:00.000Z',
  category: { id: 1, name: '工程' }
})

const hot = (id: number): PopularArticleSummaryResponse => ({
  id,
  title: `Hot ${id}`,
  views: id * 10
})

const card = (id: number): ArticleListCardViewContract => ({
  card: { kind: 'article-list-card', index: id },
  id,
  href: `/article/${id}`,
  title: `Feed ${id}`,
  summary: `Summary ${id}`,
  meta: {
    isoTime: '2026-07-11T00:00:00.000Z',
    displayTime: '2026-07-11',
    fullTime: '2026-07-11 00:00:00',
    categoryName: '工程'
  },
  tags: []
})

const createView = (): ArticleListViewContract => ({
  items: [card(1), card(2), card(3), card(4)],
  pagination: {
    previous: { label: '上一页', disabled: true, action: { action: 'page-prev' } },
    next: { label: '下一页', disabled: false, action: { action: 'page-next' } },
    indicator: '1 / 2'
  },
  showPagination: true,
  emptyState: { title: '这里还没有文章' },
  searchKeyword: ''
})

afterEach(() => {
  vi.doUnmock('@/composables/useHomeView')
  vi.doUnmock('@/composables/useHumanReadProof')
  vi.doUnmock('@/composables/usePublicSpaNavigationMode')
  vi.doUnmock('vue-router')
  vi.resetModules()
  document.body.innerHTML = ''
})

describe('home renderer editorial parity', () => {
  it('keeps AOT/hydration assembly and SPA takeover in the same order', async () => {
    const view = createView()
    const featuredArticles = [featured(1), featured(8)]
    const hotArticles = [hot(1), hot(2), hot(3)]
    const assembly = createPublicHomePageAssembly({
      view,
      featuredArticles,
      hotArticles
    })
    const assemblyProps = assembly.props as {
      view: ArticleListViewContract
      hasRecommendations: boolean
      showArticleCta: boolean
    }
    const featuredNodes = assembly.slots?.featured?.() as VNode[]
    const aotLeadId = Number(featuredNodes[0]?.props?.article?.id)
    const aotSecondaryIds = (featuredNodes[1]?.props?.articles as PopularArticleSummaryResponse[])
      .map((article) => article.id)
    const aotFeedIds = assemblyProps.view.items.map((article) => article.id)

    const spaView = ref(view)
    vi.doMock('@/composables/useHomeView', () => ({
      useHomeView: () => ({
        listView: spaView,
        featuredArticles: ref(featuredArticles),
        hotArticles: ref(hotArticles),
        featuredLoading: ref(false),
        currentPage: ref(1),
        loading: ref(false),
        isError: ref(false),
        handlePageChange: vi.fn(),
        loadArticles: vi.fn()
      })
    }))
    vi.doMock('@/composables/useHumanReadProof', () => ({ useHumanReadProof: vi.fn() }))
    vi.doMock('@/composables/usePublicSpaNavigationMode', () => ({ usePublicSpaNavigationMode: false }))
    vi.doMock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

    const PublicHomePageContentStub = defineComponent({
      props: {
        view: { type: Object as PropType<ArticleListViewContract>, required: true },
        hasRecommendations: { type: Boolean, default: false },
        showArticleCta: { type: Boolean, default: true }
      },
      setup(props, { slots }) {
        return () => h('main', {
          'data-feed-ids': props.view.items.map((article) => article.id).join(','),
          'data-has-recommendations': String(props.hasRecommendations),
          'data-show-article-cta': String(props.showArticleCta)
        }, slots.featured?.())
      }
    })
    const FeaturedArticlesSectionStub = defineComponent({
      props: {
        article: { type: Object as PropType<FeaturedArticleItem | null>, default: null }
      },
      setup(props) {
        return () => h('div', { 'data-spa-lead-id': props.article?.id ?? '' })
      }
    })
    const HomeTextFirstRecommendationsStub = defineComponent({
      props: {
        articles: { type: Array as PropType<readonly PopularArticleSummaryResponse[]>, required: true }
      },
      setup(props) {
        return () => h('div', {
          'data-spa-secondary-ids': props.articles.map((article) => article.id).join(',')
        })
      }
    })

    const Home = (await import('@/views/Home.vue')).default
    const wrapper = mount(Home, {
      global: {
        stubs: {
          PublicHomePageContent: PublicHomePageContentStub,
          FeaturedArticlesSection: FeaturedArticlesSectionStub,
          HomeTextFirstRecommendations: HomeTextFirstRecommendationsStub
        }
      }
    })

    expect(Number(wrapper.get('[data-spa-lead-id]').attributes('data-spa-lead-id'))).toBe(aotLeadId)
    expect(wrapper.get('[data-spa-secondary-ids]').attributes('data-spa-secondary-ids'))
      .toBe(aotSecondaryIds.join(','))
    expect(wrapper.get('main').attributes('data-feed-ids')).toBe(aotFeedIds.join(','))
    expect(wrapper.get('main').attributes('data-has-recommendations')).toBe(String(assemblyProps.hasRecommendations))
    expect(wrapper.get('main').attributes('data-show-article-cta')).toBe('false')
    expect(assemblyProps.showArticleCta).toBe(false)
    expect([aotLeadId, ...aotSecondaryIds]).toEqual([1, 2, 3])
    expect(aotFeedIds).toEqual([1, 2, 3, 4])
    expect(aotFeedIds).toContain(aotLeadId)
    expect(aotFeedIds).toEqual(expect.arrayContaining(aotSecondaryIds))

    // SPA navigation replaces the current-page payload without recomposing it.
    spaView.value = {
      ...view,
      items: [card(2), card(6), card(7)],
      pagination: {
        previous: { label: '上一页', disabled: false, action: { action: 'page-prev' } },
        next: { label: '下一页', disabled: true, action: { action: 'page-next' } },
        indicator: '2 / 2'
      }
    }
    await nextTick()
    expect(wrapper.get('main').attributes('data-feed-ids')).toBe('2,6,7')

    // A notification preview patch may overlap the recommendation sources.
    spaView.value = {
      ...spaView.value,
      items: [card(9), card(2), card(6), card(7)]
    }
    await nextTick()
    expect(wrapper.get('main').attributes('data-feed-ids')).toBe('9,2,6,7')

    // A reconnect/resync replaces the feed and must not inherit old exclusions.
    spaView.value = {
      ...spaView.value,
      items: [card(10), card(11), card(12)]
    }
    await nextTick()
    expect(wrapper.get('main').attributes('data-feed-ids')).toBe('10,11,12')

    wrapper.unmount()
  })
})
