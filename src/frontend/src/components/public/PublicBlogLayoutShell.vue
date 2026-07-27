<template>
  <div
    id="fsus-aot-shell"
    ref="shellRootRef"
    class="fsusblog-public-shell-runtime"
    :data-public-hydration-kind="hydrationKind || undefined"
    :data-public-render-locale="initialLocale || undefined"
    data-public-mobile-menu-message-key="public.shell.mobileMenu"
    data-public-search-message-key="public.shell.search"
    :data-public-auth-message-key="resolvedAuthMessageKey"
  >
    <a
      href="#main-content"
      class="fsusblog-public-skip-link sr-only focus:not-sr-only focus:fixed focus:left-4 focus:z-[1000] focus:inline-flex focus:min-h-10 focus:items-center focus:bg-[var(--fsusblog-text-primary)] focus:px-4 focus:text-[var(--fsusblog-page-bg)]"
    >
      {{ layoutCopy.skipToMain }}
    </a>
    <FsusUiPublicShell
      class="is-sticky"
      v-bind="{ 'data-public-sticky-geometry-owner': '' }"
      :hydration-kind="hydrationKind || undefined"
      :data-public-hydration-kind="hydrationKind || undefined"
      :data-public-mobile-nav-mode="PUBLIC_MOBILE_NAV_MODE"
      :brand="shellIdentity.siteTitle"
      :brand-href="PUBLIC_FIXED_PATHS.home"
      :nav-items="publicNavItems"
      :active-nav="activeNav"
      active-nav-motion="indicator"
      :mobile-nav-mode="PUBLIC_MOBILE_NAV_MODE"
      :mobile-nav-label="layoutCopy.navigation"
      :mobile-nav-menu-label="layoutCopy.mobileMenu"
      desktop-search-mode="trigger"
      :desktop-search-trigger-label="layoutCopy.search"
      mobile-search-mode="trigger"
      :mobile-search-trigger-label="layoutCopy.search"
      :mobile-search-cancel-label="layoutCopy.searchCancel"
      :auth-label="resolvedAuthLabel"
      :auth-href="resolvedAuthHref"
      :show-search="true"
      :search-action="PUBLIC_ROUTE_PATHS.search"
      search-name="q"
      :search-query="searchQuery"
      :search-placeholder="resolvedSearchPlaceholder"
      :search-aria-label="layoutCopy.searchAria"
      :spa-search="spaSearch"
      :sticky="true"
      :csp-safe="true"
      :content-flow="hydrationKind === 'ArticleDetail' ? 'content-driven' : 'viewport-stable'"
      max-width="64rem"
      @update:search-query="handleSearchInput"
      @search="handleSearch"
      @search-focus="emit('search-focus')"
      @click="handlePublicShellClick"
    >
      <template #brand>
        <span v-if="hasBrandImage" class="fsusblog-public-brand-mark">
          <img
            v-if="brandImageLight"
            :src="brandImageLight"
            :alt="shellIdentity.siteTitle"
            class="fsusblog-public-brand-image fsusblog-public-brand-image--light"
            width="224"
            height="44"
            loading="eager"
            decoding="async"
          />
          <img
            v-if="brandImageDark"
            :src="brandImageDark"
            :alt="shellIdentity.siteTitle"
            class="fsusblog-public-brand-image fsusblog-public-brand-image--dark"
            width="224"
            height="44"
            loading="eager"
            decoding="async"
          />
        </span>
        <template v-else>{{ shellIdentity.siteTitle }}</template>
      </template>

      <template #desktop-actions>
        <LocaleToggle />
        <ThemeModeToggle visibility="desktop" variant="menu-button" />
      </template>

      <template #mobile-menu-actions>
        <div
          class="fsusblog-public-mobile-menu-utilities"
          role="group"
          :aria-label="layoutCopy.mobileUtilities"
        >
          <ThemeModeToggle
            visibility="mobile"
            variant="menu-button"
            :labels="PUBLIC_THEME_MODE_LABELS"
          />
          <LocaleToggle />
        </div>
      </template>

      <div
        id="main-content"
        class="fsusblog-public-main-target"
        :data-public-content-flow="hydrationKind === 'ArticleDetail' ? 'content-driven' : undefined"
        tabindex="-1"
      >
        <slot />
      </div>
      <FullAppRuntime v-if="shouldShowRuntime" />

      <template #footer>
        <PublicComplianceFooter
          :site-title="shellIdentity.siteTitle"
          :compliance="shellIdentity.compliance"
          :render-year="shellIdentity.renderYear"
        />
      </template>
    </FsusUiPublicShell>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import LocaleToggle from '@/components/ui/LocaleToggle.vue'
