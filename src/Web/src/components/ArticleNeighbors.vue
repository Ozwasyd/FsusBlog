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
    <RouterLink v-if="previous" class="article-neighbor--previous" :to="target(previous.id)" rel="prev"
      v-bind="{ 'data-related-role': 'previous' }">
      <span class="metadata">{{ t('reading.previousArticle') }}</span>
      <span class="article-neighbor-title">{{ previous.title }}</span>
    </RouterLink>
    <RouterLink v-if="next" class="article-neighbor--next" :to="target(next.id)" rel="next"
      v-bind="{ 'data-related-role': 'next' }">
      <span class="metadata">{{ t('reading.nextArticle') }}</span>
      <span class="article-neighbor-title">{{ next.title }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.article-neighbors {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .75rem;
  margin-block: 1rem;
  border-block-start: 1px solid var(--fsus-border);
}
.article-neighbors a {
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: .45rem;
  min-block-size: 44px;
  min-inline-size: 0;
  max-inline-size: 100%;
  text-decoration: none;
}
.article-neighbor--previous { grid-column: 1; justify-self: start; }
.article-neighbor--next { grid-column: 2; justify-self: end; }
.article-neighbors .metadata { flex: none; }
.article-neighbor-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: underline; }
</style>
