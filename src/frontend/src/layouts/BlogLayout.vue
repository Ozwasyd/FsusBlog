<template>
  <PublicBlogLayoutShell
    v-bind="shellState"
    :spa-navigation="isMounted"
    @navigate="handleNavigate"
    @search="handleSearch"
    @search-focus="handleSearchFocus"
  >
    <router-view v-slot="{ Component }">
      <component :is="Component" :key="route.fullPath" />
    </router-view>
  </PublicBlogLayoutShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'
import { runtimeReady } from '@/bootstrap/runtimeGate'
import { publicActivationState } from '@/bootstrap/publicActivationRuntime'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import {
  isPublicSearchRouteName,
  resolvePublicPageKind
} from '@/public-renderers/publicPageModel'
import { PUBLIC_SEARCH_ROUTE_NAME } from '@/public-renderers/publicRouteRegistry'
import { normalizePublicSearchKeyword } from '@/public-renderers/publicSearchRoutePolicy'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'
import { createPublicTakeoverSeed } from '@/public-renderers/publicSiteIdentity'
import { createPublicSiteIdentity } from '@/public-renderers/publicSiteIdentityContext'
import { DEFAULT_SITE_OG_IMAGE } from '@/store/site'

const { siteStore, ensurePublicShell } = useSessionBootstrap()
const router = useRouter()
const route = useRoute()
const takeoverShellSeed = createPublicTakeoverSeed(readPublicHydrationPayload())
// Hydration invariant: runtime shell state remains SSR-compatible until auth and store-backed controls can update after mount.
const isMounted = ref(false)
const runtimeRenderYear = ref<number | null>(takeoverShellSeed?.renderYear ?? null)

onMounted(() => {
  isMounted.value = true
  runtimeRenderYear.value = new Date().getFullYear()
  // Defer site info loading to avoid hydration mismatch
  // Public shell bootstrap must stay account-probe free; auth is verified by explicit protected routes/actions.
  setTimeout(() => {
    void ensurePublicShell()
  }, 600)
})

const hydrationKind = computed(() => {
  return resolvePublicPageKind(route.name)
})

const isSearchRoute = computed(() => isPublicSearchRouteName(route.name))
const shouldUseTakeoverShellSeed = computed(() => takeoverShellSeed !== null && publicActivationState.value.phase !== 'interactive')
const activeSiteIdentity = computed(() => createPublicSiteIdentity({
  siteTitle: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteTitle : siteStore.siteInfo.title,
  siteDescription: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteDescription : siteStore.siteInfo.description,
  siteLogoUrl: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteLogoUrl : siteStore.siteInfo.siteLogoUrl,
  siteLogoDarkUrl: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteLogoDarkUrl : siteStore.siteInfo.siteLogoDarkUrl,
  siteWordmarkUrl: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteWordmarkUrl : siteStore.siteInfo.siteWordmarkUrl,
  compliance: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.compliance : siteStore.complianceInfo,
  renderYear: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.renderYear : runtimeRenderYear.value
}))

const shellState = computed(() => createPublicShellViewState({
  hydrationKind: hydrationKind.value,
  siteTitle: activeSiteIdentity.value.siteTitle,
  siteDescription: activeSiteIdentity.value.siteDescription,
  siteLogoUrl: activeSiteIdentity.value.siteLogoUrl,
  siteLogoDarkUrl: activeSiteIdentity.value.siteLogoDarkUrl,
  siteWordmarkUrl: activeSiteIdentity.value.siteWordmarkUrl,
  compliance: activeSiteIdentity.value.compliance,
  renderYear: activeSiteIdentity.value.renderYear,
  isSearchRoute: isSearchRoute.value,
  initialSearchQuery: isSearchRoute.value ? String(route.query.q || '') : '',
  spaSearch: isMounted.value && runtimeReady.value,
  showRuntime: isMounted.value && runtimeReady.value,
}))

function syncPublicDocumentHead(): void {
  if (typeof document === 'undefined') {
    return
  }
  syncDefaultBrandHeadAssets()
}

function syncLinkElement(selector: string, rel: string, href: string, attributes: Record<string, string> = {}): void {
  if (!href) {
    return
  }

  let link = document.querySelector<HTMLLinkElement>(selector)
  if (!link) {
    link = document.createElement('link')
    link.setAttribute('rel', rel)
    link.dataset.fsusDefaultBrand = 'true'
    document.head.appendChild(link)
  }

  link.setAttribute('href', href)
  for (const [name, value] of Object.entries(attributes)) {
    link.setAttribute(name, value)
  }
}

function syncMetaElement(selector: string, attributes: Record<string, string>, content: string, overwriteExisting = true): void {
  if (!content) {
    return
  }

  let meta = document.querySelector<HTMLMetaElement>(selector)
  if (!meta) {
    meta = document.createElement('meta')
    meta.dataset.fsusDefaultBrand = 'true'
    for (const [name, value] of Object.entries(attributes)) {
      meta.setAttribute(name, value)
    }
    document.head.appendChild(meta)
  }

  if (overwriteExisting || meta.dataset.fsusDefaultBrand === 'true') {
    meta.setAttribute('content', content)
  }
}

function syncDefaultBrandHeadAssets(): void {
  const siteInfo = siteStore.siteInfo
  syncLinkElement('link[rel~="icon"][type="image/svg+xml"]', 'icon', siteInfo.faviconSvgUrl, { type: 'image/svg+xml' })
  syncLinkElement('link[rel~="icon"][type="image/x-icon"]', 'icon', siteInfo.faviconIcoUrl, { type: 'image/x-icon' })
  syncLinkElement('link[rel~="icon"][type="image/png"]', 'icon', siteInfo.faviconPngUrl, { type: 'image/png', sizes: '32x32' })
  syncLinkElement('link[rel="apple-touch-icon"]', 'apple-touch-icon', siteInfo.appleTouchIconUrl, { sizes: '180x180' })
  syncMetaElement('meta[name="theme-color"]', { name: 'theme-color' }, siteInfo.themeColor)

  const defaultOgImage = siteInfo.ogImage || DEFAULT_SITE_OG_IMAGE
  syncMetaElement('meta[property="og:image"]', { property: 'og:image' }, defaultOgImage, false)
  syncMetaElement('meta[name="twitter:image"]', { name: 'twitter:image' }, defaultOgImage, false)
}

watch(
  () => [
    siteStore.siteInfo.faviconSvgUrl,
    siteStore.siteInfo.faviconIcoUrl,
    siteStore.siteInfo.faviconPngUrl,
    siteStore.siteInfo.appleTouchIconUrl,
    siteStore.siteInfo.themeColor,
    siteStore.siteInfo.ogImage
  ] as const,
  syncPublicDocumentHead,
  { immediate: true }
)

const handleSearch = async (query: string): Promise<void> => {
  const canonicalQuery = normalizePublicSearchKeyword(query)
  if (!canonicalQuery) {
    return
  }

  if (isSearchRoute.value && route.query.q === canonicalQuery) {
    return
  }

  await router.push({ name: PUBLIC_SEARCH_ROUTE_NAME, query: { q: canonicalQuery } })
}

const handleNavigate = async (href: string): Promise<void> => {
  await router.push(href)
}

const handleSearchFocus = (): void => {
  window.dispatchEvent(new CustomEvent('fsus:public-shell:search-focus'))
}
</script>
