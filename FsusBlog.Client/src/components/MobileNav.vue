<template>
  <button 
    @click="toggleMenu" 
    class="fixed top-5 right-6 z-250 w-12 h-12 flex flex-col items-center justify-center gap-1.5 sm:hidden transition-all active:scale-90 select-none"
    :aria-expanded="isOpen"
    aria-label="Toggle Menu"
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

  <SearchModal v-model:visible="isSearchOpen" />

  <Teleport to="body">
    <transition name="menu-fade">
      <div 
        v-if="isOpen" 
        class="fixed inset-0 z-200 bg-white flex flex-col overflow-hidden touch-none overscroll-none"
      >
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none select-none overflow-hidden">
          <span class="text-[30vw] font-black text-zinc-50 tracking-tighter leading-none uppercase">
            菜单
          </span>
        </div>

        <nav class="relative grow flex flex-col justify-center px-10 sm:px-12 space-y-6">
          <div class="overflow-hidden">
            <button 
              @click="openSearch"
              class="inline-block text-5xl font-black tracking-tighter text-zinc-950 hover:text-zinc-400 transition-colors animate-in slide-in-from-bottom-full duration-700"
            >
              搜索
            </button>
          </div>

          <div 
            v-for="(link, index) in navLinks" 
            :key="link.path"
            class="overflow-hidden"
          >
            <router-link 
              :to="link.path" 
              @click="closeMenu"
              class="inline-block text-5xl font-black tracking-tighter text-zinc-950 hover:text-zinc-400 transition-colors animate-in slide-in-from-bottom-full duration-700"
              :style="{ animationDelay: `${(index + 1) * 80}ms` }"
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
              {{ siteStore.siteInfo.description || '记录技术与生活' }}
            </p>
          </div>
          
          <span class="text-[9px] font-mono text-zinc-200 uppercase tracking-[0.4em] rotate-180 [writing-mode:vertical-lr] hidden xs:block">
            保持最小化
          </span>
        </footer>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useUserStore } from '@/store/user'
import { useSiteStore } from '@/store/site'
import SearchModal from '@/components/SearchModal.vue'

const userStore = useUserStore()
const siteStore = useSiteStore()

const isOpen = ref(false)
const isSearchOpen = ref(false)

/**
 * 🌟 核心优化：动态计算导航链接
 * 根据登录状态和权限实时切换“账户/控制板/登录”
 */
const navLinks = computed(() => {
  const baseLinks = [
    { name: '首页', path: '/' },
    { name: '归档', path: '/archive' },
    { name: '关于', path: '/about' },
  ]

  if (userStore.isLoggedIn) {
    baseLinks.push({ 
      name: userStore.isAdmin ? '控制板' : '账户', 
      path: userStore.isAdmin ? '/admin' : '/user/profile' 
    })
  } else {
    baseLinks.push({ name: '登录', path: '/login' })
  }

  return baseLinks
})

const toggleMenu = () => {
  isOpen.value = !isOpen.value
}

/**
 * 🌟 核心：关闭菜单并恢复 body 滚动
 */
const closeMenu = () => {
  isOpen.value = false
  document.body.style.overflow = ''
}

const openSearch = () => {
  isOpen.value = false 
  isSearchOpen.value = true 
}

const handleExternalSearch = () => {
  openSearch()
}

// 统一监听 BlogLayout 发出的搜索事件
onMounted(() => {
  window.addEventListener('toggle-mobile-search', handleExternalSearch)
})

/**
 * 🌟 滚动锁定管理
 * 监听菜单和搜索框状态，防止背景滚动
 */
watch([isOpen, isSearchOpen], ([menuVal, searchVal]) => {
  if (menuVal || searchVal) {
    document.body.style.setProperty('overflow', 'hidden')
  } else {
    document.body.style.removeProperty('overflow')
  }
})

onUnmounted(() => {
  window.removeEventListener('toggle-mobile-search', handleExternalSearch)
  // 组件销毁前必须强制移除锁定，防止白屏或无法滚动
  document.body.style.removeProperty('overflow')
})
</script>

<style scoped>
@reference "@/assets/main.css";

.menu-fade-enter-active,
.menu-fade-leave-active {
  transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
}

@media (max-width: 360px) {
  nav button, nav a { @apply text-4xl; }
  footer { @apply py-8 px-8; }
}

nav a, nav button {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>