<template>
  <div 
    id="top" 
    class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white"
  >
    <MobileNav />
    
    <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
        
        <div class="shrink-0">
          <router-link to="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">
            {{ siteStore.isLoaded ? siteStore.siteInfo.title : '...' }}<span class="text-zinc-400">.</span>
          </router-link>
        </div>

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

          <div class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300">
            <input 
              v-model.trim="searchQuery"
              type="text" 
              placeholder="搜索 (Ctrl+K)" 
              class="bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5"
              @keyup.enter="handleSearch"
              @keyup.esc="searchQuery = ''"
              ref="searchInput"
              aria-label="搜索内容"
            />
          </div>

          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>

          <!-- 
            [修复 2026-02-24] 乐观 UI 策略：
            不再使用 isAuthChecked 阻塞渲染。如果本地有 userInfo，直接显示入口。
            如果后端握手返回 401，userInfo 会被自动置空，视图随之优雅切换。
          -->
          <template v-if="userStore.isLoggedIn">
            <router-link 
              :to="{ name: userStore.isAdmin ? 'AdminDashboard' : 'UserProfile' }" 
              class="mono-link"
              active-class="active-link"
            >
              {{ userStore.isAdmin ? '控制板' : '账户' }}
            </router-link>
          </template>
          <template v-else-if="userStore.isAuthChecked">
            <router-link to="/login" class="mono-link" active-class="active-link">登录</router-link>
          </template>
          <template v-else>
            <!-- 正在握手时的极简占位 -->
            <span class="text-zinc-300 animate-pulse font-mono text-[10px]">AUTH</span>
          </template>
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

    <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
        
        <div class="text-sm text-zinc-500 font-medium tracking-normal select-none">
          &copy; {{ currentYear }} {{ siteStore.siteInfo.author }}. All rights reserved.
        </div>
        
        <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500">
          <a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a>
          <a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group">
            <span>回到顶部</span>
            <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
          </a>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useSiteStore } from '@/store/site'
import MobileNav from '@/components/MobileNav.vue'

const userStore = useUserStore()
const siteStore = useSiteStore()
const router = useRouter()
const route = useRoute()

const searchQuery = ref('')
const searchInput = ref<HTMLInputElement | null>(null)

const currentYear = new Date().getFullYear()
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
  window.addEventListener('keydown', handleGlobalKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeyDown)
})
</script>

<style scoped>
@reference "@/assets/main.css";

.font-sans { letter-spacing: 0.01em; }

.mono-link {
  @apply text-zinc-500 transition-colors duration-200 outline-none focus-visible:text-zinc-950;
}

.mono-link:hover {
  @apply text-zinc-950;
}

/* 激活态样式收敛 */
.active-link {
  @apply text-zinc-950 font-bold;
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