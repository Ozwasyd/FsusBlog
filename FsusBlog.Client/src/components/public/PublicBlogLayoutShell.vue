<template>
  <div
    id="top"
    class="font-sans min-h-screen flex flex-col bg-[var(--fsus-panel-bg)] text-[#0F0F11] subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-[#0F0F11] selection:text-white"
  >
    <header class="w-full max-w-3xl mx-auto px-6 sm:px-8 pt-12 pb-8 sm:pt-20 sm:pb-10 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
      <a
        href="/"
        class="shrink-0 inline-block rounded-[8px] text-2xl sm:text-3xl font-bold hover:opacity-60 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
      >
        {{ siteTitleText }}<span class="text-[#A1A1AA]">.</span>
      </a>

      <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
        <a href="/" class="mono-link">首页</a>
        <a href="/archive" class="mono-link">归档</a>
        <a href="/about" class="mono-link">关于</a>

        <input
          v-model.trim="searchQuery"
          type="text"
          placeholder="搜索 (Ctrl+K)"
          class="hidden sm:block bg-transparent border-x-0 border-t-0 border-b border-[#F4F4F5] p-0 pb-0.5 text-sm w-12 focus:w-28 transition-[width,border-color,color] duration-500 focus:ring-0 focus:outline-none placeholder:text-[#D4D4D8] text-[#8E8E93] focus:text-[#0F0F11] focus:border-[#2A599C]"
          @keyup.enter="handleSearch"
          @keyup.esc="searchQuery = ''"
          aria-label="搜索内容"
        />

        <span class="text-[#D4D4D8] font-light" aria-hidden="true">/</span>
        <a :href="authHref" class="mono-link">{{ authLabel }}</a>
      </nav>
    </header>

    <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
      <slot />
    </main>

    <footer class="w-full max-w-3xl mx-auto px-6 sm:px-8 pb-12 pt-8 sm:pb-16 border-t border-[#F4F4F5] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
      <div class="text-sm text-[#8E8E93] font-medium tracking-normal select-none">
        &copy; {{ currentYear }} {{ siteTitleText }}. All rights reserved.
      </div>

      <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-[#8E8E93]">
        <a href="/api/Article/rss" class="rounded-[8px] hover:text-[#2A599C] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">RSS</a>
        <a href="#top" class="rounded-[8px] hover:text-[#2A599C] transition-colors flex items-center gap-2 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
          <span>回到顶部</span>
          <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
        </a>
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
  @apply rounded-[8px] text-[#8E8E93] transition-colors duration-200 outline-none focus-visible:text-[#2A599C] focus-visible:ring-2 focus-visible:ring-[#2A599C];
}

.mono-link:hover {
  @apply text-[#2A599C];
}
</style>
