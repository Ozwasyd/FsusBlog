<template>
  <div
    id="fsus-aot-shell"
    :data-public-hydration-kind="hydrationKind || undefined"
  >
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[1000] focus:inline-flex focus:min-h-10 focus:items-center focus:bg-[var(--fsusblog-text-primary)] focus:px-4 focus:text-[var(--fsusblog-page-bg)]"
    >
      跳到主要内容
    </a>
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
        <span v-if="hasBrandImage" class="public-brand-mark">
          <img
            v-if="brandImageLight"
            :src="brandImageLight"
            :alt="siteTitleText"
            class="public-brand-image public-brand-image--light"
            width="224"
            height="44"
            loading="eager"
            decoding="async"
          />
          <img
            v-if="brandImageDark"
            :src="brandImageDark"
            :alt="siteTitleText"
            class="public-brand-image public-brand-image--dark"
            width="224"
            height="44"
            loading="eager"
            decoding="async"
          />
        </span>
        <template v-else>
          {{ siteTitleText }}<span class="text-[var(--fsusblog-text-muted)]">.</span>
        </template>
      </template>

      <template #desktop-actions>
        <ThemeModeToggle visibility="desktop" />
      </template>

      <template #mobile-actions>
        <ThemeModeToggle :compact="true" visibility="mobile" />
      </template>

      <main id="main-content" tabindex="-1">
        <slot />
      </main>
      <FullAppRuntime v-if="showRuntime" />

      <template #footer>
        <PublicComplianceFooter
          :site-title="siteTitleText"
          :compliance="compliance"
        />
      </template>
    </el-public-shell>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import PublicComplianceFooter from '@/components/public/PublicComplianceFooter.vue'
import { PUBLIC_FIXED_PATHS, PUBLIC_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'
import type { PublicActiveNav } from '@/public-renderers/publicShellState'
import type { SiteComplianceConfigPublic } from '@/api/system'

const SHELL_DEFAULTS = {
  hydrationKind: null,
  siteTitle: "Fsu's Blog",
  activeNav: 'none',
  authLabel: '登录',
  authHref: '/login',
  searchPlaceholder: '搜索文章、标签或关键词',
  initialSearchQuery: '',
  spaSearch: false,
  showRuntime: false,
  compliance: null
} satisfies {
  hydrationKind: string | null
  siteTitle: string
  activeNav: PublicActiveNav
  authLabel: string
  authHref: string
  searchPlaceholder: string
  initialSearchQuery: string
  spaSearch: boolean
  showRuntime: boolean
  compliance: SiteComplianceConfigPublic | null
}

const props = withDefaults(defineProps<{
  hydrationKind?: string | null
  siteTitle?: string | null
  siteLogoUrl?: string | null
  siteLogoDarkUrl?: string | null
  siteWordmarkUrl?: string | null
  activeNav?: PublicActiveNav
  authLabel?: string
  authHref?: string
  searchPlaceholder?: string
  initialSearchQuery?: string
  spaSearch?: boolean
  showRuntime?: boolean
  compliance?: SiteComplianceConfigPublic | null
}>(), {
  hydrationKind: null,
  siteTitle: "Fsu's Blog",
  siteLogoUrl: '',
  siteLogoDarkUrl: '',
  siteWordmarkUrl: '',
  activeNav: 'none',
  authLabel: '登录',
  authHref: '/login',
  searchPlaceholder: '搜索文章、标签或关键词',
  initialSearchQuery: '',
  spaSearch: false,
  showRuntime: false,
  compliance: null
})

const emit = defineEmits<{
  (event: 'search-focus'): void
  (event: 'search', query: string): void
}>()

const siteTitleText = computed(() => props.siteTitle?.trim() || SHELL_DEFAULTS.siteTitle)
const brandImageLight = computed(() => props.siteWordmarkUrl?.trim() || props.siteLogoUrl?.trim() || props.siteLogoDarkUrl?.trim() || '')
const brandImageDark = computed(() => props.siteWordmarkUrl?.trim() || props.siteLogoDarkUrl?.trim() || props.siteLogoUrl?.trim() || '')
const hasBrandImage = computed(() => Boolean(brandImageLight.value || brandImageDark.value))
const compliance = computed(() => props.compliance ?? null)
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

.public-brand-mark {
  display: inline-flex;
  min-width: 0;
  max-width: min(14rem, 42vw);
  align-items: center;
}

.public-brand-image {
  display: block;
  max-height: 1.75rem;
  max-width: 100%;
  object-fit: contain;
}

.public-brand-image--dark {
  display: none;
}

:global(html.dark) .public-brand-image--light,
:global(html[data-theme-resolved='dark']) .public-brand-image--light {
  display: none;
}

:global(html.dark) .public-brand-image--dark,
:global(html[data-theme-resolved='dark']) .public-brand-image--dark {
  display: block;
}
</style>
