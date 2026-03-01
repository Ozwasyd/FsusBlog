<template>
  <!-- 触发按钮 -->
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
      class="w-6 h-0.5 bg-zinc-950 transition-all duration-300 origin-center" 
      :class="isOpen ? 'rotate-45 translate-y-2' : ''"
    ></div>
    <div 
      class="w-6 h-0.5 bg-zinc-950 transition-opacity duration-200" 
      :class="isOpen ? 'opacity-0' : 'opacity-100'"
    ></div>
    <div 
      class="w-6 h-0.5 bg-zinc-950 transition-all duration-300 origin-center" 
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
        class="fixed inset-0 z-200 bg-white flex flex-col overflow-hidden touch-none overscroll-none"
      >
        <!-- 背景装饰 -->
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none select-none overflow-hidden opacity-5">
          <span class="text-[30vw] font-black text-zinc-900 tracking-tighter leading-none uppercase">
            菜单
          </span>
        </div>

        <nav class="relative grow flex flex-col justify-center px-10 sm:px-12 space-y-6">
          <div class="overflow-hidden">
            <button 
              type="button"
              @click="openSearch"
              class="inline-block text-5xl font-black tracking-tighter text-zinc-950 hover:text-zinc-400 transition-colors animate-mobile-nav-in"
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
            <!-- [修复 2026-02-23] 逻辑自洽：使用 routeName 作为 Key，修复 TS 2339 错误 -->
            <router-link 
              :to="{ name: link.routeName }" 
              @click="closeMenu"
              class="inline-block text-5xl font-black tracking-tighter text-zinc-950 hover:text-zinc-400 transition-colors animate-mobile-nav-in"
              :style="{ '--stagger': index + 1 }"
            >
              {{ link.name }}
            </router-link>
          </div>
        </nav>

        <footer class="relative px-10 sm:px-12 py-12 border-t border-zinc-100 flex justify-between items-end bg-white">
          <div class="space-y-3">
            <p class="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-950">
              {{ siteStore.siteInfo.title }} &copy; 2026
            </p>
            <p class="text-[9px] font-medium text-zinc-400 uppercase tracking-widest leading-relaxed max-w-50">
              {{ siteStore.siteInfo.description }}
            </p>
          </div>
          
          <span class="text-[9px] font-mono text-zinc-200 uppercase tracking-[0.4em] rotate-180 [writing-mode:vertical-lr] hidden xs:block">
            最小化
          </span>
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

const route = useRoute()
const userStore = useUserStore()
const siteStore = useSiteStore()

const isOpen = ref(false)

/**
 * [修复 2026-02-23] 状态变更动作收敛
 */
const isSearchVisible = computed({
  get: () => siteStore.isMobileSearchOpen,
  set: (val) => siteStore.setMobileSearchVisible(val)
})

/**
 * [修复 2026-02-23] 导航数据构造：使用 routeName 确保类型安全
 */
const navLinks = computed(() => {
  const base = [
    { name: '首页', routeName: 'Home' },
    { name: '归档', routeName: 'Archive' },
    { name: '关于', routeName: 'About' },
  ]

  if (userStore.isLoggedIn) {
    base.push({ 
      name: userStore.isAdmin ? '控制板' : '账户', 
      routeName: userStore.isAdmin ? 'AdminDashboard' : 'UserProfile' 
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