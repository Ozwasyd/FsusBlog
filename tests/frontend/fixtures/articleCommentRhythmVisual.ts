import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import '@/assets/main.css'
import ArticleCommentsVirtualList from '@/components/article/ArticleCommentsVirtualList.vue'
import ArticleCommentsEmptyState from '@/components/public/ArticleCommentsEmptyState.vue'
import ArticleDetailCommentsPlaceholder from '@/components/public/ArticleDetailCommentsPlaceholder.vue'
import PublicArticleDetailPageContent from '@/components/public/pages/PublicArticleDetailPageContent.vue'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import { activateLocaleRuntime } from '@/locales'
import type { CommentTreeViewNode } from '@/composables/useArticleCommentStream'
import {
  emptyArticleDetailPageView,
  type ArticleDetailPageViewContract
} from '@/view-contracts/articleDetail'

type FixtureState = 'empty' | 'populated' | 'closed' | 'loading' | 'error'

const params = new URL(window.location.href).searchParams
const requestedState = params.get('state')
const state: FixtureState = requestedState === 'populated'
  || requestedState === 'closed'
  || requestedState === 'loading'
  || requestedState === 'error'
  ? requestedState
  : 'empty'
const requestedCount = Number(params.get('count'))
const count = state === 'populated' && [1, 5, 41].includes(requestedCount) ? requestedCount : 0
const isLoggedIn = params.get('auth') === 'logged-in'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'

await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public', 'article'])

document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.themeMode = theme
document.documentElement.dataset.themeResolved = theme

const fixtureHost = document.getElementById('article-comment-rhythm-fixture')
if (!fixtureHost) {
  throw new Error('article_comment_rhythm_fixture_host_missing')
}

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { render: () => null } },
    { path: '/login', component: { render: () => null } }
  ]
})
await router.push('/')
await router.isReady()

const detailView: ArticleDetailPageViewContract = {
  ...emptyArticleDetailPageView,
  header: {
    ...emptyArticleDetailPageView.header,
    id: 1464,
    title: '让评论区只保留真实内容需要的空间',
    viewsText: '1464 浏览',
    meta: {
      ...emptyArticleDetailPageView.header.meta,
      isoTime: '2026-07-24T08:00:00.000Z',
      displayTime: '2026-07-24',
      fullTime: '2026-07-24 16:00:00',
      published: {
        isoTime: '2026-07-24T08:00:00.000Z',
        displayTime: '2026-07-24',
        fullTime: '2026-07-24 16:00:00'
      },
      categoryName: '界面实现'
    }
  },
  body: {
    content: '正文结束后，评论区应按内容自然衔接。',
    notice: { visible: false, wordCount: 20, readingMinutes: 1 }
  }
}

const comments: CommentTreeViewNode[] = Array.from({ length: count }, (_, index) => {
  const id = String(146_400 + index)
  return {
    id,
    content: `第 ${index + 1} 条静态评论，用于验证 populated 节奏。`,
    createTime: '2026-07-24T08:00:00.000Z',
    author: {
      mode: index % 2 === 0 ? 'public' : 'anonymous',
      displayName: index % 2 === 0 ? 'Reader' : 'Anonymous',
      displayLanguage: 'zh-CN',
      badge: null,
      scopeLabel: null
    },
    replyToAuthor: null,
    parentId: null,
    rootId: id,
    replyToCommentId: null,
    depth: 0,
    isDeleted: false,
    isEdited: false,
    childCount: 0,
    hasMoreChildren: false,
    children: [],
    childrenExpanded: false
  }
})

const renderCommentState = () => {
  if (state === 'empty') {
    return h(ArticleCommentsEmptyState, {
      isLoggedIn,
      message: '暂无评论。',
      redirectPath: '/article/1464#comments'
    })
  }
  if (state === 'populated') {
    return h('div', { 'data-fixture-comment-state': state }, [
      h(ArticleCommentsVirtualList, {
        threads: comments,
        isAdmin: false,
        isLoggedIn,
        ownedCommentIds: new Set<string>(),
        loadingReplies: {}
      }),
      h('p', {
        class: 'article-comment-rhythm-fixture__end',
        style: { margin: '0' }
      }, '已显示全部评论')
    ])
  }
  if (state === 'loading') {
    return h(ArticleDetailCommentsPlaceholder, {
      text: '正在加载评论'
    })
  }
  if (state === 'error') {
    return h('p', {
      role: 'alert',
      class: 'article-comment-rhythm-fixture__state',
      style: { margin: '0' }
    }, '评论暂时无法加载，请稍后重试。')
  }
  return h('p', {
    role: 'status',
    class: 'article-comment-rhythm-fixture__state',
    style: { margin: '0' }
  }, '评论已关闭。')
}

const app = createApp({
  render: () => h(PublicBlogLayoutShell, {
    hydrationKind: 'ArticleDetail',
    siteTitle: 'FsusBlog',
    activeNav: 'none',
    authLabel: isLoggedIn ? 'Reader' : '登录',
    authHref: isLoggedIn ? '/user/profile' : '/login',
    renderYear: 2026
  }, {
    default: () => h(PublicArticleDetailPageContent, {
      detailView,
      articleId: 1464,
      authorName: 'Fsu',
      articleSummary: '评论区垂直节奏静态验收',
      hasBodyContent: true,
      linkMode: 'router'
    }, {
      body: () => h('p', {
        class: 'article-comment-rhythm-fixture__body'
      }, detailView.body.content),
      comments: renderCommentState
    })
  })
})

app.use(router)
app.mount(fixtureHost)
await nextTick()

Object.assign(document.documentElement.dataset, {
  articleCommentRhythmFixtureReady: 'true',
  fixtureState: state,
  fixtureCount: String(count),
  fixtureAuth: isLoggedIn ? 'logged-in' : 'anonymous',
  fixtureTheme: theme
})
