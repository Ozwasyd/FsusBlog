// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import FeaturedArticlesSection from '@/components/home/FeaturedArticlesSection.vue'
import HomeTextFirstRecommendations from '@/components/home/HomeTextFirstRecommendations.vue'
import HomeFeedSurface from '@/components/public/HomeFeedSurface.vue'
import PublicArticleList from '@/components/public/PublicArticleList.vue'
import PublicHomePageContent from '@/components/public/pages/PublicHomePageContent.vue'
import type { ArticleListCardViewContract, ArticleListViewContract } from '@/view-contracts/articleList'

const RouterLinkStub = defineComponent({
  name: 'RouterLink',
  props: {
    to: { type: String, required: true },
    custom: { type: Boolean, default: false }
  },
  setup(props, { slots }) {
    return () => slots.default?.({
      href: props.to,
      navigate: () => undefined
    })
  }
})

const featured = (coverImageUrl: string): FeaturedArticleItem => ({
  id: 42,
  title: '内容先于站点口号',
  coverImageUrl,
  views: 100,
  createTime: '2026-07-11T00:00:00.000Z',
  category: { id: 7, name: '工程' }
})

const recommendation = (id: number): PopularArticleSummaryResponse => ({
  id,
  title: `Recommendation ${id}`,
  views: id * 10
})

const card = (
  id: number,
  tags: ArticleListCardViewContract['tags'] = []
): ArticleListCardViewContract => ({
  card: { kind: 'article-list-card', index: id },
  id,
  href: `/article/${id}`,
  title: `Article ${id}`,
  summary: `Summary ${id}`,
  meta: {
    isoTime: '2026-07-11T00:00:00.000Z',
    displayTime: '2026-07-11',
    fullTime: '2026-07-11 00:00:00',
    categoryName: '工程'
  },
  tags
})

const listView = (items: readonly ArticleListCardViewContract[]): ArticleListViewContract => ({
  items,
  pagination: {
    previous: { label: '上一页', disabled: true, action: { action: 'page-prev' } },
    next: { label: '下一页', disabled: false, action: { action: 'page-next' } },
    indicator: '1 / 2'
  },
  showPagination: true,
  emptyState: { title: '这里还没有文章' },
  searchKeyword: ''
})

const homeGlobals = {
  stubs: {
    RouterLink: RouterLinkStub,
    ElSkeleton: true,
    ElSkeletonItem: true,
    ElIcon: true
  }
}

afterEach(() => {
  document.documentElement.classList.remove('dark')
  document.body.innerHTML = ''
})

