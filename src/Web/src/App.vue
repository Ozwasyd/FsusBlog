<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { writeThemeMode, type ThemeMode } from '@ozwasyd/element-plus/theme'
import { ElPublicShell, ElSiteHeader, ElThemeModeToggle, ElButton, ElDrawer } from '@ozwasyd/element-plus'
import SiteAuthLayout from './SiteAuthLayout.vue'
import { currentSession, refreshSession, signOut } from './session'
import { observeSiteRefresh, siteRenewalDelay } from './site-refresh-coordination'
import { isSitePageSlug, sitePages } from './sitePageEntry'
import { siteTitle } from './siteBrand'
import navigation from '../../Contracts/public-navigation.json' with { type: 'json' }
import { getSiteCompliance, type SiteCompliance } from '../../Contracts/site-config.ts'

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
const accountMenu = ref(false)
const publicNavPaths = new Set(navigation.map(item => item.href))

function navigatePublic(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download') || (link.target && link.target !== '_self')) return
  const href = link.getAttribute('href')
  if (href === null || !publicNavPaths.has(href)) return
  event.preventDefault()
  void router.push(href)
}
const accountArea = computed(() => route.name === 'canvas' || route.name === 'canvas-document' || route.name === 'write' || route.name === 'edit' || route.name === 'article-workspace' ||
  route.name === 'article-list' || route.name === 'article-search' || route.name === 'article-trash' || route.name === 'messages' ||
  route.name === 'security' || route.name === 'private-media')
const articleCollection = computed(() => route.name === 'article-list' || route.name === 'article-search' || route.name === 'article-trash')
const ownerPath = '/user/manage/article/write'
const authHref = computed(() => currentSession.value?.canAuthor ? ownerPath : '/login')
const authLabel = computed(() => currentSession.value?.canAuthor ? '写文章' : '登录')
watch(() => route.query.q, value => {
  searchQuery.value = typeof value === 'string' ? value : ''
}, { immediate: true })
watch(() => route.fullPath, () => { accountMenu.value = false })

const lifetime = new AbortController()
const compliance = ref<SiteCompliance>()
const legal = computed(() => compliance.value?.enabled ? compliance.value : undefined)
const year = new Date().getFullYear()
const copyright = computed(() => {
  const value = legal.value
  if (!value) return `© ${year} ${siteTitle}. All rights reserved.`
  const start = value.copyrightStartYear
  const years = start && start < year ? `${start}–${year}` : year
  return `© ${years} ${value.copyrightOwner || siteTitle}${value.copyrightText ? ` ${value.copyrightText}` : ''}`
})
function publicLink(value: string) {
  const url = URL.parse(value)
  return url?.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
}
function contactLink(value: string) {
  return /^[A-Za-z0-9._+@-]+$/.test(value) ? `mailto:${value}` : undefined
}
const sync = () => { if (route.name !== 'admin-identity') void refreshSession(lifetime.signal).catch(() => {}) }
const whenVisible = () => { if (document.visibilityState === 'visible') sync() }
let stopSiteRefresh: (() => void) | undefined
watch([() => currentSession.value?.siteRefresh, () => currentSession.value?.expiresAt, () => route.name === 'admin-identity'],
  ([mode, expiresAt, admin], _, cleanup) => {
    if (mode !== 'persistent' || expiresAt === undefined || admin) return
    const timer = setTimeout(whenVisible, siteRenewalDelay(expiresAt))
    cleanup(() => clearTimeout(timer))
  })
watch(() => route.name, (name, _, cleanup) => {
  if (!name || accountArea.value || name === 'login' || name === 'admin-identity' || compliance.value) return
  const request = new AbortController()
  cleanup(() => request.abort())
  void getSiteCompliance(request.signal).then(value => {
    if (!request.signal.aborted) compliance.value = value
  }).catch(() => {})
}, { immediate: true })
onMounted(() => {
  stopSiteRefresh = observeSiteRefresh(() => {
    if (route.name !== 'admin-identity') void refreshSession(lifetime.signal, false).catch(() => {})
  })
  sync()
  window.addEventListener('pageshow', sync)
  document.addEventListener('visibilitychange', whenVisible)
})
onUnmounted(() => {
  lifetime.abort()
  stopSiteRefresh?.()
  window.removeEventListener('pageshow', sync)
  document.removeEventListener('visibilitychange', whenVisible)
})

function search(value: string) {
  void router.push({ name: 'search', query: value.trim() ? { q: value.trim() } : {} })
}

