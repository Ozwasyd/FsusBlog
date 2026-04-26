<template>
  <div class="account-layout-root account-shell min-h-screen bg-[var(--fsus-page-bg)] text-[#0F0F11] dark:bg-[#0F0F11] dark:text-[#FCFCFC] font-sans subpixel-antialiased selection:bg-[#0F0F11] selection:text-white dark:selection:bg-[#F4F4F5] dark:selection:text-[#0F0F11]">
    <a
      href="#account-main"
      class="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:left-4 focus:top-4 focus:p-4 focus:bg-[#0F0F11] dark:focus:bg-[#F4F4F5] focus:text-white dark:focus:text-[#0F0F11] focus:text-[10px] focus:font-bold focus:uppercase"
    >
      跳到主要内容
    </a>

    <header class="sticky top-0 z-40 border-b border-[var(--fsus-panel-border)] bg-[var(--fsus-page-bg)]/82 backdrop-blur-[var(--fsus-backdrop-blur)]">
      <div class="mx-auto flex h-16 max-w-[1480px] items-center justify-between gap-4 px-4 sm:h-[4.75rem] sm:px-6 lg:px-10">
        <div class="flex min-w-0 items-center gap-4 sm:gap-6">
          <router-link
            to="/"
            class="truncate text-lg font-bold transition-opacity hover:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F0F11] focus-visible:ring-offset-2 dark:focus-visible:ring-[#F4F4F5] dark:focus-visible:ring-offset-[#0F0F11]"
          >
            {{ siteStore.siteInfo.title }}
          </router-link>
          <div class="hidden h-4 w-px bg-[var(--fsus-panel-border-strong)] sm:block" aria-hidden="true"></div>
          <div class="hidden min-w-0 sm:block">
            <div class="text-[9px] font-bold uppercase text-[var(--fsus-text-muted)]">
              {{ areaMeta.eyebrow }}
            </div>
            <div class="truncate text-[11px] font-medium text-[var(--fsus-text-tertiary)]">
              {{ areaMeta.title }}
            </div>
          </div>
        </div>

        <div class="hidden items-center gap-4 lg:flex">
          <ThemeModeToggle />

          <router-link to="/" class="account-header-link">
            主站
          </router-link>

          <button
            type="button"
            class="account-header-link"
            @click="openPolicy('guidelines')"
          >
            使用规范
          </button>

          <button
            type="button"
            class="account-header-link"
            @click="openPolicy('privacy')"
          >
            隐私政策
          </button>

          <button
            type="button"
            class="account-header-link"
            :disabled="isLoggingOut"
            @click="handleLogout"
          >
            {{ isLoggingOut ? '登出中...' : '登出' }}
          </button>
        </div>

        <div class="flex items-center gap-3 lg:hidden">
          <ThemeModeToggle />
          <button
            type="button"
            class="account-mobile-menu"
            :aria-expanded="String(mobileNavOpen)"
            aria-controls="account-mobile-drawer"
            aria-label="打开账户导航"
            @click="toggleMobileNav"
          >
            <span></span>
            <span></span>
            <span></span>
          </button>
        </div>
      </div>
    </header>

    <div class="mx-auto flex w-full max-w-[1480px] flex-1 gap-5 px-4 py-5 sm:px-6 sm:py-8 lg:gap-10 lg:px-10">
      <aside class="hidden lg:block lg:w-[18rem] lg:shrink-0">
        <div class="account-shell-panel sticky top-24 space-y-8 p-7">
          <div class="space-y-4">
            <div class="text-[9px] font-bold uppercase text-[var(--fsus-text-muted)]">
              {{ areaMeta.eyebrow }}
            </div>
            <h1 class="max-w-[10ch] text-[2rem] font-bold leading-[0.94] text-[var(--fsus-text-primary)]">
              {{ areaMeta.title }}
            </h1>
            <p class="max-w-[16rem] text-[13px] leading-7 text-[var(--fsus-text-tertiary)]">
              {{ areaMeta.description }}
            </p>
          </div>

          <nav class="space-y-6" aria-label="账户导航">
            <section
              v-for="group in navGroups"
              :key="group.key"
              class="space-y-2.5"
            >
              <div
                v-if="navGroups.length > 1"
                class="px-1 text-[9px] font-bold uppercase text-[var(--fsus-text-muted)]"
              >
                {{ group.label }}
              </div>
              <router-link
                v-for="item in group.items"
                :key="item.to"
                :to="item.to"
                class="account-nav-link"
                :class="{ 'account-nav-link-active': isNavItemActive(item) }"
              >
                <div class="text-[11px] font-bold uppercase">
                  {{ item.label }}
                </div>
                <div v-if="item.helper" class="mt-1 text-[11px] leading-5 text-[#A1A1AA] dark:text-[#8E8E93]">
                  {{ item.helper }}
                </div>
              </router-link>
            </section>
          </nav>

          <div class="space-y-2 border-t border-[var(--fsus-panel-border)] pt-5">
            <button type="button" class="account-meta-link" @click="openPolicy('guidelines')">
              使用规范
            </button>
            <button type="button" class="account-meta-link" @click="openPolicy('privacy')">
              隐私政策
            </button>
          </div>
        </div>
      </aside>

      <main id="account-main" tabindex="-1" class="min-w-0 flex-1 outline-none">
        <router-view v-slot="{ Component }">
          <transition name="fade-fast" mode="out-in">
            <component :is="Component" :key="route.fullPath" class="mx-auto w-full min-w-0" :class="[contentViewportClass, contentModeClass, adminContentClass]" />
          </transition>
        </router-view>
      </main>
    </div>

    <div
      class="account-mobile-overlay fixed inset-0 z-[60] bg-[#0F0F11]/45 backdrop-blur-[2px] lg:hidden"
      :class="{ 'account-mobile-overlay--open': mobileNavOpen }"
      :aria-hidden="String(!mobileNavOpen)"
      @click="closeMobileNav"
    ></div>

    <aside
      id="account-mobile-drawer"
      class="account-mobile-drawer fixed right-0 top-0 z-[70] flex w-[min(92vw,22rem)] flex-col border-l border-[var(--fsus-panel-border)] bg-[var(--fsus-page-bg)] p-5 lg:hidden"
      :class="{ 'account-mobile-drawer--open': mobileNavOpen }"
      :aria-hidden="String(!mobileNavOpen)"
      :inert="!mobileNavOpen"
    >
        <div class="flex items-start justify-between gap-4 border-b border-[var(--fsus-panel-border)] pb-5">
          <div>
            <div class="text-[9px] font-bold uppercase text-[var(--fsus-text-muted)]">
              {{ areaMeta.eyebrow }}
            </div>
            <div class="mt-2 text-[1.75rem] font-bold leading-none">
              {{ areaMeta.title }}
            </div>
          </div>
          <button type="button" class="account-drawer-close" aria-label="关闭导航" @click="closeMobileNav">
            关闭
          </button>
        </div>

        <nav class="account-mobile-drawer-scroll mt-5 flex-1 space-y-2 overflow-y-auto" aria-label="移动账户导航">
          <router-link
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="account-nav-link"
            :class="{ 'account-nav-link-active': isNavItemActive(item) }"
            @click="closeMobileNav"
          >
            <div class="text-[11px] font-bold uppercase">
              {{ item.label }}
            </div>
            <div v-if="item.helper" class="mt-1 text-[11px] leading-5 text-[#A1A1AA] dark:text-[#8E8E93]">
              {{ item.helper }}
            </div>
          </router-link>
        </nav>

        <div class="mt-5 space-y-3 border-t border-[var(--fsus-panel-border)] pt-5">
          <router-link to="/" class="account-meta-link" @click="closeMobileNav">
            主站
          </router-link>

          <button type="button" class="account-meta-link" @click="handleMobilePolicy('guidelines')">
            使用规范
          </button>
          <button type="button" class="account-meta-link" @click="handleMobilePolicy('privacy')">
            隐私政策
          </button>
          <button type="button" class="account-meta-link" :disabled="isLoggingOut" @click="handleLogout">
            {{ isLoggingOut ? '登出中...' : '登出' }}
          </button>
        </div>
    </aside>

    <PolicyModal v-model:visible="showPolicy" :type="policyType" />
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PolicyModal from '@/components/PolicyModal.vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { accountAreaMeta, getAccountNavGroups, type AccountArea, type AccountContentMode, type AccountNavItem } from '@/layouts/accountNav'
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

