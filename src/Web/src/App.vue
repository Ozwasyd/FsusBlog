<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { readThemeMode, subscribeThemeMode, syncThemeMode, writeThemeMode, type ThemeMode } from '@ozwasyd/element-plus/theme'
import { ElConfigProvider, ElPublicShell, ElButton } from '@ozwasyd/element-plus'
import { runSiteViewTransition } from './viewTransition'
import en from '@element-plus/locale/lang/en'
import zhCn from '@element-plus/locale/lang/zh-cn'
import SiteLocaleSelect from './SiteLocaleSelect.vue'
import SiteHeaderPreferences from './SiteHeaderPreferences.vue'
import { siteLocale, t, themeLabels } from './siteLocale'
import SiteAuthLayout from './SiteAuthLayout.vue'
import AccountWorkspace from './AccountWorkspace.vue'
import { currentSession, refreshSession, signOut } from './session'
import { currentSession as currentAuthorSession, hasAdminSessionHint, observeAdminAuth, refreshSession as refreshAuthorSession } from './authorSession'
import { observeSiteRefresh, siteRenewalDelay } from './site-refresh-coordination'
import { isSitePageSlug, sitePages } from './sitePageEntry'
import { consumeFallbackRouteFade, findActiveRouteSurface, focusRouteContent } from './routeTransition'
import { siteTitle } from './siteBrand'
import navigation from '../../Contracts/public-navigation.json' with { type: 'json' }
import { getSiteCompliance, getSiteSeo, type SiteCompliance } from '../../Contracts/site-config.ts'

