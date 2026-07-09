<template>
  <div
    id="fsus-aot-shell"
    ref="shellRootRef"
    :style="publicShellStyle"
    :data-public-hydration-kind="hydrationKind || undefined"
  >
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[1000] focus:inline-flex focus:min-h-10 focus:items-center focus:bg-[var(--fsusblog-text-primary)] focus:px-4 focus:text-[var(--fsusblog-page-bg)]"
    >
      跳到主要内容
    </a>
    <div
      class="el-public-shell is-sticky"
      :data-public-hydration-kind="hydrationKind || undefined"
    >
      <SiteChromeHeaderAdapter
        :site-title="shellIdentity.siteTitle"
        :site-logo-url="shellIdentity.siteLogoUrl"
        :site-logo-dark-url="shellIdentity.siteLogoDarkUrl"
        :site-wordmark-url="shellIdentity.siteWordmarkUrl"
        :brand-href="PUBLIC_FIXED_PATHS.home"
        brand-link-class="el-public-shell__brand"
        :sticky="true"
        max-width="64rem"
        header-class="fsusblog-public-shell-header el-public-shell__header is-sticky"
        inner-class="el-public-shell__inner"
        primary-row-class="el-public-shell__primary-row"
        brand-nav-class="el-public-shell__brand-nav"
        desktop-actions-class="el-public-shell__actions"
        mobile-primary-actions-class="el-public-shell__mobile-primary-actions"
        :mobile-secondary-actions-class="mobileSecondaryActionsClass"
        :show-desktop-theme-toggle="false"
        :show-mobile-theme-toggle="false"
      >
        <template #desktop-nav>
          <div
            ref="desktopNavRef"
            class="el-public-shell__desktop-nav"
            :class="{ 'is-indicator-motion': activeNavIndicatorEnabled }"
          >
            <a
              v-for="item in PUBLIC_NAV_ITEMS"
              :key="item.key"
              :href="item.href"
              :aria-current="item.key === activeNav ? 'page' : undefined"
              class="el-public-shell__nav-link"
              :class="{ 'is-active': item.key === activeNav }"
              :data-public-nav="item.key"
              @click="handleNavClick($event, item.href)"
            >
              {{ item.label }}
            </a>
            <span
              v-if="activeNavIndicatorEnabled"
              class="el-public-shell__active-nav-indicator"
              aria-hidden="true"
              :data-active-nav="activeNavIndicatorKey"
            />
          </div>
        </template>

        <template #desktop-actions>
          <form
            class="el-public-shell__search el-public-shell__search--desktop"
            :action="PUBLIC_ROUTE_PATHS.search"
            method="get"
            @submit="handleSearchSubmit"
          >
            <el-input
              :model-value="searchQuery"
              :placeholder="searchPlaceholder"
              label="搜索内容"
              size="small"
              style="--el-input-height: 40px"
              clearable
              @focus="emit('search-focus')"
              @input="handleSearchInput"
              @keydown.enter="handleSearchEnter"
            />
            <input type="hidden" name="q" :value="searchQuery" />
          </form>
          <ThemeModeToggle visibility="desktop" />
          <a
            :href="resolvedAuthHref"
            class="el-public-shell__action-link el-public-shell__auth-link el-public-shell__auth-link--desktop"
            data-public-nav="auth"
          >
            {{ resolvedAuthLabel }}
          </a>
        </template>

        <template #mobile-primary-actions>
          <button
            ref="mobileSearchTriggerRef"
            type="button"
            class="el-public-shell__mobile-search-trigger"
            :class="{ 'is-expanded': mobileSearchExpanded }"
            :aria-expanded="mobileSearchExpanded"
            :aria-controls="mobileSearchRowId"
            :aria-label="mobileSearchButtonLabel"
            @click="toggleMobileSearch"
          >
            {{ mobileSearchButtonLabel }}
          </button>
          <ThemeModeToggle
            visibility="mobile"
            variant="menu-button"
            :labels="PUBLIC_THEME_MODE_LABELS"
          />
          <a
            :href="resolvedAuthHref"
            class="el-public-shell__action-link el-public-shell__auth-link el-public-shell__auth-link--mobile"
            data-public-nav="auth"
          >
            {{ resolvedAuthLabel }}
          </a>
        </template>

        <template #mobile-secondary-actions>
          <Transition name="el-public-shell-mobile-search">
            <div
              v-show="mobileSearchExpanded"
              :id="mobileSearchRowId"
              ref="mobileSearchRowRef"
              class="el-public-shell__mobile-search-row"
              :class="{ 'is-expanded': mobileSearchExpanded }"
              :aria-hidden="!mobileSearchExpanded"
            >
              <form
                class="el-public-shell__search el-public-shell__search--trigger"
                :action="PUBLIC_ROUTE_PATHS.search"
                method="get"
                @submit="handleSearchSubmit"
                @keydown.esc="handleMobileSearchEscape"
              >
                <el-input
                  :model-value="searchQuery"
                  :placeholder="searchPlaceholder"
                  label="搜索内容"
                  size="small"
                  style="--el-input-height: 40px"
                  clearable
                  @focus="emit('search-focus')"
                  @input="handleSearchInput"
                  @keydown.enter="handleSearchEnter"
                />
                <input type="hidden" name="q" :value="searchQuery" />
              </form>
            </div>
          </Transition>

          <div class="el-public-shell__mobile-actions" />
        </template>
      </SiteChromeHeaderAdapter>

      <main
        id="main-content"
        class="el-public-shell__main"
        tabindex="-1"
      >
        <slot />
      </main>
      <FullAppRuntime v-if="shouldShowRuntime" />

      <footer class="el-public-shell__footer">
        <PublicComplianceFooter
          :site-title="shellIdentity.siteTitle"
          :compliance="shellIdentity.compliance"
          :render-year="shellIdentity.renderYear"
        />
      </footer>

      <FsusUiBottomTabBar
        v-if="shouldShowBottomTabBar"
        class="fsusblog-public-bottom-tab"
        label="主导航"
        :items="PUBLIC_NAV_ITEMS"
        :active-key="activeNav"
        @navigate="handleBottomTabNavigate"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import SiteChromeHeaderAdapter from '@/components/layout/SiteChromeHeaderAdapter.vue'
