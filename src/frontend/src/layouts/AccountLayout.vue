<template>
  <div class="account-layout-root account-shell min-h-screen">
    <a
      href="#account-main"
      class="account-skip-link sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:left-4 focus:top-4"
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
          link
          @click="openPolicy('guidelines')"
        >
          使用规范
        </el-button>

        <el-button
          link
          @click="openPolicy('privacy')"
        >
          隐私政策
        </el-button>

        <el-button
          link
          :disabled="isLoggingOut"
          @click="handleLogout"
        >
          {{ isLoggingOut ? '登出中...' : '登出' }}
        </el-button>
      </template>

      <template #mobile-primary-actions>
        <ThemeModeToggle />
        <el-button
          circle
          :icon="Menu"
          :aria-expanded="mobileNavOpen"
          aria-controls="account-mobile-drawer"
          :aria-label="mobileNavButtonLabel"
          @click="toggleMobileNav"
        />
      </template>
    </SiteChromeHeaderAdapter>

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
          <transition name="fade-fast" mode="out-in">
            <component :is="Component" :key="accountRouteViewKey" class="mx-auto w-full min-w-0" :class="[contentViewportClass, contentModeClass, adminContentClass]" />
          </transition>
        </router-view>
      </main>
    </div>

    <el-drawer
      v-model="mobileNavOpen"
      direction="rtl"
      size="min(92vw, 22rem)"
      :with-header="false"
    >
      <div id="account-mobile-drawer" class="flex h-full min-h-0 flex-col">
        <div class="flex items-center justify-between gap-4 border-b border-[var(--fsusblog-panel-border)] pb-5">
          <div class="text-sm font-semibold normal-case tracking-normal text-[var(--fsusblog-text-primary)]">
            {{ areaMeta.label }}导航
          </div>
          <el-button circle :icon="Close" aria-label="关闭导航" @click="closeMobileNav" />
        </div>

        <div class="mt-5 min-h-0 flex-1">
          <el-scrollbar>
            <nav class="space-y-2 pr-2" aria-label="移动账户导航">
              <section
                v-for="group in navGroups"
                :key="group.key"
                class="account-mobile-nav-group"
                :class="{ 'account-mobile-nav-group-active': currentNavGroupKey === group.key }"
              >
                <button
                  type="button"
                  class="account-mobile-nav-group-button"
                  :aria-expanded="isMobileGroupExpanded(group.key)"
                  @click="toggleMobileGroup(group.key)"
                >
                  <span>{{ group.label }}</span>
                  <span v-if="group.helper" class="account-mobile-nav-group-helper">{{ group.helper }}</span>
                </button>
                <div v-if="isMobileGroupExpanded(group.key)" class="account-mobile-nav-group-items">
                  <router-link
                    v-for="item in group.items"
                    :key="item.to"
                    :to="item.to"
                    class="account-nav-link group"
                    :class="{ 'account-nav-link-active': isNavItemActive(item) }"
                    @click="closeMobileNav"
                  >
                    <div class="text-[13px] font-semibold normal-case">
                      {{ item.label }}
                    </div>
                    <div v-if="item.helper" class="account-nav-link-helper">
                      {{ item.helper }}
                    </div>
                  </router-link>
                </div>
              </section>
            </nav>
          </el-scrollbar>
        </div>

        <div class="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--fsusblog-panel-border)] pt-6">
          <router-link to="/" class="account-meta-link" @click="closeMobileNav">
            主站
          </router-link>
          <span class="h-0.5 w-0.5 rounded-[var(--fsus-radius-pill)] bg-[var(--fsusblog-text-muted)]" aria-hidden="true"></span>
          <el-button link @click="handleMobilePolicy('guidelines')">
            使用规范
          </el-button>
          <span class="h-0.5 w-0.5 rounded-[var(--fsus-radius-pill)] bg-[var(--fsusblog-text-muted)]" aria-hidden="true"></span>
          <el-button link @click="handleMobilePolicy('privacy')">
            隐私政策
          </el-button>
          <span class="h-0.5 w-0.5 rounded-[var(--fsus-radius-pill)] bg-[var(--fsusblog-text-muted)]" aria-hidden="true"></span>
          <el-button link :disabled="isLoggingOut" @click="handleLogout">
            {{ isLoggingOut ? '登出中...' : '登出' }}
          </el-button>
        </div>
      </div>
    </el-drawer>

    <PolicyModal v-model:visible="showPolicy" :type="policyType" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Close, Menu } from '@/fsusui/icons'