const route = useRoute()
const router = useRouter()
const siteAuthPage = computed(() => route.name === 'login' || route.name === 'register')
const searchPage = computed(() => route.name === 'search')
const searchQuery = ref('')
function parseThemeMode(value: string | undefined): ThemeMode | undefined {
  return value === 'light' || value === 'dark' || value === 'system' ? value : undefined
}
function tryReadThemeMode(): ThemeMode | undefined {
  try { return readThemeMode() } catch { return undefined }
}
const themeMode = ref<ThemeMode>(parseThemeMode(document.documentElement.dataset.themeMode) ?? 'system')
let persistedTheme: ThemeMode | undefined = themeMode.value
let themePersisted = true
function resolvedThemeFor(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
function applyTheme(mode: ThemeMode) {
  themeMode.value = mode
  try { writeThemeMode(mode) } catch { syncThemeMode(mode) }
}
function reconcileTheme() {
  const root = document.documentElement
  const stored = tryReadThemeMode()
  let next = themeMode.value
  if (stored !== undefined) {
    if (themePersisted) {
      persistedTheme = stored
      next = stored
    } else if (stored !== persistedTheme) {
      persistedTheme = stored
      themePersisted = true
      next = stored
    }
  }
  const nextResolved = resolvedThemeFor(next)
  if (
    themeMode.value === next
    && root.dataset.themeMode === next
    && root.dataset.themeResolved === nextResolved
    && root.style.colorScheme === nextResolved
  ) return
  themeMode.value = next
  syncThemeMode(next)
}
function useTheme(mode: ThemeMode) {
  if (mode === themeMode.value) return
  const currentResolved = document.documentElement.dataset.themeResolved
  if (!currentResolved || currentResolved === resolvedThemeFor(mode)) {
    applyTheme(mode)
    return
  }
  runSiteViewTransition(async () => {
    applyTheme(mode)
    await nextTick()
  }, { name: 'theme-switch' })
}
function selectTheme(mode: string) {
  const parsed = parseThemeMode(mode)
  if (parsed) useTheme(parsed)
}

const logoutFailure = ref(false)
const navCopy = { home: 'nav.home', archive: 'nav.archive', about: 'nav.about' } as const
const publicNavigation = computed(() => navigation.map(({ key, href }) => ({ key, href, label: t(navCopy[key as keyof typeof navCopy]) })))
const publicShellPaths = new Set([...navigation.map(item => item.href), '/login'])

function navigatePublic(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download') || (link.target && link.target !== '_self')) return
  const href = link.getAttribute('href')
  if (href === null || !publicShellPaths.has(href)) return
  event.preventDefault()
  void router.push(href)
}
const adminArea = computed(() => route.meta.adminSection !== undefined)
const adminAuthoringArea = computed(() => route.path.startsWith('/admin/') && route.meta.adminSection === undefined && route.name !== 'missing')
const accountArea = computed(() => route.path.startsWith('/user/') && route.name !== 'missing')
const accountLinks = computed(() => [
  { to: '/', label: t('nav.publicSite') },
  ...(currentSession.value ? [
    { to: '/user/messagebox', label: t('nav.messages') },
    { to: '/user/comments', label: t('page.own-comments') },
    { to: '/user/identity/mfa', label: t('nav.security') },
  ] : []),
])
const authHref = computed(() => (currentSession.value || currentAuthorSession.value) ? '' : '/login')
const authLabel = computed(() => t('nav.login'))
watch(() => route.path, () => {
  searchQuery.value = ''
})

const publicContent = ref<HTMLElement>()
const authLayout = ref<InstanceType<typeof SiteAuthLayout>>()
// Fallback pure-opacity fade when native View Transitions are unavailable.
// Modern browsers run FsusUI's route-crossfade via routeTransition.ts.
watch(() => route.path, (_, previous, cleanup) => {
  if (!previous) return
  if (!consumeFallbackRouteFade()) {
    if (!document.documentElement.dataset.fsusblogTransitioning) focusRouteContent()
    return
  }
  const content = siteAuthPage.value
    ? authLayout.value?.content
    : (publicContent.value ?? findActiveRouteSurface())
  focusRouteContent()
  if (!content || typeof content.animate !== 'function') return
  const animation = content.animate([
    { opacity: 0 },
    { opacity: 1 },
  ], { duration: 220, easing: 'cubic-bezier(0, 0, 0.2, 1)' })
  cleanup(() => animation.cancel())
}, { flush: 'post' })

const lifetime = new AbortController()
const compliance = ref<SiteCompliance>()
const siteAuthor = ref(document.head.querySelector<HTMLMetaElement>('meta[name="author"]')?.content || undefined)
const legal = computed(() => compliance.value?.enabled ? compliance.value : undefined)
const year = new Date().getFullYear()
const copyright = computed(() => {
  const value = legal.value
  const start = value?.copyrightStartYear
  const years = start && start < year ? `${start}–${year}` : year
  const owner = value?.copyrightOwner || siteAuthor.value
  return ['©', years, owner, value?.copyrightText || t('nav.rightsReserved')].filter(Boolean).join(' ')
})
function publicLink(value: string) {
  const url = URL.parse(value)
  return url?.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
}
function contactLink(value: string) {
  return /^[A-Za-z0-9._+@-]+$/.test(value) ? `mailto:${value}` : undefined
}
const sync = () => {
  if (adminArea.value) return
  if (adminAuthoringArea.value) {
    void refreshAuthorSession(lifetime.signal).catch(() => {})
    return
  }
  void refreshSession(lifetime.signal).catch(() => {})
  if (hasAdminSessionHint()) void refreshAuthorSession(lifetime.signal).catch(() => {})
}
const whenVisible = () => { if (document.visibilityState === 'visible') sync() }
const onPageShow = () => {
  reconcileTheme()
  sync()
}
const onVisibilityChange = () => {
  if (document.visibilityState !== 'visible') return
  reconcileTheme()
  sync()
}
const onWindowFocus = () => {
  reconcileTheme()
}
const onStorage = (event: StorageEvent) => {
  try {
    if (event.storageArea && event.storageArea !== window.localStorage) return
  } catch {
    return
  }
  reconcileTheme()
}
let stopThemeMode: (() => void) | undefined
let stopSiteRefresh: (() => void) | undefined
let stopAdminAuth: (() => void) | undefined
watch([() => currentSession.value?.siteRefresh, () => currentSession.value?.expiresAt, () => adminArea.value, () => adminAuthoringArea.value],
  ([mode, expiresAt, admin, authoring], _, cleanup) => {
    if (mode !== 'persistent' || expiresAt === undefined || admin || authoring) return
    const timer = setTimeout(whenVisible, siteRenewalDelay(expiresAt))
    cleanup(() => clearTimeout(timer))
  })
watch([adminArea, adminAuthoringArea], ([admin, authoring], [prevAdmin, prevAuthoring]) => {
  if (admin !== prevAdmin || authoring !== prevAuthoring) sync()
})
watch(() => route.name, (name, _, cleanup) => {
  if (!name || accountArea.value || siteAuthPage.value || adminArea.value || adminAuthoringArea.value) return
  const request = new AbortController()
  cleanup(() => request.abort())
  if (siteAuthor.value === undefined) void getSiteSeo(request.signal).then(value => {
    if (!request.signal.aborted) siteAuthor.value = value.author
  }).catch(() => {})
  if (!compliance.value) void getSiteCompliance(request.signal).then(value => {
    if (!request.signal.aborted) compliance.value = value
  }).catch(() => {})
}, { immediate: true })
onMounted(() => {
  stopThemeMode = subscribeThemeMode(detail => {
    themeMode.value = detail.mode
    const stored = tryReadThemeMode()
    if (stored !== undefined) {
      persistedTheme = stored
      themePersisted = stored === detail.mode
    } else {
      themePersisted = false
    }
  })
  reconcileTheme()
  stopSiteRefresh = observeSiteRefresh(() => {
    if (!adminArea.value && !adminAuthoringArea.value) void refreshSession(lifetime.signal, false).catch(() => {})
  })
  stopAdminAuth = observeAdminAuth(() => {
    if (adminAuthoringArea.value || (!adminArea.value && hasAdminSessionHint()))
      void refreshAuthorSession(lifetime.signal, false).catch(() => {})
  })
  sync()
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('storage', onStorage)
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onUnmounted(() => {
  lifetime.abort()
  stopThemeMode?.()
  stopSiteRefresh?.()
  stopAdminAuth?.()
  window.removeEventListener('pageshow', onPageShow)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('storage', onStorage)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

function search(value: string) {
  const query = value.trim()
  searchQuery.value = ''
  void router.push({ name: 'search', query: query ? { q: query } : {} })
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
  <ElConfigProvider :locale="siteLocale === 'zh-CN' ? zhCn : en">
  <SiteAuthLayout v-if="siteAuthPage" ref="authLayout" :theme-mode="themeMode" @theme="useTheme">
    <RouterView />
  </SiteAuthLayout>
  <RouterView v-else-if="adminArea" v-slot="{ Component }">
    <component :is="Component" :theme-mode="themeMode" @theme="useTheme" />
  </RouterView>
  <RouterView v-else-if="adminAuthoringArea" />
  <AccountWorkspace v-else-if="accountArea" home="/user" :label="t('nav.accountMenu')" :links="accountLinks"
    :theme-mode="themeMode" @theme="useTheme">
    <template #actions>
      <ElButton v-if="currentSession || logoutFailure" text @click="leave">{{ t('nav.logout') }}</ElButton>
      <RouterLink v-else class="site-header-text-action" to="/login">{{ t('nav.login') }}</RouterLink>
    </template>
    <RouterView />
  </AccountWorkspace>
  <div v-else @click="navigatePublic">
    <a class="skip-link" href="#page-content">{{ t('nav.skip') }}</a>
    <ElPublicShell class="blog-public-shell"
      :brand="siteTitle"
      :nav-items="publicNavigation"
      :active-nav="String(route.name ?? '')"
      active-nav-motion="indicator"
      :show-search="!searchPage"
      :desktop-search-mode="searchPage ? 'none' : 'trigger'"
      :search-aria-label="t('nav.search')"
      :search-placeholder="t('nav.search')"
      :mobile-nav-label="t('nav.primary')"
      :mobile-nav-menu-label="t('nav.menu')"
      :mobile-search-trigger-label="t('nav.search')"
      :mobile-search-cancel-label="t('nav.cancel')"
      :mobile-search-mode="searchPage ? 'none' : 'trigger'"
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
        <SiteHeaderPreferences :theme-mode="themeMode" @theme="useTheme" />
        <RouterLink v-if="currentAuthorSession" class="site-header-text-action" to="/admin/site">{{ t('nav.admin') }}</RouterLink>
        <RouterLink v-if="currentSession" class="site-header-text-action" to="/user/messagebox">{{ t('nav.messages') }}</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'security'" class="site-header-text-action" to="/user/identity/mfa">{{ t('nav.security') }}</RouterLink>
      </template>
      <template #mobile-primary-actions>
        <RouterLink v-if="currentAuthorSession" class="site-header-text-action" to="/admin/site">{{ t('nav.admin') }}</RouterLink>
        <RouterLink v-if="currentSession" class="site-header-text-action" to="/user/messagebox">{{ t('nav.messages') }}</RouterLink>
        <RouterLink v-if="currentSession && route.name !== 'security'" class="site-header-text-action" to="/user/identity/mfa">{{ t('nav.security') }}</RouterLink>
        <div class="public-menu-preferences">
          <SiteLocaleSelect />
          <select class="site-theme-select" :aria-label="t('theme.label')" :value="themeMode"
            @change="selectTheme(($event.target as HTMLSelectElement).value)">
            <option value="light">{{ themeLabels.light }}</option>
            <option value="dark">{{ themeLabels.dark }}</option>
            <option value="system">{{ themeLabels.system }}</option>
          </select>
        </div>
      </template>
      <div id="page-content" ref="publicContent" tabindex="-1">
        <div v-if="logoutFailure" class="reading-column editor-shell-error" role="alert">
          {{ t('nav.logoutFailed') }}
          <ElButton text @click="leave">{{ t('nav.retry') }}</ElButton>
        </div>
        <RouterView />
      </div>
      <template #footer>
        <div class="reading-column site-footer">
          <div class="site-footer-identity">
            <strong>{{ siteTitle }}</strong>
            <p>{{ copyright }}</p>
          </div>
          <div class="site-footer-links">
            <div v-if="legal" class="site-policy-links" :aria-label="t('nav.compliance')">
              <a v-if="legal.contentLicenseName && publicLink(legal.contentLicenseUrl)" :href="publicLink(legal.contentLicenseUrl)">{{ legal.contentLicenseName }}</a>
              <span v-else-if="legal.contentLicenseName">{{ legal.contentLicenseName }}</span>
              <template v-if="legal.regionMode === 'mainland-cn'">
                <a v-if="legal.icpRecordNumber && publicLink(legal.icpRecordUrl)" :href="publicLink(legal.icpRecordUrl)">{{ legal.icpRecordNumber }}</a>
                <a v-if="legal.policeRecordNumber && publicLink(legal.policeRecordUrl)" :href="publicLink(legal.policeRecordUrl)">{{ legal.policeRecordNumber }}</a>
              </template>
              <span v-if="legal.operatorName">{{ legal.operatorName }}</span>
              <a v-if="legal.contactEmail && contactLink(legal.contactEmail)" :href="contactLink(legal.contactEmail)">{{ legal.contactEmail }}</a>
            </div>
            <nav class="site-policy-links" :aria-label="t('nav.policies')">
              <RouterLink v-for="(_, slug) in sitePages" :key="slug" :to="{ name: slug }">{{ t(`policy.${slug}`) }}</RouterLink>
              <a href="#">{{ t('nav.top') }}</a>
            </nav>
          </div>
        </div>
      </template>
    </ElPublicShell>
  </div>
  </ElConfigProvider>
</template>

<style scoped>
.public-menu-preferences {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .5rem;
  padding: .375rem;
}
.public-menu-preferences > select { min-inline-size: 0; inline-size: 100%; }
.site-policy-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: .5rem 1rem;
}
</style>
