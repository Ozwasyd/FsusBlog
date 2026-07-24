import { createApp, defineComponent, h, nextTick } from 'vue'
import '@/assets/main.css'
import FeaturedArticlesSection from '@/components/home/FeaturedArticlesSection.vue'
import HomeTextFirstRecommendations from '@/components/home/HomeTextFirstRecommendations.vue'
import PublicHomePageContent from '@/components/public/pages/PublicHomePageContent.vue'
import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import type { ArticleListCardViewContract, ArticleListViewContract } from '@/view-contracts/articleList'
import contract from './public-home-editorial-contract.json'
import './public-home-editorial-fixture.css'

type FixtureLocale = keyof typeof contract.articles
type FixtureTheme = 'light' | 'dark'
type FixtureCoverMode = 'with-cover' | 'without-cover'

const params = new URL(window.location.href).searchParams
const locale: FixtureLocale = params.get('locale') === 'en-US' ? 'en-US' : 'zh-CN'
const theme: FixtureTheme = params.get('theme') === 'dark' ? 'dark' : 'light'
const coverMode: FixtureCoverMode = params.get('cover') === 'without-cover'
  ? 'without-cover'
  : 'with-cover'
const requestedCount = Number(params.get('count'))
const articleCount = requestedCount === 3 ? 3 : 10
const articles = contract.articles[locale].slice(0, articleCount)

document.documentElement.lang = locale
document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.themeMode = theme
document.documentElement.dataset.themeResolved = theme
document.body.className = 'public-home-editorial-fixture-body'

const fixtureHost = document.getElementById('public-home-editorial-fixture')
if (!fixtureHost) {
  throw new Error('public_home_editorial_fixture_host_missing')
}

const articleHref = (id: number) => `/article/${id}`
const featured: FeaturedArticleItem = {
  id: 1,
  title: articles[0]!.title,
  coverImageUrl: coverMode === 'with-cover' ? '/fixtures/acceptance-cover-primary.svg' : '',
  views: 1250,
  createTime: '2026-07-23T08:00:00.000Z',
  category: { id: 1, name: articles[0]!.category }
}
const recommendationCount = Math.min(articleCount === 3 ? 1 : 4, Math.max(0, articles.length - 1))
const recommendations: PopularArticleSummaryResponse[] = articles
  .slice(1, 1 + recommendationCount)
  .map((article, index) => ({
    id: index + 2,
    title: article.title,
    views: 980 - index * 111
  }))
// The feed is the authoritative current-page article list. Editorial
// recommendations may reuse these articles, but must never consume them.
const feedArticles: ArticleListCardViewContract[] = articles.map((article, index) => {
  const id = index + 1
  return {
    card: { kind: 'article-list-card', index },
    id,
    href: articleHref(id),
    title: article.title,
    summary: article.summary,
    meta: {
      isoTime: `2026-07-${String(22 - index).padStart(2, '0')}T08:00:00.000Z`,
      displayTime: `2026-07-${String(22 - index).padStart(2, '0')}`,
      fullTime: `2026-07-${String(22 - index).padStart(2, '0')} 08:00`,
      categoryName: article.category,
      categoryHref: `/filter?category=${id}`
    },
    tags: [{ label: locale === 'zh-CN' ? '#证据' : '#Evidence', href: `/filter?tag=${id}` }]
  }
})
const view: ArticleListViewContract = {
  items: feedArticles,
  pagination: {
    previous: { label: locale === 'zh-CN' ? '上一页' : 'Previous', disabled: true },
    next: { label: locale === 'zh-CN' ? '下一页' : 'Next', disabled: true },
    indicator: '1 / 1'
  },
  showPagination: false,
  emptyState: { title: locale === 'zh-CN' ? '这里还没有文章' : 'No articles yet' },
  searchKeyword: ''
}

const RouterLinkFixture = defineComponent({
  name: 'RouterLink',
  props: {
    to: { type: String, required: true },
    custom: { type: Boolean, default: false }
  },
  setup(props, { slots }) {
    const navigate = () => {
      const fixtureWindow = window as Window & { __publicHomeFixtureNavigations?: string[] }
      fixtureWindow.__publicHomeFixtureNavigations ??= []
      fixtureWindow.__publicHomeFixtureNavigations.push(props.to)
    }
    return () => slots.default?.({ href: props.to, navigate })
  }
})

const app = createApp({
  render: () => h('main', {
    class: 'public-home-editorial-fixture',
    'aria-label': locale === 'zh-CN' ? '公开首页编辑层级 fixture' : 'Public home editorial fixture'
  }, [
    h(PublicHomePageContent, {
      view,
      loading: false,
      isError: false,
      spaNavigation: true,
      showAside: false,
      hasRecommendations: true,
      showArticleCta: false
    }, {
      featured: () => [
        h(FeaturedArticlesSection, { article: featured, loading: false }),
        h(HomeTextFirstRecommendations, { articles: recommendations })
      ]
    })
  ])
})

app.component('RouterLink', RouterLinkFixture)
app.component('ElIcon', defineComponent({ render: () => h('span') }))
app.component('ElSkeleton', defineComponent({ render: () => h('div') }))
app.component('ElSkeletonItem', defineComponent({ render: () => h('div') }))
app.mount(fixtureHost)

await nextTick()
document.documentElement.dataset.publicHomeFixtureReady = 'true'
