<template>
  <div class="account-layout-root account-shell min-h-screen">
    <a
      href="#account-main"
      class="account-skip-link sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:z-[100] focus-visible:left-4 focus-visible:top-4"
    >
      跳到主要内容
    </a>

    <SiteChromeHeaderAdapter
      :site-title="workspaceContext.brandTitle"
      :site-logo-url="workspaceContext.brandImages.siteLogoUrl"
      :site-logo-dark-url="workspaceContext.brandImages.siteLogoDarkUrl"
      :site-wordmark-url="workspaceContext.brandImages.siteWordmarkUrl"
      :admin-logo-url="workspaceContext.brandImages.adminLogoUrl"
      :admin-collapsed-icon-url="workspaceContext.brandImages.adminCollapsedIconUrl"
      brand-context="account"
      brand-link-class="account-header-brand"
      max-width="var(--fsusblog-container-workbench)"
      header-class="account-site-header"
      inner-class="account-site-header__inner"
      primary-row-class="account-site-header__primary-row"
      desktop-actions-class="account-site-header__actions"
      mobile-primary-actions-class="account-site-header__mobile-actions"
      :show-desktop-theme-toggle="false"
      :show-mobile-theme-toggle="false"
    >
      <template #desktop-actions>
        <ThemeModeToggle />

        <router-link to="/" class="account-header-link">
          主站
        </router-link>

        <el-button
          class="account-header-action"
          link
          @click="openPolicy('guidelines')"
        >
          使用规范
        </el-button>

        <el-button
          class="account-header-action"
          link
          @click="openPolicy('privacy')"
        >
          隐私政策
        </el-button>

        <el-button
          class="account-header-action"
          link
          :disabled="isLoggingOut"
          @click="handleLogout"
        >
          {{ isLoggingOut ? '登出中...' : '登出' }}
        </el-button>
      </template>

      <template #mobile-primary-actions>
        <ThemeModeToggle />
      </template>
    </SiteChromeHeaderAdapter>

    <section class="account-mobile-navigation lg:hidden" aria-label="移动账户导航">
      <FsusUiSegmentedControl
        class="account-mobile-group-control"
        :model-value="activeMobileGroupKey"
        :items="mobileGroupSegmentItems"
        selection-mode="link"
        aria-label="账户导航分组"
        @item-click="selectMobileGroupFromSegment"
        @update:model-value="selectMobileGroupFromSegment"
      >
        <template #item="{ item }">
          <span
            class="account-mobile-group-label"
            :aria-current="activeMobileGroupKey === item.value ? 'page' : undefined"
          >
            {{ item.label }}
          </span>
        </template>
      </FsusUiSegmentedControl>

      <nav
        ref="mobileLinkStripRef"
        class="account-mobile-link-strip"
        :aria-label="`${selectedMobileGroup?.label ?? areaMeta.label}导航`"
      >
        <span
          class="account-mobile-link-strip__indicator"
          :style="mobileLinkIndicatorStyle"
          aria-hidden="true"
        ></span>
        <router-link
          v-for="item in selectedMobileGroup?.items ?? []"
          :key="item.to"
          :to="item.to"
          class="account-mobile-nav-link"
          :class="{ 'account-mobile-nav-link-active': isNavItemActive(item) }"
          :data-account-mobile-nav-active="isNavItemActive(item) ? 'true' : undefined"
          :aria-current="isNavItemActive(item) ? 'page' : undefined"
        >
          <span>{{ item.label }}</span>
        </router-link>
      </nav>
    </section>

    <div class="mx-auto flex w-full max-w-[var(--fsusblog-container-workbench)] flex-1 gap-5 px-4 py-5 sm:px-6 sm:py-8 lg:gap-10 lg:px-10">
      <aside class="hidden lg:block lg:w-[18rem] lg:shrink-0">
        <div class="sticky top-24 space-y-8 pr-6">
          <nav class="space-y-9" aria-label="账户导航">
            <div id="account-shell-area-title" class="account-sidebar-index-label">
              {{ areaMeta.label }}导航
            </div>
            <section
              v-for="group in navGroups"
              :key="group.key"
              class="space-y-4"
            >
              <div
                v-if="navGroups.length > 1"
                class="account-nav-group-title"
                :class="{ 'account-nav-group-title-active': currentNavGroupKey === group.key }"
              >
                <span>{{ group.label }}</span>
                <span v-if="group.helper" class="account-nav-group-helper">{{ group.helper }}</span>
              </div>
              <router-link
                v-for="item in group.items"
                :key="item.to"
                :to="item.to"
                class="account-nav-link group"
                :class="{ 'account-nav-link-active': isNavItemActive(item) }"
              >
                <div class="account-nav-link-label">
                  {{ item.label }}
                </div>
                <div v-if="item.helper" class="account-nav-link-helper">
                  {{ item.helper }}
                </div>
              </router-link>
            </section>
          </nav>

          <div class="flex flex-wrap items-center gap-x-2.5 border-t border-[var(--fsusblog-panel-border)] pt-8">
            <el-button link @click="openPolicy('guidelines')">
              使用规范
            </el-button>
            <span class="h-0.5 w-0.5 rounded-[var(--fsus-radius-pill)] bg-[var(--fsusblog-text-muted)]" aria-hidden="true"></span>
            <el-button link @click="openPolicy('privacy')">
              隐私政策
            </el-button>
          </div>
        </div>
      </aside>

      <main id="account-main" tabindex="-1" class="min-w-0 flex-1 outline-none" aria-labelledby="account-shell-area-title">
        <router-view v-slot="{ Component }">
          <FsuTransition :name="fsusBlogMotionPresets.route" mode="out-in" :duration="140">
            <component :is="Component" :key="accountRouteViewKey" class="mx-auto w-full min-w-0" :class="[contentViewportClass, contentModeClass, adminContentClass]" />
          </FsuTransition>
        </router-view>
      </main>
    </div>

    <PolicyModal v-model:visible="showPolicy" :type="policyType" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PolicyModal from '@/components/PolicyModal.vue'
