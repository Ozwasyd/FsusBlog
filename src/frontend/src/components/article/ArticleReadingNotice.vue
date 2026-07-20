<template>
  <section
    v-if="notice.visible"
    class="article-notice-minimal mb-12 sm:mb-16"
    data-fsus-surface="reading"
    :aria-label="messages.article.metadata.longReadAria"
  >
    <div class="flex items-baseline gap-4 border-l-2 border-[var(--fsusblog-panel-border-strong)] pl-6 py-1">
      <span class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-secondary)]">
        {{ messages.article.metadata.longRead }}
      </span>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-normal text-[var(--fsusblog-text-secondary)]">
        <span class="inline-flex items-center gap-1.5">
          {{ t('article.metadata.words', { count: formatNumber(notice.wordCount) }) }}
        </span>
        <span class="h-0.5 w-0.5 rounded-[var(--fsus-radius-control-small)] bg-[var(--fsusblog-text-muted)] opacity-40" aria-hidden="true"></span>
        <span class="inline-flex items-center gap-1.5">
          {{ t('article.metadata.readingMinutes', { count: formatNumber(notice.readingMinutes) }) }}
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18nText } from '@/composables/useI18nText'
import type { ArticleReadingNoticeContract } from '@/view-contracts/articleDetail'

defineProps<{
  notice: ArticleReadingNoticeContract
}>()

const { formatNumber, messages, t } = useI18nText()
</script>

<style scoped>
@reference "@/assets/main.css";

.article-notice-minimal {
  /* 去岛屿化：移除背景与边框容器 */
}
</style>
