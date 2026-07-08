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
      title="账户导航"
      direction="ltr"
      size="min(86vw, 22rem)"
      class="account-mobile-drawer"
      :motion="fsusBlogMotionPresets.mobileDrawer"
    >
      <nav class="account-mobile-drawer-nav" aria-label="账户导航">
        <section
          v-for="group in navGroups"
          :key="group.key"
          class="account-mobile-drawer-nav__group"
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
            class="account-nav-link account-mobile-drawer-nav__link group"
            :class="{ 'account-nav-link-active': isNavItemActive(item) }"
            :aria-current="isNavItemActive(item) ? 'page' : undefined"
            @click="closeMobileDrawer"
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
      <div class="account-mobile-drawer-footer" aria-label="账户辅助链接">
        <el-button
          class="account-mobile-drawer-policy"
          link
          @click="closeMobileDrawer(), openPolicy('guidelines')"
        >
          使用规范
        </el-button>
        <span class="account-mobile-drawer-footer__divider" aria-hidden="true"></span>
        <el-button
          class="account-mobile-drawer-policy"
          link
          @click="closeMobileDrawer(), openPolicy('privacy')"
        >
          隐私政策
        </el-button>
      </div>
    </el-drawer>

    <div class="mx-auto flex w-full max-w-[var(--fsusblog-container-workbench)] flex-1 gap-5 px-4 py-5 sm:px-6 sm:py-8 lg:gap-10 lg:px-10">
      <aside class="hidden lg:block lg:w-[18rem] lg:shrink-0">
        <div class="account-sidebar-scroll sticky top-24 space-y-8 pr-6">
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
        </div>
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
import PolicyModal from '@/components/PolicyModal.vue'
import SiteChromeHeaderAdapter from '@/components/layout/SiteChromeHeaderAdapter.vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { Expand } from '@/fsusui/icons'
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion'
import { FsuTransition } from '@/fsusui/motion'
import { getAccountNavGroups, type AccountArea, type AccountContentMode, type AccountNavGroupKey, type AccountNavItem } from '@/layouts/accountNav'
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
const currentNavGroupKey = computed<AccountNavGroupKey>(() => {
  const activeGroup = [...navGroups.value].reverse().find((group) => group.items.some((item) => isNavItemActive(item)))
  return activeGroup?.key ?? (currentArea.value === 'manage' ? 'content' : 'self')
})
const currentNavGroupLabel = computed(() =>
  navGroups.value.find((group) => group.key === currentNavGroupKey.value)?.label ?? areaMeta.value.label
)
const currentNavItem = computed(() =>
  [...navGroups.value.flatMap((group) => group.items)].reverse().find((item) => isNavItemActive(item))
)

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

  if (item.to === '/user/manage') {
    return route.path === item.to
  }

  return route.path === item.to || route.path.startsWith(`${item.to}/`)
}

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

.account-nav-link {
  @apply relative block pl-6 py-1 transition-[color,padding-left] duration-[var(--fsus-motion-control-fast)] text-[var(--fsusblog-text-tertiary)] hover:text-[var(--fsusblog-text-primary)] focus-visible:outline-none;
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
  padding: 1rem 1.25rem;
}

:deep(.account-mobile-drawer .el-drawer__title) {
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 700;
}

:deep(.account-mobile-drawer .el-drawer__body) {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  gap: 1.25rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1.25rem;
}

.account-mobile-drawer-nav {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  gap: 1.25rem;
}

.account-mobile-drawer-nav__group {
  display: grid;
  gap: 0.875rem;
}

.account-mobile-drawer-nav__link {
  min-height: 2.75rem;
  padding-bottom: 0.35rem;
  padding-top: 0.35rem;
}

.account-mobile-drawer-footer {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding-top: 1rem;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

:deep(.account-mobile-drawer-policy) {
  min-height: 2.25rem;
  padding-inline: 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.75rem;
  font-weight: 700;
}

:deep(.account-mobile-drawer-policy:hover),
:deep(.account-mobile-drawer-policy:focus-visible) {
  color: var(--fsusblog-text-primary);
}

.account-mobile-drawer-footer__divider {
  width: 1px;
  height: 0.875rem;
  background: var(--fsusblog-panel-border);
}

.account-sidebar-scroll {
  max-height: calc(100vh - 7rem);
  max-height: calc(100dvh - 7rem);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding-bottom: 1.5rem;
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
    padding-bottom: 2rem;
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
