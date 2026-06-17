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
      :brand="shellIdentity.siteTitle"
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
      mobile-search-mode="trigger"
      mobile-search-trigger-label="搜索"
      mobile-search-cancel-label="取消"
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
            :alt="shellIdentity.siteTitle"
            class="public-brand-image public-brand-image--light"
            width="224"
            height="44"
            loading="eager"
            decoding="async"
          />
          <img
            v-if="brandImageDark"
            :src="brandImageDark"
            :alt="shellIdentity.siteTitle"
            class="public-brand-image public-brand-image--dark"
            width="224"
            height="44"
            loading="eager"
            decoding="async"
          />
        </span>
        <template v-else>
          {{ shellIdentity.siteTitle }}
        </template>
      </template>

      <template #desktop-actions>
        <ThemeModeToggle visibility="desktop" />
      </template>

      <template #mobile-primary-actions>
        <ThemeModeToggle
          visibility="mobile"
          variant="menu-button"
          :labels="PUBLIC_THEME_MODE_LABELS"
        />
      </template>

      <main id="main-content" tabindex="-1">
        <slot />
      </main>
      <FullAppRuntime v-if="showRuntime" />

      <template #footer>
        <PublicComplianceFooter
          :site-title="shellIdentity.siteTitle"
          :compliance="shellIdentity.compliance"
          :render-year="shellIdentity.renderYear"
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
import { PUBLIC_SHELL_DEFAULTS, type PublicActiveNav } from '@/public-renderers/publicShellState'
import { createPublicSiteIdentity, providePublicSiteIdentity } from '@/public-renderers/publicSiteIdentityContext'
import { normalizePublicSiteDescription } from '@/public-renderers/publicSiteIdentity'
import type { SiteComplianceConfigPublic } from '@/api/system'

const SHELL_DEFAULTS = {
  hydrationKind: null,
  siteTitle: PUBLIC_SHELL_DEFAULTS.siteTitle,
  siteDescription: PUBLIC_SHELL_DEFAULTS.siteDescription,
  activeNav: 'none',
  authLabel: '登录',
  authHref: '/login',
  searchPlaceholder: '搜索文章、标签或关键词',
  initialSearchQuery: '',
  spaSearch: false,
  showRuntime: false,
  compliance: null,
  renderYear: null
} satisfies {
  hydrationKind: string | null
  siteTitle: string
  siteDescription: string
  activeNav: PublicActiveNav
  authLabel: string
  authHref: string
  searchPlaceholder: string
  initialSearchQuery: string
  spaSearch: boolean
  showRuntime: boolean
  compliance: SiteComplianceConfigPublic | null
  renderYear: number | null
}

const props = withDefaults(defineProps<{
  hydrationKind?: string | null
  siteTitle?: string | null
  siteDescription?: string | null
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
  renderYear?: number | null
}>(), {
  hydrationKind: null,
  siteTitle: PUBLIC_SHELL_DEFAULTS.siteTitle,
  siteDescription: PUBLIC_SHELL_DEFAULTS.siteDescription,
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
  compliance: null,
  renderYear: null
})

const emit = defineEmits<{
  (event: 'search-focus'): void
  (event: 'search', query: string): void
}>()

const siteTitleText = computed(() => props.siteTitle?.trim() || SHELL_DEFAULTS.siteTitle)
const siteDescriptionText = computed(() => normalizePublicSiteDescription(props.siteDescription))
const brandImageLight = computed(() => props.siteWordmarkUrl?.trim() || props.siteLogoUrl?.trim() || props.siteLogoDarkUrl?.trim() || '')
const brandImageDark = computed(() => props.siteWordmarkUrl?.trim() || props.siteLogoDarkUrl?.trim() || props.siteLogoUrl?.trim() || '')
const hasBrandImage = computed(() => Boolean(brandImageLight.value || brandImageDark.value))
const compliance = computed(() => props.compliance ?? null)
const searchQuery = ref(props.initialSearchQuery)
const FullAppRuntime = defineAsyncComponent(() => import('@/components/runtime/AppRuntime.vue'))
const PUBLIC_THEME_MODE_LABELS = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
  lightShort: '浅',
  darkShort: '深',
  systemShort: '系统'
}
const PUBLIC_NAV_ITEMS = [
  { key: 'home', label: '首页', href: PUBLIC_FIXED_PATHS.home },
  { key: 'archive', label: '归档', href: PUBLIC_FIXED_PATHS.archive },
  { key: 'about', label: '关于', href: PUBLIC_FIXED_PATHS.about }
]
const shellIdentity = computed(() => createPublicSiteIdentity({
  siteTitle: siteTitleText.value,
  siteDescription: siteDescriptionText.value,
  siteLogoUrl: props.siteLogoUrl ?? '',
  siteLogoDarkUrl: props.siteLogoDarkUrl ?? '',
  siteWordmarkUrl: props.siteWordmarkUrl ?? '',
  compliance: compliance.value,
  renderYear: props.renderYear ?? null
}))

providePublicSiteIdentity(shellIdentity)

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