import PublicComplianceFooter from '@/components/public/PublicComplianceFooter.vue'
import { usePublicStickyGeometry } from '@/components/public/usePublicStickyGeometry'
import FsusUiBottomTabBar from '@/fsusui/FsusUiBottomTabBar.vue'
import {
  PUBLIC_FIXED_PATHS,
  PUBLIC_ROUTE_PATHS,
} from '@/public-renderers/publicRoutePaths'
import type { PublicActiveNav } from '@/public-renderers/publicShellState'
import {
  createPublicSiteIdentity,
  providePublicSiteIdentity,
} from '@/public-renderers/publicSiteIdentityContext'
import { normalizePublicSiteDescription } from '@/public-renderers/publicSiteIdentity'
import { publicShellRuntimeAuthState } from '@/public-renderers/publicShellRuntimeState'
import type { SiteComplianceConfigPublic } from '@/api/system'
import { FSUSBLOG_LAYOUT_COPY } from '@/copy'

const SHELL_DEFAULTS = {
  hydrationKind: null,
  siteTitle: FSUSBLOG_LAYOUT_COPY.siteHeader.fallbackTitle,
  siteDescription: FSUSBLOG_LAYOUT_COPY.siteHeader.fallbackDescription,
  activeNav: 'none',
  authLabel: '登录',
  authHref: '/login',
  searchPlaceholder: '搜索文章、标签或关键词',
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
  authLabel: string
  authHref: string
  searchPlaceholder: string
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
    authLabel?: string
    authHref?: string
    searchPlaceholder?: string
    initialSearchQuery?: string
    spaSearch?: boolean
    spaNavigation?: boolean
    showRuntime?: boolean
    compliance?: SiteComplianceConfigPublic | null
    renderYear?: number | null
  }>(),
  {
    hydrationKind: null,
    siteTitle: FSUSBLOG_LAYOUT_COPY.siteHeader.fallbackTitle,
    siteDescription: FSUSBLOG_LAYOUT_COPY.siteHeader.fallbackDescription,
    siteLogoUrl: '',
    siteLogoDarkUrl: '',
    siteWordmarkUrl: '',
    activeNav: 'none',
    authLabel: '登录',
    authHref: '/login',
    searchPlaceholder: '搜索文章、标签或关键词',
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
const mobileSearchExpanded = ref(props.initialSearchQuery.trim().length > 0)
const mobileSearchRowId = 'public-shell-mobile-search'
const mobileSearchRowRef = ref<HTMLElement>()
const mobileSearchTriggerRef = ref<HTMLButtonElement>()
const desktopNavRef = ref<HTMLElement>()
const mobileNavRef = ref<HTMLElement>()
const shellRootRef = ref<HTMLElement>()
const clientRuntimeEnabled = ref(false)
let hydrationObserver: MutationObserver | null = null
const FullAppRuntime = defineAsyncComponent(
  () => import('@/components/runtime/AppRuntime.vue'),
)
const PUBLIC_THEME_MODE_LABELS = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
  lightShort: '浅',
  darkShort: '深',
  systemShort: '系统',
}
const PUBLIC_NAV_ITEMS = [
  { key: 'home', label: '首页', href: PUBLIC_FIXED_PATHS.home },
  { key: 'archive', label: '归档', href: PUBLIC_FIXED_PATHS.archive },
  { key: 'about', label: '关于', href: PUBLIC_FIXED_PATHS.about },
]
const publicShellStyle = {
  '--fsusblog-public-header-height-current': 'var(--fsusblog-public-header-height, 4rem)',
  '--fsusblog-public-sticky-top': 'var(--fsusblog-public-header-height-current)',
  '--fsusblog-public-anchor-offset': 'calc(var(--fsusblog-public-sticky-top) + 0.75rem)',
  '--el-public-shell-mobile-nav-gap': '1.5rem',
  '--el-public-shell-mobile-search-width': '7rem',
  '--el-public-shell-max-width': '64rem',
  '--el-public-shell-nav-gap': '2rem',
}
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
usePublicStickyGeometry(shellRootRef)
const mobileSearchButtonLabel = computed(() =>
  mobileSearchExpanded.value ? '取消' : '搜索',
)
const mobileSecondaryActionsClass = computed(() => [
  'el-public-shell__mobile-toolbar',
  { 'is-collapsed': !mobileSearchExpanded.value },
])
const activeNavIndicatorEnabled = computed(() =>
  PUBLIC_NAV_ITEMS.some((item) => item.key === props.activeNav),
)
const activeNavIndicatorKey = computed(() =>
  activeNavIndicatorEnabled.value ? props.activeNav : '',
)
const shouldShowBottomTabBar = computed(() => PUBLIC_NAV_ITEMS.length > 0)
const shouldUseRuntimeAuthState = computed(() =>
  (props.authLabel?.trim() || SHELL_DEFAULTS.authLabel) === SHELL_DEFAULTS.authLabel
  && (props.authHref?.trim() || SHELL_DEFAULTS.authHref) === SHELL_DEFAULTS.authHref
)
const shouldShowRuntime = computed(() => props.showRuntime || clientRuntimeEnabled.value)
const resolvedAuthLabel = computed(() =>
  shouldUseRuntimeAuthState.value
    ? publicShellRuntimeAuthState.value.authLabel
    : props.authLabel?.trim() || SHELL_DEFAULTS.authLabel
)
const resolvedAuthHref = computed(() =>
  shouldUseRuntimeAuthState.value
    ? publicShellRuntimeAuthState.value.authHref
    : props.authHref?.trim() || SHELL_DEFAULTS.authHref
)