import SiteChromeHeaderAdapter from '@/components/layout/SiteChromeHeaderAdapter.vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { FsusUiSegmentedControl } from '@/fsusui'
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion'
import { FsuTransition } from '@/fsusui/motion'
import { getAccountNavGroups, type AccountArea, type AccountContentMode, type AccountNavGroup, type AccountNavGroupKey, type AccountNavItem } from '@/layouts/accountNav'
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext'
import { showErrorToast } from '@/utils/errorPresentation'

const route = useRoute()
const router = useRouter()
const workspaceContext = useAccountWorkspaceContext()

const showPolicy = ref(false)
const policyType = ref<'privacy' | 'guidelines'>('guidelines')
const isLoggingOut = ref(false)
const openMobileGroupKey = ref<AccountNavGroupKey>('self')
const mobileLinkStripRef = ref<HTMLElement>()
const mobileLinkIndicatorStyle = ref<CSSProperties>({
  opacity: '0',
  transform: 'translate3d(0, 0, 0)',
  width: '0px'
})
let mobileLinkResizeObserver: ResizeObserver | undefined

const currentArea = computed<AccountArea>(() =>
  workspaceContext.value.surface
)

const currentContentMode = computed<AccountContentMode>(() => {
  const mode = route.meta.accountContentMode
  if (mode === 'wide' || mode === 'takeover') {
    return mode
  }
  return 'standard'
})

const areaMeta = computed(() => workspaceContext.value.areaMeta)
const navGroups = computed(() => getAccountNavGroups(workspaceContext.value))
const mobileGroupSegmentItems = computed(() =>
  navGroups.value.map((group) => ({
    label: group.label,
    value: group.key,
    to: group.items[0]?.to
  }))
)
const selectedMobileGroup = computed<AccountNavGroup | undefined>(() =>
  navGroups.value.find((group) => group.key === openMobileGroupKey.value) ?? navGroups.value[0]
)
const currentNavGroupKey = computed<AccountNavGroupKey>(() => {
  const activeGroup = [...navGroups.value].reverse().find((group) => group.items.some((item) => isNavItemActive(item)))
  return activeGroup?.key ?? (currentArea.value === 'manage' ? 'content' : 'self')
})
const activeMobileGroupKey = computed<AccountNavGroupKey>(() => currentNavGroupKey.value)

const contentViewportClass = computed(() => {
  if (currentContentMode.value === 'wide') {
    return 'max-w-[var(--fsusblog-container-wide)]'
  }

  if (currentContentMode.value === 'takeover') {
    return 'max-w-none'
  }

  return 'max-w-[var(--fsusblog-container-account)]'
})

