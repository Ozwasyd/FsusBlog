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

const publicListing = () => import('./views/PublicListing.vue')
const editor = () => import('./views/Write.vue')
const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', name: 'home', component: publicListing },
    { path: '/archive', name: 'archive', component: publicListing },
    { path: '/search', name: 'search', component: publicListing },
    { path: '/article/:id(\\d+)', name: 'article', component: () => import('./views/Article.vue') },
    { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
    { path: '/user/manage/article/write', name: 'write', component: editor },
    { path: '/user/manage/article/edit/:id(\\d+)', name: 'edit', component: editor },
    { path: '/:missing(.*)*', name: 'missing', component: () => import('./views/NotFound.vue') },
  ],
})
router.afterEach((to, from) => {
  if (to.name === 'article' && !from.name) return
  document.title = to.name === 'home' ? "Fsu's Blog" : `${labels[String(to.name)] ?? 'Article'} · Fsu's Blog`
  document.querySelector('meta[name="robots"]')?.remove()
  if (to.name === 'search' || to.name === 'login' || to.name === 'write' || to.name === 'edit') {
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = 'noindex'
    document.head.append(robots)
  }
})
const labels: Record<string, string> = {
  archive: 'Archive',
  search: 'Search',
  login: 'Log in',
  write: 'New article',
  edit: 'Edit article',
  missing: 'Page not found',
}

try { syncThemeMode(readThemeMode()) } catch { syncThemeMode('system') }
const app = createApp(App)
app.use(router)
await router.isReady()
await preloadPublicEntry(router.currentRoute.value)
app.mount('#app')