providePublicSiteIdentity(shellIdentity)

function clearNavIndicator(nav: HTMLElement): void {
  nav.style.removeProperty('--el-public-shell-active-nav-indicator-x')
  nav.style.removeProperty('--el-public-shell-active-nav-indicator-width')
  nav.style.setProperty('--el-public-shell-active-nav-indicator-opacity', '0')
}

function syncNavIndicator(nav: HTMLElement | undefined): void {
  if (!nav) {
    return
  }

  if (!activeNavIndicatorEnabled.value || !activeNavIndicatorKey.value) {
    clearNavIndicator(nav)
    return
  }

  const activeLink = Array.from(
    nav.querySelectorAll<HTMLElement>('.el-public-shell__nav-link'),
  ).find((link) => link.dataset.publicNav === activeNavIndicatorKey.value)

  if (!activeLink) {
    clearNavIndicator(nav)
    return
  }

  const navRect = nav.getBoundingClientRect()
  const linkRect = activeLink.getBoundingClientRect()
  nav.style.setProperty(
    '--el-public-shell-active-nav-indicator-x',
    `${Math.max(0, linkRect.left - navRect.left + nav.scrollLeft)}px`,
  )
  nav.style.setProperty(
    '--el-public-shell-active-nav-indicator-width',
    `${Math.max(0, linkRect.width)}px`,
  )
  nav.style.setProperty('--el-public-shell-active-nav-indicator-opacity', '1')
}

