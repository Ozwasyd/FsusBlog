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
import { captureInitialSitePage, isSitePageSlug, sitePages } from './sitePageEntry'

const publicListing = () => import('./views/PublicListing.vue')
const editor = () => import('./views/Write.vue')
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
    { path: '/user/identity/mfa', name: 'security', component: () => import('./views/AccountSecurity.vue') },
    { path: '/user/messagebox', name: 'messages', component: () => import('./views/Messages.vue') },
    { path: '/user/manage/article/write', name: 'write', component: editor },
    { path: '/user/manage/article/edit/:id(\\d+)', name: 'edit', component: editor },
    { path: '/:missing(.*)*', name: 'missing', component: () => import('./views/NotFound.vue') },
  ],
})
router.afterEach((to, from) => {
  document.documentElement.lang = isSitePageSlug(to.name) ? 'zh-CN' : 'en'
  if (to.name === 'article' && !from.name) return
  const title = isSitePageSlug(to.name) ? sitePages[to.name] : (labels[String(to.name)] ?? 'Article')
  document.title = to.name === 'home' ? "Fsu's Blog" : `${title} · Fsu's Blog`
  document.querySelector('meta[name="robots"]')?.remove()
  if (isSitePageSlug(to.name) || to.name === 'search' || to.name === 'login' || to.name === 'messages' || to.name === 'security' || to.name === 'write' || to.name === 'edit') {
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = 'noindex'
    document.head.append(robots)
  }
})
const labels: Record<string, string> = {
  archive: 'Archive',
  search: 'Search',
  category: 'Category',
  tag: 'Tag',
  login: 'Log in',
  messages: '我的站内信',
  security: 'Account security',
  write: 'New article',
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
