<template>
  <button
    id="mobile-menu-trigger"
    type="button"
    @click="toggleMenu"
    class="fixed top-5 right-6 z-250 w-12 h-12 flex flex-col items-center justify-center gap-1.5 sm:hidden transition-all active:scale-90 select-none outline-none"
    :aria-expanded="isOpen"
    aria-controls="mobile-menu-overlay"
    aria-label="切换菜单"
  >
    <div
      class="w-6 h-0.5 bg-[#0F0F11] dark:bg-[#F4F4F5] transition-all duration-300 origin-center"
      :class="isOpen ? 'rotate-45 translate-y-2' : ''"
    ></div>
    <div
      class="w-6 h-0.5 bg-[#0F0F11] dark:bg-[#F4F4F5] transition-opacity duration-200"
      :class="isOpen ? 'opacity-0' : 'opacity-100'"
    ></div>
    <div
      class="w-6 h-0.5 bg-[#0F0F11] dark:bg-[#F4F4F5] transition-all duration-300 origin-center"
      :class="isOpen ? '-rotate-45 -translate-y-2' : ''"
    ></div>
  </button>

  <SearchModal v-model:visible="isSearchVisible" />

  <Teleport to="body">
    <transition name="menu-fade">
      <div
        v-if="isOpen"
        id="mobile-menu-overlay"
        role="dialog"
        aria-modal="true"
        class="fixed inset-0 z-200 bg-[var(--fsus-panel-bg)] dark:bg-[#0F0F11] flex flex-col overflow-hidden touch-none overscroll-none"
      >
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none select-none overflow-hidden opacity-5">
          <span class="text-[30vw] font-black text-[#18181B] tracking-normal leading-none uppercase">
            菜单
          </span>
        </div>

        <nav class="relative grow flex flex-col justify-center px-6 sm:px-12 space-y-5 sm:space-y-6">
          <div class="overflow-hidden">
            <button
              type="button"
              @click="openSearch"
              class="inline-block text-4xl sm:text-5xl font-black tracking-normal text-[#0F0F11] dark:text-[#F4F4F5] hover:text-[#A1A1AA] dark:hover:text-[#D4D4D8] transition-colors animate-mobile-nav-in"
              style="--stagger: 0"
            >
              搜索
            </button>
          </div>

          <div
            v-for="(link, index) in navLinks"
            :key="link.routeName"
            class="overflow-hidden"
          >
            <router-link
              :to="{ name: link.routeName }"
              @click="closeMenu"
              class="inline-block text-4xl sm:text-5xl font-black tracking-normal text-[#0F0F11] dark:text-[#F4F4F5] hover:text-[#A1A1AA] dark:hover:text-[#D4D4D8] transition-colors animate-mobile-nav-in"
              :style="{ '--stagger': index + 1 }"
            >
              {{ link.name }}
            </router-link>
          </div>
        </nav>

        <footer class="relative px-6 sm:px-12 py-8 sm:py-12 border-t border-[#F4F4F5] dark:border-[#27272A] flex flex-col sm:flex-row justify-between items-start sm:items-end gap-6 bg-[var(--fsus-panel-bg)] dark:bg-[#0F0F11]">
          <div class="space-y-3">
            <p class="text-[10px] font-black uppercase tracking-normal text-[#0F0F11] dark:text-[#F4F4F5]">
              {{ siteStore.siteInfo.title }} &copy; 2026
            </p>
            <p class="text-[9px] font-medium text-[#A1A1AA] uppercase tracking-normal leading-relaxed max-w-50">
              {{ siteStore.siteInfo.description }}
            </p>
          </div>
          <div class="flex items-center gap-5">
            <ThemeModeToggle />
            <span class="text-[9px] font-mono text-[#E4E4E7] dark:text-[#3F3F46] uppercase tracking-normal hidden xs:block">
              最小化
            </span>
          </div>
        </footer>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useSiteStore } from '@/store/site'
import SearchModal from '@/components/SearchModal.vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'

const route = useRoute()
const userStore = useUserStore()
const siteStore = useSiteStore()

const isOpen = ref(false)

const isSearchVisible = computed({
  get: () => siteStore.isMobileSearchOpen,
  set: (val) => siteStore.setMobileSearchVisible(val)
})

const navLinks = computed(() => {
  const base = [
    { name: '首页', routeName: 'Home' },
    { name: '归档', routeName: 'Archive' },
    { name: '关于', routeName: 'About' },
  ]

  if (userStore.isLoggedIn) {
    base.push({
      name: userStore.isAdmin ? '控制板' : '账户',
      routeName: userStore.isAdmin ? 'ManageDashboard' : 'UserProfile'
    })
  } else {
    base.push({ name: '登录', routeName: 'Login' })
  }

  return base
})

const toggleMenu = () => {
  isOpen.value = !isOpen.value
}

const closeMenu = () => {
  isOpen.value = false
}

const openSearch = () => {
  isOpen.value = false
  siteStore.setMobileSearchVisible(true)
}

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    if (isOpen.value) closeMenu()
    if (siteStore.isMobileSearchOpen) siteStore.setMobileSearchVisible(false)
  }
}

watch(() => route.path, () => {
  if (isOpen.value) closeMenu()
})

watch(
  [isOpen, () => siteStore.isMobileSearchOpen],
  ([mOpen, sOpen]) => {
    const shouldLock = mOpen || sOpen
    if (shouldLock) {
      siteStore.lockScroll()
      window.addEventListener('keydown', handleKeyDown)
    } else {
      siteStore.unlockScroll()
      window.removeEventListener('keydown', handleKeyDown)
    }
  }
)

onUnmounted(() => {
  siteStore.forceUnlockScroll()
  window.removeEventListener('keydown', handleKeyDown)
})
</script>

<style scoped>
@reference "@/assets/main.css";

.animate-mobile-nav-in {
  animation: slide-up 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--stagger) * 80ms);
}

@keyframes slide-up {
  from {
    opacity: 0;
    transform: translateY(100%);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.menu-fade-enter-active,
.menu-fade-leave-active {
  transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
}

@media (max-width: 360px) {
  nav button, nav a { font-size: 2.25rem; line-height: 2.5rem; }
  footer { padding: 2rem; }
}

nav a, nav button {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>