async function syncNavIndicators(): Promise<void> {
  await nextTick()
  syncNavIndicator(desktopNavRef.value)
  syncNavIndicator(mobileNavRef.value)
}

function handleIndicatorResize(): void {
  void syncNavIndicators()
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

function handleBottomTabNavigate(
  item: (typeof PUBLIC_NAV_ITEMS)[number],
  event: MouseEvent,
): void {
  handleNavClick(event, item.href)
}

function handleSearchInput(value: string | number): void {
  searchQuery.value = String(value).trim()
}

function handleSearch(query: string): void {
  searchQuery.value = query.trim()
  emit('search', query)
}

function submitSearch(event: Event): void {
  if (!props.spaSearch) {
    return
  }

  event.preventDefault()
  const query = searchQuery.value.trim()
  if (!query) {
    return
  }

  handleSearch(query)
}

function handleSearchSubmit(event: Event): void {
  submitSearch(event)
}

function handleSearchEnter(event: Event | KeyboardEvent): void {
  submitSearch(event)
}

async function focusMobileSearchInput(): Promise<void> {
  await nextTick()
  mobileSearchRowRef.value?.querySelector<HTMLInputElement>('input')?.focus()
}

async function focusMobileSearchTrigger(): Promise<void> {
  await nextTick()
  mobileSearchTriggerRef.value?.focus()
}

function closeMobileSearch(restoreFocus = false): void {
  mobileSearchExpanded.value = false
  if (restoreFocus) {
    void focusMobileSearchTrigger()
  }
}

function toggleMobileSearch(): void {
  mobileSearchExpanded.value = !mobileSearchExpanded.value
  if (mobileSearchExpanded.value) {
    void focusMobileSearchInput()
  } else {
    void focusMobileSearchTrigger()
  }
}

function handleMobileSearchEscape(event: KeyboardEvent): void {
  event.preventDefault()
  closeMobileSearch(true)
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
    mobileSearchExpanded.value = value.trim().length > 0
  },
)

watch(
  () => props.activeNav,
  () => {
    void syncNavIndicators()
  },
)

onMounted(() => {
  enableRuntimeAfterHydration()
  void syncNavIndicators()
  window.addEventListener('resize', handleIndicatorResize)
})

onBeforeUnmount(() => {
  hydrationObserver?.disconnect()
  hydrationObserver = null
  window.removeEventListener('resize', handleIndicatorResize)
})
</script>
