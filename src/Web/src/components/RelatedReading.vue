<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { publicRelatedReading, type RelatedReading as Reading } from '../../../Contracts/related-reading.ts'

const props = defineProps<{ articleId: number; publication: bigint }>()
const reading = shallowRef<Reading>()
const failure = ref(false)
const retry = ref(0)
const previous = computed(() => reading.value?.previous)
const next = computed(() => reading.value?.next)
const suggestions = computed(() => reading.value?.related ?? [])

watch([() => props.articleId, () => props.publication, retry], async ([id, publication], _, cleanup) => {
  const request = new AbortController()
  cleanup(() => request.abort())
  reading.value = undefined
  failure.value = false
  try {
    const result = await publicRelatedReading(id, publication, request.signal)
    if (!request.signal.aborted) reading.value = result
  } catch (cause) {
    if (!request.signal.aborted && (!(cause instanceof ApiError) || cause.status !== 404))
      failure.value = true
  }
}, { immediate: true })

const date = (value: number) => new Date(value).toISOString().slice(0, 10)
const target = (id: number) => ({ name: 'article', params: { id } })
</script>

<template>
  <section v-if="failure || previous || next || suggestions.length" class="related-reading" aria-labelledby="related-reading-heading">
    <h2 id="related-reading-heading">Related reading</h2>
    <template v-if="failure">
      <ElAlert title="Could not load related reading." type="info" :closable="false" />
      <ElButton text @click="retry++">Retry related reading</ElButton>
    </template>
    <nav v-else aria-label="Related articles">
      <ul>
        <li v-if="previous">
          <span class="metadata">Previous article</span>
          <RouterLink :to="target(previous.id)" v-bind="{ 'data-related-role': 'previous' }">{{ previous.title }}</RouterLink>
        </li>
        <li v-if="next">
          <span class="metadata">Next article</span>
          <RouterLink :to="target(next.id)" v-bind="{ 'data-related-role': 'next' }">{{ next.title }}</RouterLink>
        </li>
        <li v-for="item in suggestions" :key="item.id">
          <time class="metadata" :datetime="date(item.createdAt)">{{ date(item.createdAt) }}</time>
          <RouterLink :to="target(item.id)" v-bind="{ 'data-related-role': 'related' }">{{ item.title }}</RouterLink>
        </li>
      </ul>
    </nav>
  </section>
</template>

<style scoped>
.related-reading { margin-block: 1.5rem; border-block-start: 1px solid var(--fsus-border); padding-block-start: 1rem; }
.related-reading h2 { margin-block: 0 .75rem; font-size: 1rem; }
.related-reading ul { margin: 0; padding: 0; list-style: none; }
.related-reading li { display: flex; flex-wrap: wrap; align-items: baseline; gap: .25rem .75rem; padding-block: .35rem; }
.related-reading a { overflow-wrap: anywhere; }
</style>