const contentModeClass = computed(() => {
  if (currentContentMode.value === 'wide') {
    return 'min-w-0'
  }

  if (currentContentMode.value === 'takeover') {
    return 'flex min-h-[calc(100dvh-9rem)] min-w-0 flex-col lg:min-h-[calc(100dvh-8rem)]'
  }

  return 'min-w-0'
})

const adminContentClass = computed(() => {
  if (currentArea.value !== 'manage') {
    return ''
  }

  if (route.name === 'ManageWriteArticle' || route.name === 'ManageEditArticle') {
    return 'admin-page-shell admin-page-shell--form'
  }

  if (route.name === 'ManageSettings') {
    return 'admin-page-shell admin-page-shell--settings'
  }

  if (route.name === 'ManageDashboard') {
    return 'admin-page-shell admin-page-shell--dashboard'
  }

  return 'admin-page-shell admin-page-shell--list'
})

const accountRouteViewKey = computed(() => {
  const accountRootIndex = route.matched.findIndex((record) => record.path === '/user')
  const accountViewRecord = accountRootIndex >= 0
    ? route.matched[accountRootIndex + 1]
    : undefined
  const routeName = typeof accountViewRecord?.name === 'string'
    ? accountViewRecord.name
    : typeof route.name === 'string'
      ? route.name
      : route.path
  const id = route.params.id
  if (Array.isArray(id)) {
    return `${routeName}:${id.join('/')}`
  }

  return typeof id === 'string' && id.length > 0
    ? `${routeName}:${id}`
    : routeName
})

const isNavItemActive = (item: AccountNavItem): boolean => {
  if (item.match) {
    return item.match(route.path)
  }

  return route.path === item.to || route.path.startsWith(`${item.to}/`)
}

const selectMobileGroup = async (key: AccountNavGroupKey): Promise<void> => {
  const group = navGroups.value.find((candidate) => candidate.key === key)
  if (!group) {
    return
  }

  openMobileGroupKey.value = key

  if (key !== currentNavGroupKey.value) {
    const target = group.items[0]?.to
    if (target && target !== route.path) {
      await router.push(target)
    }
  }
}

const selectMobileGroupFromSegment = (value: string | number | boolean): void => {
  if (typeof value !== 'string') {
    return
  }

  if (!navGroups.value.some((group) => group.key === value)) {
    return
  }

  void selectMobileGroup(value as AccountNavGroupKey)
}

const updateMobileLinkIndicator = async (): Promise<void> => {
  await nextTick()
  const strip = mobileLinkStripRef.value
  const activeLink = strip?.querySelector<HTMLElement>('[data-account-mobile-nav-active="true"]')

  if (!strip || !activeLink) {
    mobileLinkIndicatorStyle.value = {
      opacity: '0',
      transform: 'translate3d(0, 0, 0)',
      width: '0px'
    }
    return
  }

  mobileLinkIndicatorStyle.value = {
    opacity: '1',
    transform: `translate3d(${activeLink.offsetLeft}px, 0, 0)`,
    width: `${activeLink.offsetWidth}px`
  }
}

const openPolicy = (type: 'privacy' | 'guidelines') => {
  policyType.value = type
  showPolicy.value = true
}

const handleLogout = async () => {
  if (isLoggingOut.value) {
    return
  }

  isLoggingOut.value = true
  try {
    await workspaceContext.value.logout()
  } catch (error) {
    showErrorToast(error, '登出失败，请稍后重试')
  } finally {
    isLoggingOut.value = false
  }
}

watch(
  () => route.fullPath,
  () => {
    openMobileGroupKey.value = currentNavGroupKey.value
    void updateMobileLinkIndicator()
  }
)

watch(currentNavGroupKey, (key) => {
  openMobileGroupKey.value = key
  void updateMobileLinkIndicator()
}, { immediate: true })

watch(
  () => selectedMobileGroup.value?.items.map((item) => item.to).join('|'),
  () => {
    void updateMobileLinkIndicator()
  },
  { flush: 'post' }
)

onMounted(() => {
  void updateMobileLinkIndicator()
  if (typeof ResizeObserver !== 'undefined' && mobileLinkStripRef.value) {
    mobileLinkResizeObserver = new ResizeObserver(() => {
      void updateMobileLinkIndicator()
    })
    mobileLinkResizeObserver.observe(mobileLinkStripRef.value)
  }
})

onBeforeUnmount(() => {
  mobileLinkResizeObserver?.disconnect()
})
</script>

<style scoped>
@reference "@/assets/main.css";