import PolicyModal from '@/components/PolicyModal.vue'
import SiteChromeHeaderAdapter from '@/components/layout/SiteChromeHeaderAdapter.vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { getAccountNavGroups, type AccountArea, type AccountContentMode, type AccountNavGroupKey, type AccountNavItem } from '@/layouts/accountNav'
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext'
import { showErrorToast } from '@/utils/errorPresentation'

const route = useRoute()
const workspaceContext = useAccountWorkspaceContext()

const showPolicy = ref(false)
const policyType = ref<'privacy' | 'guidelines'>('guidelines')
const mobileNavOpen = ref(false)
const isLoggingOut = ref(false)
const openMobileGroupKey = ref<AccountNavGroupKey>('self')
const mobileNavButtonLabel = computed(() => mobileNavOpen.value ? '关闭账户导航' : '打开账户导航')

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
  const activeGroup = navGroups.value.find((group) => group.items.some((item) => isNavItemActive(item)))
  return activeGroup?.key ?? (currentArea.value === 'manage' ? 'content' : 'self')
})

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
  const routeName = typeof route.name === 'string' ? route.name : route.path
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

const isMobileGroupExpanded = (key: AccountNavGroupKey): boolean => openMobileGroupKey.value === key

const toggleMobileGroup = (key: AccountNavGroupKey): void => {
  openMobileGroupKey.value = key
}

const openPolicy = (type: 'privacy' | 'guidelines') => {
  policyType.value = type
  showPolicy.value = true
}

const closeMobileNav = () => {
  mobileNavOpen.value = false
}

const toggleMobileNav = () => {
  mobileNavOpen.value = !mobileNavOpen.value
}

const handleMobilePolicy = (type: 'privacy' | 'guidelines') => {
  closeMobileNav()
  openPolicy(type)
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
    mobileNavOpen.value = false
    openMobileGroupKey.value = currentNavGroupKey.value
  }
)

watch(mobileNavOpen, (open) => {
  if (open) {
    openMobileGroupKey.value = currentNavGroupKey.value
  }
}, { immediate: true })
</script>

<style scoped>
@reference "@/assets/main.css";

.account-header-link,
.account-meta-link {
  @apply inline-flex items-center rounded-[var(--fsus-radius-control-small)] text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-tertiary)] transition-colors hover:text-[var(--fsusblog-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-40;
}

:deep(.account-header-brand) {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
  color: var(--fsusblog-text-primary);
  text-decoration: none;
}

.account-skip-link:focus {
  padding: 1rem;
  background: var(--fsusblog-text-primary);
  color: var(--fsusblog-page-bg);
  font-size: 0.625rem;
  font-weight: 700;
  text-transform: none;
}

.account-nav-link {
  @apply relative block pl-6 py-1 transition-[color,padding-left] duration-[var(--fsus-motion-control-fast)] text-[var(--fsusblog-text-tertiary)] hover:text-[var(--fsusblog-text-primary)] focus-visible:outline-none;
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
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.4;
  text-transform: none;
}

.account-mobile-nav-group {
  border-bottom: 1px solid var(--fsusblog-panel-border);
  padding-block: 0.5rem;
}

.account-mobile-nav-group-button {
  display: grid;
  width: 100%;
  gap: 0.25rem;
  padding: 0.75rem 0.25rem;
  color: var(--fsusblog-text-muted);
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0;
  text-align: left;
  text-transform: none;
}

.account-mobile-nav-group-button:focus-visible {
  border-radius: var(--fsus-radius-control-small);
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
  outline: none;
}

.account-mobile-nav-group-active .account-mobile-nav-group-button {
  color: var(--fsusblog-text-primary);
}

.account-mobile-nav-group-helper {
  color: var(--fsusblog-text-subtle);
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.4;
  text-transform: none;
}

.account-mobile-nav-group-items {
  display: grid;
  gap: 0.5rem;
  padding: 0.25rem 0 0.75rem;
}

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
