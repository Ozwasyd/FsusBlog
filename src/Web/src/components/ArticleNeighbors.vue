<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { publicRelatedReading, type RelatedReading } from '../../../Contracts/related-reading.ts'
import { t } from '../siteLocale'

const props = defineProps<{ articleId: number; publication: bigint }>()
const reading = shallowRef<Pick<RelatedReading, 'previous' | 'next'>>()
const previous = computed(() => reading.value?.previous)
const next = computed(() => reading.value?.next)

watch([() => props.articleId, () => props.publication], async ([id, publication], _, cleanup) => {
  const request = new AbortController()
  cleanup(() => request.abort())
  reading.value = undefined
  try {
    const { previous, next } = await publicRelatedReading(id, publication, request.signal)
    if (!request.signal.aborted) reading.value = { previous, next }
  } catch {
    // This optional navigation must not interrupt reading an article.
  }
}, { immediate: true })

const target = (id: number) => ({ name: 'article', params: { id } })
</script>

<template>
  <nav v-if="previous || next" class="article-neighbors" :aria-label="t('reading.relatedArticles')">
    <RouterLink v-if="previous" :to="target(previous.id)" rel="prev"
      :aria-label="`${t('reading.previousArticle')} · ${previous.title}`"
      v-bind="{ 'data-related-role': 'previous' }">
      <span aria-hidden="true">←</span>
      {{ t('reading.previousArticle') }}
    </RouterLink>
    <RouterLink v-if="next" class="article-neighbor--next" :to="target(next.id)" rel="next"
      :aria-label="`${t('reading.nextArticle')} · ${next.title}`"
      v-bind="{ 'data-related-role': 'next' }">
      {{ t('reading.nextArticle') }}
      <span aria-hidden="true">→</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.article-neighbors { display: flex; gap: 1rem; margin-block: 1rem .5rem; }
.article-neighbors a {
  display: inline-flex;
  align-items: center;
  gap: .4rem;
  min-block-size: 44px;
  color: var(--fsus-color-text-muted);
  font-size: .875rem;
  text-decoration: none;
}
.article-neighbors a:hover,
.article-neighbors a:focus-visible { color: var(--fsus-color-action-primary); }
.article-neighbor--next { margin-inline-start: auto; }
</style>
