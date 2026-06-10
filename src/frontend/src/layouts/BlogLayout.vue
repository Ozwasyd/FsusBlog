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
      <transition v-else name="fade-fast" mode="out-in">
        <component :is="Component" :key="routeComponentKey" />
      </transition>
    </router-view>
  </PublicBlogLayoutShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { runtimeReady } from '@/bootstrap/runtimeGate'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import {
  isPublicSearchRouteName,
  isPublicSeoRouteName,
  resolvePublicPageKind
} from '@/public-renderers/publicPageModel'
import { PUBLIC_SEARCH_ROUTE_NAME } from '@/public-renderers/publicRouteRegistry'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'

const userStore = useUserStore()
const { siteStore, ensureSiteInfo } = useSessionBootstrap()
const router = useRouter()
const route = useRoute()
// Prevent auth-dependent UI from changing during hydration
const isMounted = ref(false)

onMounted(() => {
  isMounted.value = true
  // Defer site info loading to avoid hydration mismatch
  // Site info should be fetched after hydration completes
  setTimeout(() => {
    void ensureSiteInfo()
  }, 600)
})

const hydrationKind = computed(() => {
  return resolvePublicPageKind(route.name)
})

const isSeoShellRoute = computed(() => isPublicSeoRouteName(route.name))
const isSearchRoute = computed(() => isPublicSearchRouteName(route.name))
const routeComponentKey = computed(() => route.name ? String(route.name) : route.fullPath)

const shellState = computed(() => createPublicShellViewState({
  hydrationKind: hydrationKind.value,
  siteTitle: siteStore.siteInfo.title,
  siteLogoUrl: siteStore.siteInfo.siteLogoUrl,
  siteLogoDarkUrl: siteStore.siteInfo.siteLogoDarkUrl,
  siteWordmarkUrl: siteStore.siteInfo.siteWordmarkUrl,
  compliance: siteStore.complianceInfo,
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

<style scoped>
@reference "@/assets/main.css";

.fade-fast-enter-active,
.fade-fast-leave-active {
  transition: opacity var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.fade-fast-enter-from,
.fade-fast-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .fade-fast-enter-active,
  .fade-fast-leave-active {
    transition: none;
  }
}
</style>
