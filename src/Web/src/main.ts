import { createApp, watch } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import '@fontsource/google-sans/latin-400.css'
import '@fontsource/google-sans/latin-500.css'
import '@fontsource/google-sans/latin-700.css'
import '@ozwasyd/element-plus/dist/fsus.css'
import { readThemeMode, syncThemeMode } from '@ozwasyd/element-plus/theme'
import './blog.css'
import './reading-typography.css'
import App from './App.vue'
import { adminWorkspacePages } from './adminWorkspaceRoutes'
import { preloadPublicEntry } from './publicEntry'
import { siteTitle } from './siteBrand'
import { preloadWorkspaceLocale, siteLocale, t, type MessageKey } from './siteLocale'
import { captureInitialSitePage, isSitePageSlug, sitePages } from './sitePageEntry'

const publicListing = () => import('./views/PublicListing.vue')
const editor = () => import('./views/Write.vue')
const canvas = () => import('./views/CanvasWorkspace.vue')
const sitePage = () => import('./views/SitePage.vue')
const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: (to, from) => to.name === 'archive' && to.path === from.path && (to.hash || from.hash)
    ? false // The browser handles the archive's in-page year anchors.
    : { top: 0 },
  routes: [
    { path: '/', name: 'home', component: publicListing },
    { path: '/archive', name: 'archive', component: publicListing },
    { path: '/search', name: 'search', component: publicListing },
    { path: '/category/:id(\\d+)', name: 'category', component: publicListing },
    { path: '/tag/:id(\\d+)', name: 'tag', component: publicListing },
    { path: '/article/:id(\\d+)', name: 'article', component: () => import('./views/Article.vue') },
    ...Object.keys(sitePages).map(slug => ({ path: '/' + slug, name: slug, component: sitePage })),
    { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
    { path: '/register', name: 'register', component: () => import('./views/ReaderRegister.vue') },
    { path: '/admin', redirect: { name: 'admin-site' } },
    ...adminWorkspacePages.map(({ path, name, section }) => ({
      path, name, component: () => import('./views/AdminIdentity.vue'), meta: { adminSection: section },
    })),
    { path: '/user', redirect: { name: 'security' } },
    { path: '/subscribe', name: 'subscribe', component: () => import('./views/SubscriptionPreference.vue') },
    { path: '/user/identity/mfa', name: 'security', component: () => import('./views/AccountSecurity.vue') },
    { path: '/user/messagebox', name: 'messages', component: () => import('./views/Messages.vue') },
    { path: '/user/comments', name: 'own-comments', component: () => import('./views/OwnComments.vue') },
    { path: '/admin/canvas', name: 'canvas', component: canvas },
    { path: '/admin/canvas/:id', name: 'canvas-document', component: canvas },
    { path: '/admin/assets', name: 'private-media', component: () => import('./views/PrivateMedia.vue') },
    {
      path: '/admin/articles',
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
router.beforeEach(async to => {
  if (to.path.startsWith('/user/') || to.path.startsWith('/admin') || to.meta.adminSection || to.name === 'subscribe')
    await preloadWorkspaceLocale()
})
router.afterEach((to, from) => {
  // Canonical metadata belongs to the verified HTML response for its original route.
  if (from.name && to.path !== from.path) document.head.querySelector('link[rel="canonical"]')?.remove()
  const subscription = to.name === 'subscribe'
  updateDocumentLanguage()
  if (to.name === 'article' && !from.name) return
  updateDocumentTitle(to.name)
  document.querySelector('meta[name="robots"]')?.remove()
  if (isSitePageSlug(to.name) || to.name === 'search' || to.name === 'login' || to.name === 'register' || to.meta.adminSection || to.name === 'messages' || to.name === 'security' ||
      to.name === 'write' || to.name === 'edit' || to.name === 'article-workspace' || to.name === 'canvas' || to.name === 'canvas-document' || to.name === 'private-media' || subscription) {
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = subscription ? 'noindex, nofollow' : 'noindex'
    document.head.append(robots)
  }
})
const labels: Record<string, MessageKey> = {
  ...Object.fromEntries(adminWorkspacePages.map(({ name, label }) => [name, label])),
  archive: 'page.archive',
  search: 'page.search',
  category: 'page.category',
  tag: 'page.tag',
  login: 'page.login',
  register: 'page.register',
  subscribe: 'page.subscribe',
  messages: 'nav.messages',
  'private-media': 'nav.assets',
  security: 'nav.security',
  canvas: 'page.canvas',
  'canvas-document': 'page.canvas-document',
  write: 'page.write',
  'article-workspace': 'page.article-workspace',
  'own-comments': 'page.own-comments',
  edit: 'page.edit',
  missing: 'page.missing',
}

function updateDocumentLanguage() {
  document.documentElement.lang = siteLocale.value
}

function updateDocumentTitle(name: unknown) {
  if (name === 'home') {
    document.title = siteTitle
    return
  }
  const label = isSitePageSlug(name) ? t(`policy.${name}`)
    : t(labels[String(name)] ?? 'page.article')
  document.title = `${label} · ${siteTitle}`
}

watch(siteLocale, () => {
  const name = router.currentRoute.value.name
  updateDocumentLanguage()
  // The author supplies article titles. Never replace one on a language-only change.
  if (name !== 'article') updateDocumentTitle(name)
})

try { syncThemeMode(readThemeMode()) } catch { syncThemeMode('system') }
if (import.meta.env.DEV) {
  void import('./devDebug').then(module => module.installDevAedsInspector())
}
const app = createApp(App)
app.use(router)
await router.isReady()
captureInitialSitePage(router.currentRoute.value.name)
await preloadPublicEntry(router.currentRoute.value)
app.mount('#app')
