<template>
  <div v-if="loading" class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen flex flex-col">
    <!-- 骨架屏：物理比例对齐，减少布局抖动 -->
    <div class="animate-pulse space-y-8 py-8" aria-hidden="true">
      <div class="h-8 sm:h-12 bg-zinc-100 w-2/3"></div>
      <div class="flex gap-4">
        <div class="h-4 bg-zinc-100 w-24"></div>
      </div>
      <div class="space-y-4 pt-8 sm:pt-12">
        <div v-for="i in 5" :key="i" class="h-4 bg-zinc-100 w-full"></div>
      </div>
    </div>
  </div>

  <AotHost
    v-else-if="shouldRenderAotHtml"
    class="aot-about-page"
    :html="aotRenderedHtml"
  />

  <div v-else-if="!error" class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen flex flex-col">
    <article class="animate-in fade-in slide-in-from-bottom-4 duration-700 grow">
      <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
        <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6 tracking-tighter">
          关于
        </h1>

        <div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
          <time>{{ currentYear }}</time>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <span class="text-zinc-600 font-medium tracking-[0.05em]">MANIFESTO</span>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <span>README.MD</span>
        </div>
      </header>

      <MarkdownRenderer
        :content="rawMarkdown"
      />

      <footer class="mt-24 pt-10 border-t border-zinc-100 mb-20 flex justify-between items-center opacity-80 hover:opacity-100 transition-opacity">
        <div class="flex flex-col gap-1">
          <span class="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-950">
            {{ siteStore.siteInfo.title }}
          </span>
        </div>
      </footer>
    </article>
  </div>

  <div v-else class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen flex flex-col py-32 text-center grow items-center justify-center">
    <p class="text-xs font-mono font-medium tracking-widest uppercase text-zinc-400 mb-6">
      连接丢失。
    </p>
    <button
      type="button"
      @click="fetchData"
      class="text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 border-b border-zinc-950 pb-0.5 hover:text-zinc-500 hover:border-zinc-500 transition-all outline-none"
    >
      重连
    </button>
  </div>
</template>

<script setup lang="ts">
import { useSiteStore } from '@/store/site'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import AotHost from '@/components/AotHost.vue'
import { useAboutPage } from '@/composables/useAboutPage'

const siteStore = useSiteStore()
const { currentYear, rawMarkdown, aotRenderedHtml, shouldRenderAotHtml, loading, error, fetchData } = useAboutPage()
</script>

<style scoped>
@reference "@/assets/main.css";
/* 
  所有关于 .prose, .shiki 的样式已迁移至 MarkdownRenderer.vue 
  此处仅保留 About 页面特有的布局微调
*/
</style>
