<template>
  <PublicBlogLayoutShell
    v-bind="shellState"
    @search="handleSearch"
    @search-focus="handleSearchFocus"
  >
    <router-view v-slot="{ Component }">
      <component
        :is="Component"
        v-if="isSeoShellRoute"
        :key="routeComponentKey"
      />
      <FsusBlogRouteTransition v-else :name="fsusBlogMotionPresets.route">
        <component :is="Component" :key="routeComponentKey" />
      </FsusBlogRouteTransition>
    </router-view>
  </PublicBlogLayoutShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'
import { runtimeReady } from '@/bootstrap/runtimeGate'
import { publicTakeoverPhaseState } from '@/bootstrap/publicTakeoverState'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import FsusBlogRouteTransition from '@/components/ui/FsusBlogRouteTransition.vue'
import { fsusBlogMotionPresets } from '@/fsusui/motion'
import {
  isPublicSearchRouteName,
  isPublicSeoRouteName,
  resolvePublicPageKind
} from '@/public-renderers/publicPageModel'
import { PUBLIC_SEARCH_ROUTE_NAME } from '@/public-renderers/publicRouteRegistry'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'
import { createPublicTakeoverSeed } from '@/public-renderers/publicSiteIdentity'
import { createPublicSiteIdentity } from '@/public-renderers/publicSiteIdentityContext'

const userStore = useUserStore()
const { siteStore, ensureSiteInfo, ensureUserInfo } = useSessionBootstrap()
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
  // Site info should be fetched after hydration completes
  setTimeout(() => {
    void ensureSiteInfo()
    void ensureUserInfo()
  }, 600)
})

const hydrationKind = computed(() => {
  return resolvePublicPageKind(route.name)
})

const isSeoShellRoute = computed(() => isPublicSeoRouteName(route.name))
const isSearchRoute = computed(() => isPublicSearchRouteName(route.name))
const routeComponentKey = computed(() => route.name ? String(route.name) : route.fullPath)
const shouldUseTakeoverShellSeed = computed(() => takeoverShellSeed !== null && publicTakeoverPhaseState.value !== 'hydrated')
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
  isRuntimeAuthResolved: isMounted.value && runtimeReady.value,
  isLoggedIn: userStore.isLoggedIn,
  isAdmin: userStore.isAdmin
}))

const publicDocumentTitle = computed(() => {
  const pageTitle = typeof route.meta.title === 'string' ? route.meta.title.trim() : ''
  return pageTitle ? `${pageTitle} - ${activeSiteIdentity.value.siteTitle}` : activeSiteIdentity.value.siteTitle
})

function syncPublicDocumentHead(): void {
  if (typeof document === 'undefined') {
    return
  }

  document.title = publicDocumentTitle.value

  let descriptionMeta = document.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (!descriptionMeta) {
    descriptionMeta = document.createElement('meta')
    descriptionMeta.setAttribute('name', 'description')
    document.head.appendChild(descriptionMeta)
  }
  descriptionMeta.setAttribute('content', activeSiteIdentity.value.siteDescription)
}

watch(
  () => [publicDocumentTitle.value, activeSiteIdentity.value.siteDescription] as const,
  syncPublicDocumentHead,
  { immediate: true }
)

const handleSearch = async (query: string): Promise<void> => {
  if (!query) {
    return
  }

  if (isSearchRoute.value && route.query.q === query) {
    return
  }

  await router.push({ name: PUBLIC_SEARCH_ROUTE_NAME, query: { q: query } })
}

const handleSearchFocus = (): void => {
  window.dispatchEvent(new CustomEvent('fsus:public-shell:search-focus'))
}
</script>
