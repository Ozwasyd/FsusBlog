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
import { computed, onMounted, ref } from 'vue'
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

const shellState = computed(() => createPublicShellViewState({
  hydrationKind: hydrationKind.value,
  siteTitle: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteTitle : siteStore.siteInfo.title,
  siteLogoUrl: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteLogoUrl : siteStore.siteInfo.siteLogoUrl,
  siteLogoDarkUrl: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteLogoDarkUrl : siteStore.siteInfo.siteLogoDarkUrl,
  siteWordmarkUrl: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.siteWordmarkUrl : siteStore.siteInfo.siteWordmarkUrl,
  compliance: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.compliance : siteStore.complianceInfo,
  renderYear: shouldUseTakeoverShellSeed.value ? takeoverShellSeed?.renderYear : runtimeRenderYear.value,
  isSearchRoute: isSearchRoute.value,
  initialSearchQuery: isSearchRoute.value ? String(route.query.q || '') : '',
  spaSearch: isMounted.value && runtimeReady.value,
  showRuntime: isMounted.value && runtimeReady.value,
  isRuntimeAuthResolved: isMounted.value && runtimeReady.value,
  isLoggedIn: userStore.isLoggedIn,
  isAdmin: userStore.isAdmin
}))

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
