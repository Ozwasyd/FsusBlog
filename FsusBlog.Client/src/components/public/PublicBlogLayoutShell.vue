<template>
  <div
    id="top"
    class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white"
  >
    <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
        <div class="shrink-0">
          <a
            href="/"
            class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60"
          >
            {{ siteTitleText }}<span class="text-zinc-400">.</span>
          </a>
        </div>

        <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
          <a href="/" class="mono-link">首页</a>
          <a href="/archive" class="mono-link">归档</a>
          <a href="/about" class="mono-link">关于</a>

          <div class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300">
            <input
              v-model.trim="searchQuery"
              type="text"
              placeholder="搜索 (Ctrl+K)"
              class="bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5"
              @keyup.enter="handleSearch"
              @keyup.esc="searchQuery = ''"
              aria-label="搜索内容"
            />
          </div>

          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <a :href="authHref" class="mono-link">{{ authLabel }}</a>
        </nav>
      </div>
    </header>

    <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
      <slot />
    </main>

    <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
        <div class="text-sm text-zinc-500 font-medium tracking-normal select-none">
          &copy; {{ currentYear }} {{ siteTitleText }}. All rights reserved.
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
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  siteTitle?: string | null
  authLabel?: string
  authHref?: string
}>(), {
  siteTitle: 'Fsus',
  authLabel: '登录',
  authHref: '/login'
})

const currentYear = new Date().getFullYear()
const searchQuery = ref('')

const siteTitleText = computed(() => props.siteTitle?.trim() || 'Fsus')

const handleSearch = (): void => {
  const query = searchQuery.value.trim()
  if (!query) {
    return
  }

  window.location.assign(`/search?q=${encodeURIComponent(query)}`)
}
</script>

<style scoped>
@reference "@/assets/main.css";

.mono-link {
  @apply text-zinc-500 transition-colors duration-200 outline-none focus-visible:text-zinc-950;
}

.mono-link:hover {
  @apply text-zinc-950;
}
</style>
