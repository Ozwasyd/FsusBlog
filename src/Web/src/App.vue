<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { writeThemeMode, type ThemeMode } from '@ozwasyd/element-plus/theme'
import { ElPublicShell, ElSiteHeader, ElThemeModeToggle, ElButton } from '@ozwasyd/element-plus'
import { currentSession, refreshSession, signOut } from './session'
import { isSitePageSlug, sitePages } from './sitePageEntry'

const route = useRoute()
const router = useRouter()
const searchQuery = ref('')
const themeMode = ref<ThemeMode>()
const selected = document.documentElement.dataset.themeMode
if (selected === 'light' || selected === 'dark' || selected === 'system') themeMode.value = selected
function useTheme(mode: ThemeMode) {
  themeMode.value = mode
  try { writeThemeMode(mode) } catch { /* Theme remains selectable if storage is unavailable. */ }
}
const logoutFailure = ref(false)
const navigation = [
  { key: 'home', label: 'Home', href: '/' },
  { key: 'archive', label: 'Archive', href: '/archive' },
  { key: 'about', label: sitePages.about, href: '/about' },
]
const accountArea = computed(() => route.name === 'write' || route.name === 'edit' || route.name === 'article-workspace' ||
  route.name === 'messages' || route.name === 'security' || route.name === 'private-media')
const ownerPath = '/user/manage/article/write'
const authHref = computed(() => currentSession.value?.canAuthor ? ownerPath : '/login')
const authLabel = computed(() => currentSession.value?.canAuthor ? 'Write' : 'Log in')
watch(() => route.query.q, value => {
  searchQuery.value = typeof value === 'string' ? value : ''
}, { immediate: true })

const lifetime = new AbortController()
const sync = () => { void refreshSession(lifetime.signal).catch(() => {}) }
const whenVisible = () => { if (document.visibilityState === 'visible') sync() }
onMounted(() => {
  sync()
  window.addEventListener('pageshow', sync)
  document.addEventListener('visibilitychange', whenVisible)
})
onUnmounted(() => {
  lifetime.abort()
  window.removeEventListener('pageshow', sync)
  document.removeEventListener('visibilitychange', whenVisible)
})

function search(value: string) {
  void router.push({ name: 'search', query: value.trim() ? { q: value.trim() } : {} })
}

async function leave() {
  logoutFailure.value = false
  try {
    if (route.name !== 'home' && await router.replace('/')) return
    await signOut(lifetime.signal)
  } catch {
    logoutFailure.value = true
  }
}
</script>

<template>
  <RouterView v-if="route.name === 'login'" v-slot="{ Component }">
    <component :is="Component" :theme-mode="themeMode" @theme="useTheme" />
  </RouterView>
  <div v-else-if="accountArea" class="workspace">
    <ElSiteHeader max-width="64rem">
      <template #brand><RouterLink class="workspace-brand" to="/">Fsu's Blog</RouterLink></template>
      <template #desktop-actions>
        <RouterLink to="/">Public site</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'messages'" to="/user/messagebox">站内信</RouterLink>
        <RouterLink v-if="currentSession?.canAuthor && route.name !== 'private-media'" to="/user/manage/assets">资产库</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'security'" to="/user/identity/mfa">Account security</RouterLink>
        <ElThemeModeToggle :model-value="themeMode" variant="menu-button" @update:model-value="useTheme" />
        <ElButton v-if="currentSession || logoutFailure" text @click="leave">Log out</ElButton>
        <RouterLink v-else to="/login">Log in</RouterLink>
      </template>
      <template #mobile-primary-actions>
        <RouterLink v-if="currentSession && route.name !== 'messages'" to="/user/messagebox">站内信</RouterLink>
        <RouterLink v-if="currentSession?.canAuthor && route.name !== 'private-media'" to="/user/manage/assets">资产库</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'security'" to="/user/identity/mfa">Account security</RouterLink>
        <ElThemeModeToggle :model-value="themeMode" variant="menu-button" @update:model-value="useTheme" />
        <ElButton v-if="currentSession || logoutFailure" text @click="leave">Log out</ElButton>
        <RouterLink v-else to="/login">Log in</RouterLink>
      </template>
    </ElSiteHeader>
    <RouterView />
  </div>
  <template v-else>
    <a class="skip-link" href="#page-content">Skip to content</a>
    <ElPublicShell
      brand="Fsu's Blog"
      :nav-items="navigation"
      :active-nav="String(route.name ?? '')"
      active-nav-motion="indicator"
      desktop-search-mode="trigger"
      mobile-search-mode="trigger"
      :auth-href="authHref"
      :auth-label="authLabel"
      v-model:search-query="searchQuery"
      max-width="64rem"
      :content-flow="route.name === 'article' || isSitePageSlug(route.name) ? 'content-driven' : 'viewport-stable'"
      sticky
      csp-safe
      spa-search
      @search="search"
    >
      <template #desktop-actions>
        <RouterLink v-if="currentSession" to="/user/messagebox">站内信</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'security'" to="/user/identity/mfa">Account security</RouterLink>
        <ElThemeModeToggle :model-value="themeMode" variant="menu-button" @update:model-value="useTheme" />
      </template>
      <template #mobile-primary-actions>
        <RouterLink v-if="currentSession" to="/user/messagebox">站内信</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'security'" to="/user/identity/mfa">Account security</RouterLink>
        <ElThemeModeToggle :model-value="themeMode" variant="menu-button" @update:model-value="useTheme" />
      </template>
      <div id="page-content" tabindex="-1">
        <div v-if="logoutFailure" class="reading-column editor-shell-error" role="alert">
          The server did not confirm logout.
          <ElButton text @click="leave">Try again</ElButton>
        </div>
        <RouterView />
      </div>
      <template #footer>
        <div class="site-footer">
          <strong>Fsu's Blog</strong>
          <p>© {{ new Date().getFullYear() }} Fsu's Blog. All rights reserved.</p>
          <nav class="site-policy-links" aria-label="站点政策">
            <RouterLink v-for="(label, slug) in sitePages" :key="slug" :to="{ name: slug }">{{ label }}</RouterLink>
          </nav>
          <a href="#">Top</a>
        </div>
      </template>
    </ElPublicShell>
  </template>
</template>

<style scoped>
.site-policy-links {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem 1rem;
}
</style>