import PublicComplianceFooter from '@/components/public/PublicComplianceFooter.vue'
import { useI18nText } from '@/composables/useI18nText'
import { usePublicStickyGeometry } from '@/components/public/usePublicStickyGeometry'
import {
  FSUSBLOG_PUBLIC_MOBILE_NAV_MODE,
  FsusUiPublicShell,
} from '@/fsusui/publicShell'
import {
  PUBLIC_FIXED_PATHS,
  PUBLIC_ROUTE_PATHS,
} from '@/public-renderers/publicRoutePaths'
import type { PublicActiveNav } from '@/public-renderers/publicShellState'
import type {
  PublicShellAuthAction,
  PublicShellSearchAction,
} from '@/public-renderers/publicShellState'
import {
  createPublicSiteIdentity,
  providePublicSiteIdentity,
} from '@/public-renderers/publicSiteIdentityContext'
import { normalizePublicSiteDescription } from '@/public-renderers/publicSiteIdentity'
import { publicShellRuntimeAuthState } from '@/public-renderers/publicShellRuntimeState'
import type { SiteComplianceConfigPublic } from '@/api/system'
import type { SupportedLocale } from '@/locales'

const { messages } = useI18nText()
const layoutCopy = computed(() => messages.value.public.shell)
const PUBLIC_MOBILE_NAV_MODE = FSUSBLOG_PUBLIC_MOBILE_NAV_MODE

const SHELL_DEFAULTS = {
  hydrationKind: null,
  siteTitle: "Fsu's Blog",
  siteDescription: '工程记录、性能实验、UI 系统与 FsusBlog 构建过程。',
  activeNav: 'none',
  authAction: 'login',
  authHref: '/login',
  searchAction: 'search',
  initialSearchQuery: '',
  spaSearch: false,
  spaNavigation: false,
  showRuntime: false,
  compliance: null,
  renderYear: null,
} satisfies {
  hydrationKind: string | null
  siteTitle: string
  siteDescription: string
  activeNav: PublicActiveNav
  authAction: PublicShellAuthAction
  authHref: string
  searchAction: PublicShellSearchAction
  initialSearchQuery: string
  spaSearch: boolean
  spaNavigation: boolean
  showRuntime: boolean
  compliance: SiteComplianceConfigPublic | null
  renderYear: number | null
}

const props = withDefaults(
  defineProps<{
    hydrationKind?: string | null
    siteTitle?: string | null
    siteDescription?: string | null
    siteLogoUrl?: string | null
    siteLogoDarkUrl?: string | null
    siteWordmarkUrl?: string | null
    activeNav?: PublicActiveNav
    authAction?: PublicShellAuthAction
    authHref?: string
    searchAction?: PublicShellSearchAction
    initialLocale?: SupportedLocale | null
    initialSearchQuery?: string
    spaSearch?: boolean
    spaNavigation?: boolean
    showRuntime?: boolean
    compliance?: SiteComplianceConfigPublic | null
    renderYear?: number | null
  }>(),
  {
    hydrationKind: null,
    siteTitle: "Fsu's Blog",
    siteDescription: '工程记录、性能实验、UI 系统与 FsusBlog 构建过程。',
    siteLogoUrl: '',
    siteLogoDarkUrl: '',
    siteWordmarkUrl: '',
    activeNav: 'none',
    authAction: 'login',
    authHref: '/login',
    searchAction: 'search',
    initialLocale: null,
    initialSearchQuery: '',
    spaSearch: false,
    spaNavigation: false,
    showRuntime: false,
    compliance: null,
    renderYear: null,
  },
)

const emit = defineEmits<{
  (event: 'search-focus'): void
  (event: 'search', query: string): void
  (event: 'navigate', href: string): void
}>()

