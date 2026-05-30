<template>
  <div
    id="fsus-aot-shell"
    :data-public-hydration-kind="hydrationKind || undefined"
  >
    <el-public-shell
      :hydration-kind="hydrationKind || undefined"
      :brand="siteTitleText"
      :brand-href="PUBLIC_FIXED_PATHS.home"
      :nav-items="PUBLIC_NAV_ITEMS"
      :active-nav="activeNav"
      :auth-label="authLabel"
      :auth-href="authHref"
      :search-action="PUBLIC_ROUTE_PATHS.search"
      search-name="q"
      :search-query="searchQuery"
      :search-placeholder="searchPlaceholder"
      search-aria-label="搜索内容"
      :spa-search="spaSearch"
      max-width="64rem"
      @search-focus="emit('search-focus')"
      @update:search-query="handleSearchInput"
      @search="handleSearch"
    >
      <template #brand>
        {{ siteTitleText }}<span class="text-[var(--fsusblog-text-muted)]">.</span>
      </template>

      <template #desktop-actions>
        <ThemeModeToggle visibility="desktop" />
      </template>

      <template #mobile-actions>
        <ThemeModeToggle :compact="true" visibility="mobile" />
      </template>

      <slot />
      <FullAppRuntime v-if="showRuntime" />

      <template #footer>
        <div class="flex flex-col sm:flex-row justify-between items-start gap-12 sm:gap-8">
          <div class="flex flex-row items-center justify-between w-full sm:w-auto sm:flex-col sm:items-start sm:gap-6">
            <div class="text-[1.25rem] font-bold tracking-normal">
              {{ siteTitleText }}<span class="text-[var(--fsusblog-text-muted)]">.</span>
            </div>
            <div class="text-[10px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
              &copy; {{ currentYear }} {{ siteTitleText }}. 保留所有权利。
            </div>
          </div>

          <div class="flex flex-wrap gap-x-10 gap-y-6 text-[10px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
            <a href="/feed/rss.xml" class="blog-link-state">RSS 订阅</a>
            <a :href="PUBLIC_FIXED_PATHS.archive" class="blog-link-state">归档</a>
            <a :href="PUBLIC_FIXED_PATHS.about" class="blog-link-state">关于</a>
            <a href="#top" class="blog-link-state flex items-center gap-2 group">
              回到顶部 <el-icon class="transition-transform" aria-hidden="true"><Top /></el-icon>
            </a>
          </div>
        </div>
      </template>
    </el-public-shell>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { PUBLIC_FIXED_PATHS, PUBLIC_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'
import { PUBLIC_SHELL_DEFAULTS, type PublicActiveNav } from '@/public-renderers/publicShellState'
import { Top } from '@/ui/fsusIcons'

const props = withDefaults(defineProps<{
  hydrationKind?: string | null
  siteTitle?: string | null
  activeNav?: PublicActiveNav
  authLabel?: string
  authHref?: string
  searchPlaceholder?: string
  initialSearchQuery?: string
  spaSearch?: boolean
  showRuntime?: boolean
}>(), {
  hydrationKind: PUBLIC_SHELL_DEFAULTS.hydrationKind,
  siteTitle: PUBLIC_SHELL_DEFAULTS.siteTitle,
  activeNav: PUBLIC_SHELL_DEFAULTS.activeNav,
  authLabel: PUBLIC_SHELL_DEFAULTS.authLabel,
  authHref: PUBLIC_SHELL_DEFAULTS.authHref,
  searchPlaceholder: PUBLIC_SHELL_DEFAULTS.searchPlaceholder,
  initialSearchQuery: PUBLIC_SHELL_DEFAULTS.initialSearchQuery,
  spaSearch: PUBLIC_SHELL_DEFAULTS.spaSearch,
  showRuntime: PUBLIC_SHELL_DEFAULTS.showRuntime
})

const emit = defineEmits<{
  (event: 'search-focus'): void
  (event: 'search', query: string): void
}>()

const currentYear = new Date().getFullYear()
const siteTitleText = computed(() => props.siteTitle?.trim() || PUBLIC_SHELL_DEFAULTS.siteTitle)
const searchQuery = ref(props.initialSearchQuery)
const FullAppRuntime = defineAsyncComponent(() => import('@/components/runtime/AppRuntime.vue'))
const PUBLIC_NAV_ITEMS = [
  { key: 'home', label: '首页', href: PUBLIC_FIXED_PATHS.home },
  { key: 'archive', label: '归档', href: PUBLIC_FIXED_PATHS.archive },
  { key: 'about', label: '关于', href: PUBLIC_FIXED_PATHS.about }
]

function handleSearchInput(value: string | number): void {
  searchQuery.value = String(value).trim()
}

function handleSearch(query: string): void {
  searchQuery.value = query.trim()
  emit('search', query)
}
</script>

<style scoped>
@reference "@/assets/main.css";
</style>
