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
        <router-link to="/" class="account-header-link">
          主站
        </router-link>
        <ThemeModeToggle />
        <AccountHeaderMenu
          :can-manage="workspaceContext.canManage"
          :current-area="currentArea"
          :is-logging-out="isLoggingOut"
          @open-policy="openPolicy"
          @logout="handleLogout"
        />
      </template>

      <template #mobile-primary-actions>
        <router-link to="/" class="account-header-link account-header-link--mobile">
          主站
        </router-link>
        <ThemeModeToggle />
        <AccountHeaderMenu
          :can-manage="workspaceContext.canManage"
          compact
          :current-area="currentArea"
          :is-logging-out="isLoggingOut"
          @open-policy="openPolicy"
          @logout="handleLogout"
        />
        <button
          type="button"
          class="account-mobile-drawer-trigger"
          :aria-label="`打开账户导航：${currentNavGroupLabel} / ${currentNavItem?.label ?? '当前页面'}`"
          @click="mobileDrawerVisible = true"
        >
          <el-icon :size="18" aria-hidden="true"><Expand /></el-icon>
        </button>
      </template>
    </SiteChromeHeaderAdapter>

    <el-drawer
      id="account-mobile-drawer"
      v-model="mobileDrawerVisible"
      :title="mobileDrawerTitle"
      direction="ltr"
      size="min(86vw, 22rem)"
      class="account-mobile-drawer"
      :motion="fsusBlogMotionPresets.mobileDrawer"
    >
      <AccountNavigationPanel
        class="account-mobile-drawer-nav"
        :area-label="areaMeta.label"
        :groups="navGroups"
        variant="mobile"
        @navigate="closeMobileDrawer"
      />
    </el-drawer>

    <div class="mx-auto flex w-full max-w-[var(--fsusblog-container-workbench)] flex-1 gap-5 px-4 py-5 sm:px-6 sm:py-8 lg:gap-10 lg:px-10">
      <aside class="hidden lg:block lg:w-[18rem] lg:shrink-0">
        <AccountNavigationPanel
          class="account-sidebar-frame sticky top-24 pr-6"
          :area-label="areaMeta.label"
          :groups="navGroups"
          heading-id="account-shell-area-title"
          variant="desktop"
        />
      </aside>

      <main id="account-main" tabindex="-1" class="account-main-scroll min-w-0 flex-1 outline-none" aria-labelledby="account-shell-area-title">
        <router-view v-slot="{ Component }">
          <FsuTransition :name="fsusBlogMotionPresets.route" mode="out-in" :duration="220">
            <component :is="Component" :key="accountRouteViewKey" class="mx-auto w-full min-w-0" :class="[contentViewportClass, contentModeClass, adminContentClass]" />
          </FsuTransition>
        </router-view>
      </main>
    </div>

    <PolicyModal v-model:visible="showPolicy" :type="policyType" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import AccountHeaderMenu from '@/components/account/AccountHeaderMenu.vue'
import AccountNavigationPanel from '@/components/account/AccountNavigationPanel.vue'
import PolicyModal from '@/components/PolicyModal.vue'
import SiteChromeHeaderAdapter from '@/components/layout/SiteChromeHeaderAdapter.vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { Expand } from '@/fsusui/icons'
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion'
import { FsuTransition } from '@/fsusui/motion'
import {
  getAccountNavGroups,
  isAccountNavGroupActive,
  isAccountNavItemActive,
  type AccountArea,
  type AccountContentMode
} from '@/layouts/accountNav'
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext'
import { showErrorToast } from '@/utils/errorPresentation'

const route = useRoute()
const workspaceContext = useAccountWorkspaceContext()

const showPolicy = ref(false)
const policyType = ref<'privacy' | 'guidelines'>('guidelines')
const isLoggingOut = ref(false)
const mobileDrawerVisible = ref(false)

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
const currentNavGroup = computed(() => (
  [...navGroups.value].reverse().find((group) => isAccountNavGroupActive(group, route.path))
  ?? navGroups.value[0]
  ?? null
))
const currentNavGroupLabel = computed(() =>
  currentNavGroup.value?.label ?? areaMeta.value.label
)
const currentNavItem = computed(() =>
  [...(currentNavGroup.value?.items ?? [])].reverse().find((item) => (
    isAccountNavItemActive(item, route.path)
  ))
)
const mobileDrawerTitle = computed(() => `${areaMeta.value.label}导航 · ${currentNavGroupLabel.value}`)

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

const openPolicy = (type: 'privacy' | 'guidelines') => {
  policyType.value = type
  showPolicy.value = true
}

const closeMobileDrawer = (): void => {
  mobileDrawerVisible.value = false
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
</script>

<style scoped>
@reference "@/assets/main.css";

.account-header-link {
  @apply inline-flex min-h-9 items-center justify-center rounded-[var(--fsus-radius-control-small)] px-2 text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-tertiary)] transition-colors hover:text-[var(--fsusblog-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60;
}

.account-header-link--mobile {
  min-height: 2.5rem;
}

:deep(.account-header-brand) {
  display: inline-flex;
  min-height: 2.5rem;
  min-width: 0;
  align-items: center;
  gap: var(--fsus-space-2);
  color: var(--fsusblog-text-primary);
  text-decoration: none;
}

.account-skip-link:focus-visible {
  padding: var(--fsus-space-4);
  background: var(--fsusblog-text-primary);
  color: var(--fsusblog-page-bg);
  font-size: 12px;
  font-weight: 700;
  text-transform: none;
}

.account-mobile-drawer-trigger {
  display: inline-flex;
  min-height: 2.5rem;
  width: 2.5rem;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--fsus-radius-control-small);
  background: transparent;
  color: var(--fsusblog-text-primary);
  padding: 0;
  transition:
    border-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    background-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-mobile-drawer-trigger:hover {
  border-color: var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
}

.account-mobile-drawer-trigger:focus-visible {
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
  outline: none;
}

:deep(.account-mobile-drawer) {
  display: flex;
  height: 100vh;
  height: 100dvh;
  max-height: 100dvh;
  flex-direction: column;
  overflow: hidden;
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
}

:deep(.account-mobile-drawer .el-drawer__header) {
  margin-bottom: 0;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  padding: var(--fsus-space-4) var(--fsus-space-5);
}

:deep(.account-mobile-drawer .el-drawer__title) {
  color: var(--fsusblog-text-primary);
  font-size: 14px;
  font-weight: 700;
}

:deep(.account-mobile-drawer .el-drawer__body) {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  gap: var(--fsus-space-5);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--fsus-space-5);
}

.account-mobile-drawer-nav {
  flex: 0 0 auto;
  padding-bottom: env(safe-area-inset-bottom, 0);
}

.account-sidebar-frame {
  padding-bottom: var(--fsus-space-6);
}

.account-main-scroll {
  min-height: 0;
}

@media (min-width: 1024px) {
  .account-main-scroll {
    max-height: calc(100vh - 7rem);
    max-height: calc(100dvh - 7rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding-bottom: var(--fsus-space-8);
  }
}

@media (max-height: 520px) and (orientation: landscape) {
  :deep(.account-site-header__inner) {
    padding-block: var(--fsus-space-2);
  }

  :deep(.account-site-header__primary-row) {
    gap: var(--fsus-space-3);
  }

  :deep(.account-site-header__actions) {
    display: none;
  }

  :deep(.account-site-header__mobile-actions) {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fsus-space-2);
  }
}

</style>
