<template>
  <div 
    id="top" 
    class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white"
  >
    <MobileNav />
    <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
        
        <div class="shrink-0">
          <router-link to="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity">
            {{ siteStore.siteInfo.title }}<span class="text-zinc-400">.</span>
          </router-link>
        </div>

        <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium">
          <router-link to="/" class="mono-link">首页</router-link>
          <router-link to="/archive" class="mono-link">归档</router-link>
          <router-link to="/about" class="mono-link">关于</router-link>
          
          <button @click="openMobileSearch" class="mono-link sm:hidden">搜索</button>

          <div class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300">
            <input 
              v-model="searchQuery"
              type="text" 
              placeholder="搜索..." 
              class="bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5"
              @keyup.enter="handleSearch"
            />
          </div>

          <span class="text-zinc-300 font-light">/</span>

          <template v-if="userStore.isLoggedIn">
            <router-link 
              :to="userStore.isAdmin ? '/admin' : '/user/profile'" 
              class="mono-link"
            >
              {{ userStore.isAdmin ? '控制板' : '账户' }}
            </router-link>
          </template>
          <template v-else>
            <router-link to="/login" class="mono-link">登录</router-link>
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
        
        <div class="text-sm text-zinc-500 font-medium tracking-normal">
          &copy; 2026 {{ siteStore.siteInfo.author }}. All rights reserved.
        </div>
        
        <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500">
          <a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a>
          <a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group">
            <span>回到顶部</span>
            <span class="group-hover:-translate-y-0.5 transition-transform">↑</span>
          </a>
        </div>

      </div>
    </footer>

  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useSiteStore } from '@/store/site'
import MobileNav from '@/components/MobileNav.vue'

const userStore = useUserStore()
const siteStore = useSiteStore()
const router = useRouter()

const searchQuery = ref('')

const handleSearch = () => {
  const query = searchQuery.value.trim()
  if (query) {
    router.push({ path: '/search', query: { q: query } })
    searchQuery.value = ''
  }
}

// 触发 MobileNav 中定义的搜索信号
const openMobileSearch = () => {
  window.dispatchEvent(new CustomEvent('toggle-mobile-search'))
}
</script>

<style scoped>
@reference "@/assets/main.css";

.font-sans { letter-spacing: 0.01em; }

.mono-link {
  @apply text-zinc-500 transition-colors duration-200;
}

.mono-link:hover,
.mono-link.router-link-active {
  @apply text-zinc-950;
}

/* 彻底移除移动端点击时的蓝色高亮阴影 */
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

html { scroll-behavior: smooth; }
</style>