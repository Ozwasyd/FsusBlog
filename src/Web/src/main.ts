import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import '@fontsource/google-sans/latin-400.css'
import '@fontsource/google-sans/latin-500.css'
import '@fontsource/google-sans/latin-700.css'
import '@ozwasyd/element-plus/dist/fsus.css'
import { readThemeMode, syncThemeMode } from '@ozwasyd/element-plus/theme'
import './blog.css'
import App from './App.vue'
import { preloadPublicEntry } from './publicEntry'
import { siteTitle } from './siteBrand'
import { captureInitialSitePage, isSitePageSlug, sitePages } from './sitePageEntry'

const publicListing = () => import('./views/PublicListing.vue')
const editor = () => import('./views/Write.vue')
const canvas = () => import('./views/CanvasWorkspace.vue')
const authorArticles = () => import('./views/AuthorArticles.vue')
const sitePage = () => import('./views/SitePage.vue')
const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', name: 'home', component: publicListing },
    { path: '/archive', name: 'archive', component: publicListing },
    { path: '/search', name: 'search', component: publicListing },
    { path: '/category/:id(\\d+)', name: 'category', component: publicListing },
    { path: '/tag/:id(\\d+)', name: 'tag', component: publicListing },
    { path: '/article/:id(\\d+)', name: 'article', component: () => import('./views/Article.vue') },
    ...Object.keys(sitePages).map(slug => ({ path: '/' + slug, name: slug, component: sitePage })),
    { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
    { path: '/admin/identity', name: 'admin-identity', component: () => import('./views/AdminIdentity.vue') },
    { path: '/subscribe', name: 'subscribe', component: () => import('./views/SubscriptionPreference.vue') },
    { path: '/user/identity/mfa', name: 'security', component: () => import('./views/AccountSecurity.vue') },
    { path: '/user/messagebox', name: 'messages', component: () => import('./views/Messages.vue') },
    { path: '/user/comments', name: 'own-comments', component: () => import('./views/OwnComments.vue') },
    { path: '/user/manage/canvas', name: 'canvas', component: canvas },
    { path: '/user/manage/canvas/:id', name: 'canvas-document', component: canvas },
    { path: '/user/manage/assets', name: 'private-media', component: () => import('./views/PrivateMedia.vue') },
    { path: '/user/manage/article/list', name: 'article-list', component: authorArticles },
    { path: '/user/manage/article/trash', name: 'article-trash', component: authorArticles },
    {
      path: '/user/manage/article',
      component: editor,
      children: [
        { path: 'write', name: 'write', components: {} },
        { path: 'workspace', name: 'article-workspace', components: {} },
        { path: 'edit/:id(\\d+)', name: 'edit', components: {} },
      ],
    },
    { path: '/:missing(.*)*', name: 'missing', component: () => import('./views/NotFound.vue') },
  ],
})
router.afterEach((to, from) => {
  // Canonical metadata belongs to the verified HTML response for its original route.
  if (from.name && to.path !== from.path) document.head.querySelector('link[rel="canonical"]')?.remove()
  const authorInventory = to.name === 'article-list' || to.name === 'article-trash'
  const subscription = to.name === 'subscribe'
  document.documentElement.lang = isSitePageSlug(to.name) || to.name === 'private-media' || authorInventory || subscription ? 'zh-CN' : 'en'
  if (to.name === 'article' && !from.name) return
  const title = isSitePageSlug(to.name) ? sitePages[to.name] : (labels[String(to.name)] ?? 'Article')
  document.title = to.name === 'home' ? siteTitle : `${title} · ${siteTitle}`
  document.querySelector('meta[name="robots"]')?.remove()
  if (isSitePageSlug(to.name) || to.name === 'search' || to.name === 'login' || to.name === 'admin-identity' || to.name === 'messages' || to.name === 'security' ||
      to.name === 'write' || to.name === 'edit' || to.name === 'article-workspace' || to.name === 'canvas' || to.name === 'canvas-document' || to.name === 'private-media' || authorInventory || subscription) {
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = subscription ? 'noindex, nofollow' : 'noindex'
    document.head.append(robots)
  }
})
const labels: Record<string, string> = {
  archive: 'Archive',
  search: 'Search',
  category: 'Category',
  tag: 'Tag',
  login: 'Log in',
  'admin-identity': 'Administrator access',
  subscribe: '订阅偏好',
  messages: '我的站内信',
  'private-media': '资产库',
  security: 'Account security',
  canvas: 'Canvases',
  'canvas-document': 'Canvas',
  write: 'New article',
  'article-workspace': 'Article workspace',
  'article-list': '文章管理',
  'article-trash': '回收站',
  edit: 'Edit article',
  missing: 'Page not found',
}

try { syncThemeMode(readThemeMode()) } catch { syncThemeMode('system') }
const app = createApp(App)
app.use(router)
await router.isReady()
captureInitialSitePage(router.currentRoute.value.name)
await preloadPublicEntry(router.currentRoute.value)
app.mount('#app')