let drawerScrollLockHeld = false

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
const navItems = computed(() => navGroups.value.flatMap((group) => group.items))

const contentViewportClass = computed(() => {
  if (currentContentMode.value === 'wide') {
    return 'max-w-[1600px]'
  }

  if (currentContentMode.value === 'takeover') {
    return 'max-w-none'
  }

  return 'max-w-5xl'
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

const isNavItemActive = (item: AccountNavItem): boolean => {
  if (item.match) {
    return item.match(route.path)
  }

  return route.path === item.to || route.path.startsWith(`${item.to}/`)
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

watch(mobileNavOpen, (open) => {
  if (open && !drawerScrollLockHeld) {
    siteStore.lockScroll()
    drawerScrollLockHeld = true
    return
  }

  if (!open && drawerScrollLockHeld) {
    siteStore.unlockScroll()
    drawerScrollLockHeld = false
  }
})

watch(
  () => route.fullPath,
  () => {
    mobileNavOpen.value = false
  }
)

onUnmounted(() => {
  if (drawerScrollLockHeld) {
    siteStore.unlockScroll()
    drawerScrollLockHeld = false
  }
})
</script>

<style scoped>
@reference "@/assets/main.css";

.account-header-link,
.account-meta-link {
  @apply rounded-[var(--fsus-radius-sm)] text-[10px] font-bold uppercase text-[var(--fsus-text-tertiary)] transition-colors hover:text-[var(--fsus-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40;
}

.account-nav-link {
  @apply block rounded-[var(--fsus-radius-sm)] border border-transparent px-4 py-3 text-[var(--fsus-text-tertiary)] transition-all duration-200 hover:border-[var(--fsus-panel-border)] hover:bg-[rgba(252,252,252,0.9)] hover:text-[var(--fsus-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2;
}

.account-nav-link-active {
  @apply border-[rgba(42,89,156,0.2)] bg-[rgba(42,89,156,0.08)] text-[var(--fsus-text-primary)];
  box-shadow: inset 3px 0 0 #2A599C;
}

.account-mobile-menu {
  @apply inline-flex h-11 w-11 flex-col items-center justify-center gap-1 rounded-[var(--fsus-radius-full)] border border-[var(--fsus-panel-border-strong)] bg-[rgba(252,252,252,0.8)] text-[var(--fsus-text-secondary)] transition-colors hover:border-[var(--fsus-text-muted)] hover:text-[var(--fsus-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2;
}

.account-mobile-menu span {
  @apply block h-px w-4 bg-current;
}

.account-drawer-close {
  @apply rounded-[var(--fsus-radius-sm)] text-[10px] font-bold uppercase text-[var(--fsus-text-tertiary)] transition-colors hover:text-[var(--fsus-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2;
}

.account-mobile-overlay {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
  will-change: opacity;
}

.account-mobile-overlay--open {
  opacity: 1;
  pointer-events: auto;
}

.account-mobile-drawer {
  height: 100dvh;
  max-height: 100dvh;
  opacity: 0;
  transform: translate3d(1.5rem, 0, 0);
  transition: transform 0.24s ease, opacity 0.24s ease, visibility 0.24s ease;
  visibility: hidden;
  will-change: transform, opacity;
  overscroll-behavior: contain;
  contain: layout paint;
}

.account-mobile-drawer--open {
  opacity: 1;
  transform: translate3d(0, 0, 0);
  visibility: visible;
}

.account-mobile-drawer-scroll {
  min-height: 0;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.fade-fast-enter-active,
.fade-fast-leave-active {
  transition: opacity 0.2s ease;
}

.fade-fast-enter-from,
.fade-fast-leave-to {
  opacity: 0;
}

</style>
