<template>
  <div class="account-layout-root account-shell min-h-screen">
    <a
      href="#account-main"
      class="account-skip-link sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:left-4 focus:top-4"
    >
      跳到主要内容
    </a>

    <header class="sticky top-0 z-40 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]/82 backdrop-blur-[var(--fsus-backdrop-blur)]">
      <div class="mx-auto flex h-16 max-w-[var(--fsusblog-container-workbench)] items-center justify-between gap-4 px-4 sm:h-[4.75rem] sm:px-6 lg:px-10">
        <div class="flex min-w-0 items-center gap-4 sm:gap-6">
          <router-link
            to="/"
            class="truncate text-lg font-bold transition-opacity hover:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]"
          >
            {{ siteStore.siteInfo.title }}
          </router-link>
          <div class="hidden h-4 w-px bg-[var(--fsusblog-panel-border-strong)] sm:block" aria-hidden="true"></div>
          <div class="hidden min-w-0 sm:block">
            <div class="text-[11px] font-bold uppercase text-[var(--fsusblog-text-muted)]">
              {{ areaMeta.eyebrow }}
            </div>
            <div class="truncate text-[11px] font-medium text-[var(--fsusblog-text-tertiary)]">
              {{ areaMeta.title }}
            </div>
          </div>
        </div>

        <div class="hidden items-center gap-4 lg:flex">
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
        </div>

        <div class="flex items-center gap-3 lg:hidden">
          <ThemeModeToggle />
          <el-button
            circle
            :icon="Menu"
            :aria-expanded="String(mobileNavOpen)"
            aria-controls="account-mobile-drawer"
            :aria-label="mobileNavButtonLabel"
            @click="toggleMobileNav"
          />
        </div>
      </div>
    </header>

    <div class="mx-auto flex w-full max-w-[var(--fsusblog-container-workbench)] flex-1 gap-5 px-4 py-5 sm:px-6 sm:py-8 lg:gap-10 lg:px-10">
      <aside class="hidden lg:block lg:w-[18rem] lg:shrink-0">
        <div class="sticky top-24 space-y-12 pr-6">
          <div class="space-y-5">
            <div class="text-[11px] font-bold uppercase tracking-normal text-[var(--fsusblog-text-muted)]">
              {{ areaMeta.eyebrow }}
            </div>
            <h1 class="text-[2.25rem] font-bold leading-[0.9] tracking-normal text-[var(--fsusblog-text-primary)]">
              {{ areaMeta.title }}
            </h1>
            <p class="text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">
              {{ areaMeta.description }}
            </p>
          </div>

          <nav class="space-y-9" aria-label="账户导航">
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

      <main id="account-main" tabindex="-1" class="min-w-0 flex-1 outline-none">
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
        <div class="flex items-start justify-between gap-4 border-b border-[var(--fsusblog-panel-border)] pb-5">
          <div>
            <div class="text-[11px] font-bold uppercase text-[var(--fsusblog-text-muted)]">
              {{ areaMeta.eyebrow }}
            </div>
            <div class="mt-2 text-[1.75rem] font-bold leading-none">
              {{ areaMeta.title }}
            </div>
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
                  :aria-expanded="String(isMobileGroupExpanded(group.key))"
                  @click="toggleMobileGroup(group.key)"
                >
                  <span>{{ group.label }}</span>
                  <span v-if="group.helper" class="account-mobile-nav-group-helper">{{ group.helper }}</span>
                </button>
                <div v-show="isMobileGroupExpanded(group.key)" class="account-mobile-nav-group-items">
                  <router-link
                    v-for="item in group.items"
                    :key="item.to"
                    :to="item.to"
                    class="account-nav-link group"
                    :class="{ 'account-nav-link-active': isNavItemActive(item) }"
                    @click="closeMobileNav"
                  >
                    <div class="text-[11px] font-bold uppercase">
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
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { accountAreaMeta, getAccountNavGroups, type AccountArea, type AccountContentMode, type AccountNavGroupKey, type AccountNavItem } from '@/layouts/accountNav'
import { useSiteStore } from '@/store/site'
import { useUserStore } from '@/store/user'
import { showErrorToast } from '@/utils/errorPresentation'

const route = useRoute()
const siteStore = useSiteStore()
const userStore = useUserStore()

const showPolicy = ref(false)
const policyType = ref<'privacy' | 'guidelines'>('guidelines')
const mobileNavOpen = ref(false)
const isLoggingOut = ref(false)
const openMobileGroupKey = ref<AccountNavGroupKey>('self')
const mobileNavButtonLabel = computed(() => mobileNavOpen.value ? '关闭账户导航' : '打开账户导航')

const currentArea = computed<AccountArea>(() =>
  route.meta.accountArea === 'manage' ? 'manage' : 'self'
)

const currentContentMode = computed<AccountContentMode>(() => {
  const mode = route.meta.accountContentMode
  if (mode === 'wide' || mode === 'takeover') {
    return mode
  }
  return 'standard'
})

const areaMeta = computed(() => accountAreaMeta[currentArea.value])
const navGroups = computed(() => getAccountNavGroups(userStore.isAdmin))
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
    await userStore.logout()
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
  @apply inline-flex items-center rounded-[var(--fsus-radius-control-small)] text-[11px] font-bold uppercase tracking-normal text-[var(--fsusblog-text-tertiary)] transition-colors hover:text-[var(--fsusblog-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-40;
}

.account-skip-link:focus {
  padding: 1rem;
  background: var(--fsusblog-text-primary);
  color: var(--fsusblog-page-bg);
  font-size: 0.625rem;
  font-weight: 700;
  text-transform: uppercase;
}

.account-nav-link {
  @apply relative block pl-6 py-1 transition-[color,padding-left] duration-[var(--fsus-motion-control-fast)] text-[var(--fsusblog-text-tertiary)] hover:text-[var(--fsusblog-text-primary)] focus-visible:outline-none;
}

.account-nav-link:focus-visible {
  border-radius: var(--fsus-radius-control-small);
  box-shadow: 0 0 0 2px var(--fsusblog-color-focus-ring);
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
  @apply text-[11px] font-bold uppercase tracking-normal;
}

.account-nav-link-helper {
  @apply mt-1 text-[11px] font-medium leading-normal opacity-50 transition-opacity group-hover:opacity-80;
}

.account-nav-link-active .account-nav-link-helper {
  @apply opacity-100;
}

.account-nav-group-title {
  display: grid;
  gap: 0.25rem;
  padding-inline: 0.25rem;
  color: var(--fsusblog-text-muted);
  font-size: 0.6875rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
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
  font-size: 0.6875rem;
  font-weight: 800;
  letter-spacing: 0;
  text-align: left;
  text-transform: uppercase;
}

.account-mobile-nav-group-button:focus-visible {
  border-radius: var(--fsus-radius-control-small);
  box-shadow: 0 0 0 2px var(--fsusblog-color-focus-ring);
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
