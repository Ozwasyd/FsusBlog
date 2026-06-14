<template>
  <section
    v-if="notice.visible"
    class="article-notice-minimal mb-12 sm:mb-16 animate-in fade-in slide-in-from-bottom-2 duration-[var(--fsus-motion-control-fast)]"
    aria-label="长文阅读提示"
  >
    <div class="flex items-baseline gap-4 border-l-2 border-[var(--fsusblog-panel-border-strong)] pl-6 py-1">
      <span class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-primary)]">
        长文
      </span>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium text-[var(--fsusblog-text-secondary)]">
        <span class="inline-flex items-center gap-1.5">
          全文约 <span class="tabular-nums font-bold text-[var(--fsusblog-text-primary)] tabular-nums">{{ notice.wordCount.toLocaleString('zh-CN') }}</span> 字
        </span>
        <span class="h-0.5 w-0.5 rounded-[var(--fsus-radius-control-small)] bg-[var(--fsusblog-text-muted)] opacity-40" aria-hidden="true"></span>
        <span class="inline-flex items-center gap-1.5">
          预计阅读 <span class="tabular-nums font-bold text-[var(--fsusblog-text-primary)] tabular-nums">{{ notice.readingMinutes }}</span> 分钟
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ArticleReadingNoticeContract } from '@/view-contracts/articleDetail'

defineProps<{
  notice: ArticleReadingNoticeContract
}>()
</script>

<style scoped>
@reference "@/assets/main.css";

.article-notice-minimal {
  /* 去岛屿化：移除背景与边框容器 */
}
</style>