async function leave() {
  accountMenu.value = false
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
  <SiteAuthLayout v-if="route.name === 'login'" :theme-mode="themeMode" @theme="useTheme">
    <RouterView />
  </SiteAuthLayout>
  <RouterView v-else-if="route.name === 'admin-identity'" />
  <div v-else-if="accountArea" class="workspace">
    <ElSiteHeader max-width="64rem">
      <template #brand><RouterLink class="workspace-brand" to="/">{{ siteTitle }}</RouterLink></template>
      <template #desktop-actions>
        <RouterLink to="/">Public site</RouterLink>
        <RouterLink v-if="currentSession?.canAuthor && !articleCollection" :to="{ name: 'article-list' }">文章管理</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'messages'" to="/user/messagebox">站内信</RouterLink>
        <RouterLink v-if="currentSession?.canAuthor && route.name !== 'private-media'" to="/user/manage/assets">资产库</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'security'" to="/user/identity/mfa">Account security</RouterLink>
        <ElThemeModeToggle :model-value="themeMode" variant="menu-button" @update:model-value="useTheme" />
        <ElButton v-if="currentSession || logoutFailure" text @click="leave">Log out</ElButton>
        <RouterLink v-else to="/login">Log in</RouterLink>
      </template>
      <template #mobile-overflow-trigger>
        <ElButton class="workspace-menu-button" v-bind="{ 'aria-haspopup': 'dialog', 'aria-expanded': accountMenu }" @click="accountMenu = true">
          Account menu
        </ElButton>
      </template>
    </ElSiteHeader>
    <ElDrawer v-model="accountMenu" title="Account menu" direction="rtl" size="min(22rem, 100%)" append-to-body>
      <nav class="workspace-menu" aria-label="Account navigation">
        <RouterLink to="/" @click="accountMenu = false">Public site</RouterLink>
        <RouterLink v-if="currentSession?.canAuthor && !articleCollection" :to="{ name: 'article-list' }" @click="accountMenu = false">文章管理</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'messages'" to="/user/messagebox" @click="accountMenu = false">站内信</RouterLink>
        <RouterLink v-if="currentSession?.canAuthor && route.name !== 'private-media'" to="/user/manage/assets" @click="accountMenu = false">资产库</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'security'" to="/user/identity/mfa" @click="accountMenu = false">Account security</RouterLink>
        <ElThemeModeToggle :model-value="themeMode" variant="menu-button" @update:model-value="useTheme" />
        <ElButton v-if="currentSession || logoutFailure" text @click="leave">Log out</ElButton>
        <RouterLink v-else to="/login" @click="accountMenu = false">Log in</RouterLink>
      </nav>
    </ElDrawer>
    <RouterView />
  </div>
  <div v-else @click="navigatePublic">
    <a class="skip-link" href="#page-content">跳到正文</a>
    <ElPublicShell
      :brand="siteTitle"
      :nav-items="navigation"
      :active-nav="String(route.name ?? '')"
      active-nav-motion="indicator"
      desktop-search-mode="trigger"
      search-aria-label="搜索"
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
          <strong>{{ siteTitle }}</strong>
          <p>{{ copyright }}</p>
          <div v-if="legal" class="site-policy-links" aria-label="站点合规">
            <a v-if="legal.contentLicenseName && publicLink(legal.contentLicenseUrl)" :href="publicLink(legal.contentLicenseUrl)">{{ legal.contentLicenseName }}</a>
            <span v-else-if="legal.contentLicenseName">{{ legal.contentLicenseName }}</span>
            <template v-if="legal.regionMode === 'mainland-cn'">
              <a v-if="legal.icpRecordNumber && publicLink(legal.icpRecordUrl)" :href="publicLink(legal.icpRecordUrl)">{{ legal.icpRecordNumber }}</a>
              <a v-if="legal.policeRecordNumber && publicLink(legal.policeRecordUrl)" :href="publicLink(legal.policeRecordUrl)">{{ legal.policeRecordNumber }}</a>
            </template>
            <span v-if="legal.operatorName">{{ legal.operatorName }}</span>
            <a v-if="legal.contactEmail && contactLink(legal.contactEmail)" :href="contactLink(legal.contactEmail)">{{ legal.contactEmail }}</a>
          </div>
          <nav class="site-policy-links" aria-label="站点政策">
            <RouterLink v-for="(label, slug) in sitePages" :key="slug" :to="{ name: slug }">{{ label }}</RouterLink>
          </nav>
          <a href="#">Top</a>
        </div>
      </template>
    </ElPublicShell>
  </div>
</template>

<style scoped>
.workspace-brand {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.workspace-menu-button { min-height: 44px; }
.workspace-menu {
  display: grid;
  justify-items: start;
  gap: var(--fsus-space-3);
}
.workspace-menu > a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
}
.site-policy-links {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem 1rem;
}
</style>
