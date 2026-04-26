<template>
  <div 
    id="top" 
    class="font-sans min-h-screen flex flex-col bg-[var(--fsus-panel-bg)] text-[#0F0F11] subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-[#0F0F11] selection:text-white dark:bg-[#0F0F11] dark:text-[#FCFCFC] dark:selection:bg-[#F4F4F5] dark:selection:text-[#0F0F11]"
  >
    <MobileNav />

    <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
        <router-link
          to="/"
          class="shrink-0 inline-block rounded-[8px] text-2xl sm:text-3xl font-bold transition-opacity hover:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0F0F11]"
        >
          {{ siteStore.siteInfo.title || "Fsu's Blog" }}<span class="fsus-punctuation-motif"></span>
        </router-link>

        <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
          <router-link to="/" class="mono-link" exact-active-class="active-link">首页</router-link>
          <router-link to="/archive" class="mono-link" active-class="active-link">归档</router-link>
          <router-link to="/about" class="mono-link" active-class="active-link">关于</router-link>

          <button 
            type="button"
            @click="siteStore.setMobileSearchVisible(true)" 
            class="mono-link sm:hidden outline-none"
            aria-label="打开搜索"
          >
            搜索
          </button>

          <input
            v-model.trim="searchQuery"
            ref="searchInput"
            type="text"
            placeholder="搜索 (Ctrl+K)"
            class="hidden sm:block bg-transparent border-x-0 border-t-0 border-b border-[#F4F4F5] p-0 pb-0.5 text-sm w-12 focus:w-28 transition-[width,border-color,color] duration-500 focus:ring-0 focus:outline-none placeholder:text-[#D4D4D8] text-[#8E8E93] focus:text-[#0F0F11] focus:border-[#2A599C] dark:border-[#27272A] dark:placeholder:text-[#71717A] dark:text-[#A1A1AA] dark:focus:text-[#F4F4F5] dark:focus:border-[#2A599C]"
            @keyup.enter="handleSearch"
            @keyup.esc="searchQuery = ''"
            aria-label="搜索内容"
          />

          <ThemeModeToggle class="hidden sm:inline-flex" />

          <span class="text-[#D4D4D8] font-light dark:text-[#3F3F46]" aria-hidden="true">/</span>
          <router-link
            :to="authDestination"
            class="mono-link inline-flex items-center justify-start min-w-[3.75rem]"
            active-class="active-link"
          >
            {{ authLabel }}
          </router-link>
        </nav>
      </div>
    </header>

    <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
      <router-view v-slot="{ Component }">
        <transition name="fade-fast" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-[#F4F4F5] dark:border-[#18181B]">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
        
        <div class="text-sm text-[#8E8E93] dark:text-[#A1A1AA] font-medium tracking-normal select-none">
          &copy; {{ currentYear }} {{ siteStore.siteInfo.author }}. All rights reserved.
        </div>
        
        <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-[#8E8E93] dark:text-[#A1A1AA]">
          <a href="/api/Article/rss" class="rounded-[8px] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">RSS</a>
          <a href="#top" class="rounded-[8px] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] transition-colors flex items-center gap-2 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
            <span>回到顶部</span>
            <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
          </a>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import MobileNav from '@/components/MobileNav.vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'

const userStore = useUserStore()
const { siteStore, ensureSiteInfo } = useSessionBootstrap()
const router = useRouter()
const route = useRoute()

const searchQuery = ref('')
const searchInput = ref<HTMLInputElement | null>(null)

const currentYear = new Date().getFullYear()
const authDestination = computed(() =>
  userStore.isLoggedIn
    ? { name: userStore.isAdmin ? 'ManageDashboard' : 'UserProfile' }
    : '/login'
)
const authLabel = computed(() => {
  if (!userStore.isLoggedIn) {
    return '登录'
  }

  return userStore.isAdmin ? '控制板' : '账户'
})
/**
 * 逻辑自洽：处理搜索跳转与异常捕获
 */
const handleSearch = async () => {
  const query = searchQuery.value.trim()
  if (!query) return

  // 防止同词重复导航
  if (route.path === '/search' && route.query.q === query) return

  try {
    await router.push({ path: '/search', query: { q: query } })
    // 跳转后不立即清空，允许用户在搜索页看到自己的关键词
  } catch (err: any) {
    if (err.name !== 'NavigationDuplicated') console.error(err)
  }
}

/**
 * A11y：键盘快捷键支持 (Ctrl+K)
 */
const handleGlobalKeyDown = (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault()
    searchInput.value?.focus()
  }
}

// 监听路由变化，同步搜索框内容
watch(() => route.query.q, (newQ) => {
  if (route.path === '/search') {
    searchQuery.value = String(newQ || '')
  } else {
    searchQuery.value = ''
  }
}, { immediate: true })

onMounted(() => {
  void ensureSiteInfo()
  window.addEventListener('keydown', handleGlobalKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeyDown)
})
</script>

<style scoped>
@reference "@/assets/main.css";

.mono-link {
  @apply rounded-[8px] text-[#8E8E93] dark:text-[#A1A1AA] transition-colors duration-200 outline-none focus-visible:text-[#2A599C] dark:focus-visible:text-[#F4F4F5] focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0F0F11];
}

.mono-link:hover {
  @apply text-[#2A599C] dark:text-[#F4F4F5];
}

.active-link {
  @apply text-[#2A599C] dark:text-[#F4F4F5] font-bold;
}

:global(html) {
  scroll-behavior: smooth;
  -webkit-tap-highlight-color: transparent;
}

input, button, a {
  -webkit-tap-highlight-color: transparent;
}

.fade-fast-enter-active,
.fade-fast-leave-active {
  transition: opacity 0.2s ease-in-out;
}

.fade-fast-enter-from,
.fade-fast-leave-to {
  opacity: 0;
}
</style>