describe('home editorial components', () => {
  it('renders the aside column only when real slot content is provided', () => {
    const withoutAside = mount(HomeFeedSurface, {
      props: { showAside: true },
      slots: { main: '<p>feed</p>' }
    })
    expect(withoutAside.find('aside').exists()).toBe(false)
    expect(withoutAside.find('#fsus-home-hot-articles-slot').exists()).toBe(false)
    expect(withoutAside.find('.public-aside-placeholder').exists()).toBe(false)
    expect(withoutAside.get('#fsus-home-main-column').classes()).toEqual(
      expect.arrayContaining(['mx-auto', 'max-w-[760px]'])
    )
    withoutAside.unmount()

    const withAside = mount(HomeFeedSurface, {
      props: { showAside: true },
      slots: {
        main: '<p>feed</p>',
        aside: '<div data-test="real-aside">real</div>'
      }
    })
    expect(withAside.get('aside').attributes('id')).toBe('fsus-home-hot-articles-slot')
    expect(withAside.get('[data-test="real-aside"]').text()).toBe('real')
    expect(withAside.get('#fsus-home-main-column').classes()).toEqual(
      expect.arrayContaining(['grow', 'lg:w-2/3'])
    )
    withAside.unmount()
  })

  it('aligns recommendation indices and titles on a shared baseline', () => {
    const wrapper = mount(HomeTextFirstRecommendations, {
      props: { articles: [recommendation(1)] },
      global: homeGlobals
    })

    const link = wrapper.get('a')
    const index = link.findAll('span')[0]
    const title = link.findAll('span')[2]
    const views = link.findAll('span')[3]
    expect(link.classes()).toContain('items-baseline')
    expect(link.classes()).not.toContain('items-start')
    expect(index?.classes()).toEqual(expect.arrayContaining(['leading-5']))
    expect(index?.classes()).not.toContain('mt-1')
    expect(title?.classes()).toEqual(expect.arrayContaining(['leading-5']))
    expect(views?.classes()).toEqual(expect.arrayContaining(['mt-1', 'leading-4']))

    wrapper.unmount()
  })

  it('renders exactly one media lead when its cover exists', () => {
    const wrapper = mount(FeaturedArticlesSection, {
      props: { article: featured('/uploads/lead.webp'), loading: false },
      global: homeGlobals
    })

    expect(wrapper.findAll('[data-home-editorial-lead]')).toHaveLength(1)
    expect(wrapper.get('[data-home-editorial-lead]').attributes('data-home-lead-layout')).toBe('media')
    expect(wrapper.get('[data-content-cover="editorial-lead"]').attributes('data-cover-safe-area')).toBe('center-80')
    expect(wrapper.get('[data-content-cover="editorial-lead"]').classes()).toEqual(
      expect.arrayContaining(['aspect-video', 'md:aspect-[4/3]'])
    )
    expect(wrapper.get('img').attributes('src')).toBe('/uploads/lead.webp')
    expect(wrapper.get('img').classes()).toEqual(
      expect.arrayContaining(['object-cover', 'object-center'])
    )
    expect(wrapper.get('h1').text()).toBe('内容先于站点口号')
    expect(wrapper.text()).not.toContain('阅读全文')

    wrapper.unmount()
  })

  it('falls back to the same complete text hierarchy without a cover', () => {
    const wrapper = mount(FeaturedArticlesSection, {
      props: { article: featured('   '), loading: false },
      global: homeGlobals
    })

    expect(wrapper.get('[data-home-editorial-lead]').attributes('data-home-lead-layout')).toBe('text')
    expect(wrapper.find('[data-content-cover]').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('h1').text()).toBe('内容先于站点口号')
    expect(wrapper.text()).toContain('工程')
    expect(wrapper.text()).toContain('2026-07-11')
    expect(wrapper.get('a').classes()).toEqual(expect.arrayContaining([
      'rounded-[var(--fsusblog-radius-panel)]',
      'pt-8',
      'pb-10'
    ]))
    expect(wrapper.get('a').classes()).not.toEqual(expect.arrayContaining(['border-y', 'py-8', 'sm:py-10']))

    wrapper.unmount()
  })

  it('keeps the same content hierarchy across desktop/mobile and light/dark snapshots', () => {
    const snapshots: Array<Record<string, unknown>> = []

    for (const scenario of [
      { viewport: 'desktop', width: 1440, theme: 'light' },
      { viewport: 'desktop', width: 1440, theme: 'dark' },
      { viewport: 'mobile', width: 390, theme: 'light' },
      { viewport: 'mobile', width: 390, theme: 'dark' }
    ] as const) {
      Object.defineProperty(window, 'innerWidth', { value: scenario.width, configurable: true })
      document.documentElement.classList.toggle('dark', scenario.theme === 'dark')
      const wrapper = mount(FeaturedArticlesSection, {
        props: { article: featured('/uploads/lead.webp'), loading: false },
        global: homeGlobals
      })

      snapshots.push({
        viewport: scenario.viewport,
        theme: scenario.theme,
        leadCount: wrapper.findAll('[data-home-editorial-lead]').length,
        layout: wrapper.get('[data-home-editorial-lead]').attributes('data-home-lead-layout'),
        heading: wrapper.get('h1').text(),
        category: wrapper.text().includes('工程'),
        date: wrapper.text().includes('2026-07-11')
      })
      wrapper.unmount()
    }

    expect(snapshots).toMatchInlineSnapshot(`
      [
        {
          "category": true,
          "date": true,
          "heading": "内容先于站点口号",
          "layout": "media",
          "leadCount": 1,
          "theme": "light",
          "viewport": "desktop",
        },
        {
          "category": true,
          "date": true,
          "heading": "内容先于站点口号",
          "layout": "media",
          "leadCount": 1,
          "theme": "dark",
          "viewport": "desktop",
        },
        {
          "category": true,
          "date": true,
          "heading": "内容先于站点口号",
          "layout": "media",
          "leadCount": 1,
          "theme": "light",
          "viewport": "mobile",
        },
        {
          "category": true,
          "date": true,
          "heading": "内容先于站点口号",
          "layout": "media",
          "leadCount": 1,
          "theme": "dark",
          "viewport": "mobile",
        },
      ]
    `)
  })

  it('uses the title as the only article entry on the home feed while preserving pagination', async () => {
    const wrapper = mount(PublicArticleList, {
      props: {
        items: [card(1)],
        pagination: listView([]).pagination,
        showPagination: true,
        showReadCta: false,
        spaNavigation: true
      },
      global: homeGlobals
    })

    expect(wrapper.findAll('a[data-public-link="article"]')).toHaveLength(1)
    expect(wrapper.get('a[data-public-link="article"]').text()).toBe('Article 1')
    expect(wrapper.text()).not.toContain('阅读')
    expect(wrapper.get('nav').text()).toContain('1 / 2')

    await wrapper.get('[data-aot-action="page-next"]').trigger('click')
    expect(wrapper.emitted('page-next')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps article-list tags centered in a 32px focus-safe hit target', async () => {
    const wrapper = mount(PublicArticleList, {
      props: {
        items: [card(1, [{ label: '#Vue', href: '/filter?tag=7' }])],
        pagination: listView([]).pagination,
        showPagination: false,
        spaNavigation: true
      },
      global: homeGlobals
    })

    const tag = wrapper.get('.public-article-tag')
    expect(tag.classes()).toEqual(expect.arrayContaining([
      'inline-flex',
      'min-h-[32px]',
      'items-center',
      'px-2',
      'focus-visible:ring-2',
      'focus-visible:ring-inset',
      'focus-visible:outline-none'
    ]))
    await tag.trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([['/filter?tag=7']])
    wrapper.unmount()
  })

  it('shows the empty state only when recommendations and the feed are both empty', async () => {
    const emptyStateStub = defineComponent({
      name: 'HomeArticleEmptyState',
      template: '<div data-test="home-empty">empty</div>'
    })
    const wrapper = mount(PublicHomePageContent, {
      props: {
        view: listView([]),
        loading: false,
        isError: false,
        hasRecommendations: false,
        showAside: false,
        showArticleCta: false
      },
      global: {
        stubs: {
          HomeArticleEmptyState: emptyStateStub,
          HomeArticleLoadingState: true,
          HomeArticleErrorState: true,
          HomeFeedSurface: {
            template: '<main><slot name="main" /><slot name="aside" /></main>'
          },
          PublicArticleList: true
        }
      }
    })

    expect(wrapper.find('[data-test="home-empty"]').exists()).toBe(true)
    await wrapper.setProps({ hasRecommendations: true })
    await nextTick()
    expect(wrapper.find('[data-test="home-empty"]').exists()).toBe(false)
    await wrapper.setProps({ view: listView([card(1)]) })
    await nextTick()
    expect(wrapper.get('[data-home-feed-heading]').text()).toBe('最新文章')
    expect(wrapper.get('[data-home-feed-section]').attributes('aria-labelledby')).toBe('home-feed-heading')
    expect(wrapper.get('[data-home-feed-section]').classes()).toEqual(
      expect.arrayContaining(['border-t', 'pt-10'])
    )
    expect(wrapper.get('[data-home-feed-section]').classes()).not.toContain('border-t-2')
    wrapper.unmount()
  })
})