const siteTitleText = computed(
  () => props.siteTitle?.trim() || SHELL_DEFAULTS.siteTitle,
)
const siteDescriptionText = computed(() =>
  normalizePublicSiteDescription(props.siteDescription),
)
const compliance = computed(() => props.compliance ?? null)
const searchQuery = ref(props.initialSearchQuery)
const shellRootRef = ref<HTMLElement>()
const clientRuntimeEnabled = ref(false)
let hydrationObserver: MutationObserver | null = null
const FullAppRuntime = defineAsyncComponent(
  () => import('@/components/runtime/AppRuntime.vue'),
)
const PUBLIC_THEME_MODE_LABELS = computed(() => ({
  light: layoutCopy.value.light,
  dark: layoutCopy.value.dark,
  system: layoutCopy.value.system,
  lightShort: layoutCopy.value.lightShort,
  darkShort: layoutCopy.value.darkShort,
  systemShort: layoutCopy.value.systemShort,
}))
const publicNavItems = computed(() => [
  { key: 'home', label: layoutCopy.value.home, href: PUBLIC_FIXED_PATHS.home },
  { key: 'archive', label: layoutCopy.value.archive, href: PUBLIC_FIXED_PATHS.archive },
  { key: 'about', label: layoutCopy.value.about, href: PUBLIC_FIXED_PATHS.about },
])
const shellIdentity = computed(() =>
  createPublicSiteIdentity({
    siteTitle: siteTitleText.value,
    siteDescription: siteDescriptionText.value,
    siteLogoUrl: props.siteLogoUrl ?? '',
    siteLogoDarkUrl: props.siteLogoDarkUrl ?? '',
    siteWordmarkUrl: props.siteWordmarkUrl ?? '',
    compliance: compliance.value,
    renderYear: props.renderYear ?? null,
  }),
)
const brandImageLight = computed(() => firstPresent(
  shellIdentity.value.siteWordmarkUrl,
  shellIdentity.value.siteLogoUrl,
  shellIdentity.value.siteLogoDarkUrl,
))
const brandImageDark = computed(() => firstPresent(
  shellIdentity.value.siteWordmarkUrl,
  shellIdentity.value.siteLogoDarkUrl,
  shellIdentity.value.siteLogoUrl,
))
const hasBrandImage = computed(() => Boolean(brandImageLight.value || brandImageDark.value))
usePublicStickyGeometry(shellRootRef)
const shouldUseRuntimeAuthState = computed(() =>
  props.authAction === SHELL_DEFAULTS.authAction
  && (props.authHref?.trim() || SHELL_DEFAULTS.authHref) === SHELL_DEFAULTS.authHref
)
const shouldShowRuntime = computed(() => props.showRuntime || clientRuntimeEnabled.value)
const resolvedAuthHref = computed(() =>
  shouldUseRuntimeAuthState.value
    ? publicShellRuntimeAuthState.value.authHref
    : props.authHref?.trim() || SHELL_DEFAULTS.authHref
)
const resolvedAuthAction = computed(() =>
  shouldUseRuntimeAuthState.value
    ? publicShellRuntimeAuthState.value.authAction
    : props.authAction
)
const resolvedAuthMessageKey = computed(() => `public.shell.${resolvedAuthAction.value}`)
const resolvedAuthLabel = computed(() =>
  resolvedAuthAction.value === 'dashboard'
    ? layoutCopy.value.dashboard
    : resolvedAuthAction.value === 'account'
      ? layoutCopy.value.account
      : layoutCopy.value.login
)
const resolvedSearchPlaceholder = computed(() =>
  props.searchAction === 'search-shortcut'
    ? layoutCopy.value.searchPlaceholderShortcut
    : layoutCopy.value.searchPlaceholder
)

providePublicSiteIdentity(shellIdentity)

function firstPresent(...values: Array<string | null | undefined>): string {
  return values.find((value) => value?.trim())?.trim() ?? ''
}

function isModifiedClick(event: MouseEvent): boolean {
  return event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
}

function handleNavClick(event: MouseEvent, href: string): void {
  if (!props.spaNavigation || isModifiedClick(event)) {
    return
  }

  event.preventDefault()
  emit('navigate', href)
}

function handlePublicShellClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) {
    return
  }

  const link = event.target.closest<HTMLAnchorElement>('a[data-public-nav]')
  if (!link) {
    return
  }

  handleNavClick(event, link.getAttribute('href') ?? '')
}

function handleSearchInput(value: string | number): void {
  searchQuery.value = String(value).trim()
}

function handleSearch(query: string): void {
  searchQuery.value = query.trim()
  emit('search', query)
}

function enableRuntimeAfterHydration(): void {
  if (props.showRuntime || clientRuntimeEnabled.value) {
    return
  }

  const shell = shellRootRef.value
  if (!shell) {
    return
  }

  if (shell.dataset.publicHydrated === 'true') {
    clientRuntimeEnabled.value = true
    return
  }

  hydrationObserver?.disconnect()
  hydrationObserver = new MutationObserver(() => {
    if (shell.dataset.publicHydrated !== 'true') {
      return
    }

    hydrationObserver?.disconnect()
    hydrationObserver = null
    clientRuntimeEnabled.value = true
  })
  hydrationObserver.observe(shell, { attributes: true, attributeFilter: ['data-public-hydrated'] })
}

watch(
  () => props.initialSearchQuery,
  (value) => {
    searchQuery.value = value
  },
)

onMounted(() => {
  enableRuntimeAfterHydration()
})

onBeforeUnmount(() => {
  hydrationObserver?.disconnect()
  hydrationObserver = null
})
</script>

<style scoped>
.fsusblog-public-main-target {
  min-width: 0;
}

.fsusblog-public-mobile-menu-utilities {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

</style>