.account-header-link,
.account-meta-link {
  @apply inline-flex min-h-9 items-center justify-center rounded-[var(--fsus-radius-control-small)] px-2 text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-tertiary)] transition-colors hover:text-[var(--fsusblog-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60;
}

:deep(.account-header-action) {
  min-height: 2.25rem;
  padding-inline: 0.5rem;
}

:deep(.account-header-brand) {
  display: inline-flex;
  min-height: 2.5rem;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
  color: var(--fsusblog-text-primary);
  text-decoration: none;
}

.account-skip-link:focus-visible {
  padding: 1rem;
  background: var(--fsusblog-text-primary);
  color: var(--fsusblog-page-bg);
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: none;
}

.account-mobile-navigation {
  border-bottom: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}

.account-mobile-link-strip {
  display: flex;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.account-mobile-link-strip::-webkit-scrollbar {
  display: none;
}

.account-mobile-group-control {
  position: relative;
  width: calc(100% - 2rem);
  max-width: calc(100% - 2rem);
  min-height: 40px;
  margin: 0.5rem 1rem 0;
  overflow-x: auto;
  scrollbar-width: none;
  border-color: var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control);
  background: var(--fsusblog-page-bg-soft);
  isolation: isolate;
}

.account-mobile-group-control::-webkit-scrollbar {
  display: none;
}

.account-mobile-group-label {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  padding-inline: 0.25rem;
  color: inherit;
  line-height: 1;
}

.account-mobile-link-strip {
  position: relative;
  gap: 0.375rem;
  align-items: center;
  padding: 0.5rem 1rem;
  scroll-snap-type: x proximity;
}

.account-mobile-link-strip__indicator {
  position: absolute;
  bottom: 0.875rem;
  left: 0;
  z-index: 0;
  height: 2px;
  border-radius: var(--fsus-radius-pill);
  background: var(--fsusblog-color-primary);
  pointer-events: none;
  transition:
    transform var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    width var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    opacity var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-mobile-nav-link {
  flex: 0 0 auto;
  border-radius: var(--fsus-radius-control-small);
  color: var(--fsusblog-text-tertiary);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1;
  text-decoration: none;
  transition: background-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-mobile-nav-link {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  border: 1px solid transparent;
  background: transparent;
  padding: 0 0.875rem;
  scroll-snap-align: start;
  z-index: 1;
}

.account-mobile-nav-link:hover,
.account-mobile-nav-link-active {
  border-color: var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  color: var(--fsusblog-text-primary);
}

.account-mobile-nav-link:focus-visible {
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
  outline: none;
}

.account-nav-link {
  @apply relative block pl-6 py-1 transition-[color,padding-left] duration-[var(--fsus-motion-control-fast)] text-[var(--fsusblog-text-tertiary)] hover:text-[var(--fsusblog-text-primary)] focus-visible:outline-none;
}

@media (prefers-reduced-motion: reduce) {
  .account-mobile-link-strip__indicator {
    transition-duration: var(--fsus-motion-duration-instant, 1ms);
  }
}

.account-nav-link:focus-visible {
  border-radius: var(--fsus-radius-control-small);
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
}

.account-nav-link::before {
  content: "";
  @apply absolute left-0 top-1/2 h-0 w-[2px] -translate-y-1/2 bg-[var(--fsusblog-color-primary)] transition-[height,opacity] duration-[var(--fsus-motion-control-fast)];
}

.account-nav-link:hover::before {
  @apply h-4 opacity-30;
}

.account-nav-link:focus-visible::before {
  @apply h-full opacity-100;
}

.account-nav-link-active {
  @apply text-[var(--fsusblog-text-primary)];
}

.account-nav-link-active::before {
  @apply h-full opacity-100;
}

.account-nav-link-label {
  @apply text-[13px] font-semibold normal-case tracking-normal;
}

.account-nav-link-helper {
  @apply mt-1 text-xs font-normal leading-normal opacity-50 transition-opacity group-hover:opacity-80;
}

.account-nav-link-active .account-nav-link-helper {
  @apply opacity-100;
}

.account-sidebar-index-label {
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: none;
}

.account-nav-group-title {
  display: grid;
  gap: 0.25rem;
  padding-inline: 0.25rem;
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
}

.account-nav-group-title-active {
  color: var(--fsusblog-text-primary);
}

.account-nav-group-helper {
  color: var(--fsusblog-text-subtle);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.4;
  text-transform: none;
}

</style>
