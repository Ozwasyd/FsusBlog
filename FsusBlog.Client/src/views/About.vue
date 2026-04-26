<template>
  <section v-if="loading" class="fsus-page-shell max-w-3xl mx-auto px-5 sm:px-8 min-h-screen flex flex-col">
    <div class="animate-pulse space-y-8 py-8" aria-hidden="true">
      <div class="h-8 sm:h-12 bg-[#F4F4F5] w-2/3"></div>
      <div class="flex gap-6">
        <div class="h-4 bg-[#F4F4F5] w-24"></div>
      </div>
      <div class="space-y-4 pt-8 sm:pt-12">
        <div v-for="i in 5" :key="i" class="h-4 bg-[#F4F4F5] w-full"></div>
      </div>
    </div>
  </section>

  <article v-else-if="!error" class="fsus-page-shell max-w-3xl mx-auto px-5 sm:px-8 min-h-screen flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-700">
    <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-[#F4F4F5]">
      <h1 class="text-3xl sm:text-5xl font-bold text-[#0F0F11] leading-tight sm:leading-snug mb-6">
        关于
      </h1>

      <div class="flex flex-wrap items-center gap-5 text-[11px] sm:text-xs font-mono font-medium text-[#A1A1AA] uppercase">
        <time>{{ currentYear }}</time>
        <span class="text-[#D4D4D8] font-light" aria-hidden="true">/</span>
        <span class="text-[#71717A] font-medium">MANIFESTO</span>
        <span class="text-[#D4D4D8] font-light" aria-hidden="true">/</span>
        <span>README.MD</span>
      </div>
    </header>

    <MarkdownRenderer
      :content="rawMarkdown"
    />

    <footer class="mt-16 sm:mt-24 mb-16 sm:mb-20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-t border-[#F4F4F5] pt-8 sm:pt-10 opacity-80 transition-opacity hover:opacity-100">
      <span class="text-[10px] font-bold uppercase text-[#0F0F11]">
        {{ siteStore.siteInfo.title }}
      </span>
    </footer>
  </article>

  <section v-else class="fsus-page-shell max-w-3xl mx-auto px-5 sm:px-8 min-h-screen flex grow flex-col items-center justify-center py-24 sm:py-32">
    <p class="text-xs font-mono font-medium uppercase text-[#A1A1AA] mb-6">
      连接丢失。
    </p>
    <button
      type="button"
      @click="fetchData"
      class="rounded-[8px] text-xs font-bold uppercase text-[#0F0F11] border-b border-[#0F0F11] pb-0.5 hover:text-[#2A599C] hover:border-[#2A599C] transition-all outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
    >
      重连
    </button>
  </section>
</template>

<script setup lang="ts">
import { useSiteStore } from '@/store/site'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import { useAboutPage } from '@/composables/useAboutPage'

const siteStore = useSiteStore()
const { currentYear, rawMarkdown, loading, error, fetchData } = useAboutPage()
</script>

<style scoped>
@reference "@/assets/main.css";
</style>
