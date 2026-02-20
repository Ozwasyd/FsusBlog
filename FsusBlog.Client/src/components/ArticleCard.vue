<template>
  <article 
    class="group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased"
    :style="style"
  >
    <div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
      <time 
        :datetime="article.createTime" 
        :title="TimeUtils.toFullLocalString(article.createTime)"
        class="tabular-nums"
      >
        {{ TimeUtils.toSmartTime(article.createTime) }}
      </time>
      
      <span class="text-zinc-300 font-light">/</span>
      <span class="text-zinc-600">
        {{ article.categoryName || '通用类' }}
      </span>
      
      <template v-if="article.tags?.length">
        <span class="text-zinc-300 font-light hidden sm:inline">/</span>
        <span v-for="tag in article.tags" :key="tag.id" class="hidden sm:inline">
          #{{ tag.name }}
        </span>
      </template>
    </div>

    <h2 class="text-xl sm:text-2xl font-bold text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-snug">
      <router-link :to="`/article/${article.id}`" class="block">
        <span v-html="renderHighlight(article.title)"></span>
      </router-link>
    </h2>

    <p class="text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3">
      <span v-html="renderHighlight(article.snippet || article.summary || '')"></span>
    </p>
    
    <router-link 
      :to="`/article/${article.id}`" 
      class="mt-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors flex items-center gap-2 py-2 -ml-0.5"
    >
      阅读<span>→</span>
    </router-link>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ArticleListItem } from '@/api/article'
import { TimeUtils } from '@/utils/time' // 🌟 引入新逻辑

const props = defineProps<{
  article: ArticleListItem;
  searchKeyword?: string;
  index?: number;
}>()

const style = computed(() => ({
  '--index': props.index ?? 0
}))

/**
 * 安全性保障：HTML 转义并执行关键词高亮
 */
const renderHighlight = (text: string) => {
  if (!text) return ''
  const q = props.searchKeyword?.trim()
  
  const escapeMap: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }
  const safeText = text.replace(/[&<>"']/g, (m) => escapeMap[m] ?? m)

  if (!q || q.length < 1) return safeText

  try {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escaped})`, 'gi')
    return safeText.replace(regex, '<mark class="highlight-mark">$1</mark>')
  } catch (e) {
    return safeText
  }
}
</script>

<style scoped>
.line-clamp-3 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  word-break: break-all;
}

:deep(.highlight-mark) {
  background-color: #f4f4f5; 
  color: #09090b;
  padding: 0 2px;
  border-radius: 2px;
  font-weight: 600;
  box-shadow: 0 0 0 1px rgba(228, 228, 231, 0.5);
}
</style>