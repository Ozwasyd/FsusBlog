<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElOption, ElSelect } from '@ozwasyd/element-plus'
import {
  draftTaxonomy, taxonomyList, type TaxonomySelection,
} from '../../../Contracts/taxonomy-client'
import type { TaxonomyListItem } from '../../../Contracts/taxonomy'
import { ApiError } from '../../../Contracts/client'

const props = defineProps<{
  articleId: number
  revision: bigint
  identity: number
  disabled: boolean
}>()
const emit = defineEmits<{
  change: [dirty: boolean]
  save: [selection: TaxonomySelection]
  stale: []
}>()
const original = shallowRef<TaxonomySelection>()
const categoryOptions = shallowRef<TaxonomyListItem[]>([])
const tagOptions = shallowRef<TaxonomyListItem[]>([])
const category = ref(0)
const tags = ref<number[]>([])
const loading = ref(false)
const error = ref('')
const retry = ref(0)
const maxTags = 32
const selected = computed<TaxonomySelection>(() => ({
  categoryId: category.value || null,
  tagIds: [...tags.value].sort((a, b) => a - b),
}))
const dirty = computed(() => Boolean(original.value && (
  selected.value.categoryId !== original.value.categoryId
  || selected.value.tagIds.join(',') !== original.value.tagIds.join(',')
)))

watch(dirty, value => emit('change', value), { flush: 'sync' })
watch(() => [props.articleId, props.revision, props.identity, retry.value] as const, async (_, __, cleanup) => {
  const request = new AbortController()
  cleanup(() => request.abort())
  original.value = undefined
  category.value = 0
  tags.value = []
  categoryOptions.value = []
  tagOptions.value = []
  error.value = ''
  loading.value = true

  try {
    const [draft, categories, tagsForSite] = await Promise.all([
      draftTaxonomy(props.articleId, props.revision, request.signal),
      taxonomyList('category', request.signal),
      taxonomyList('tag', request.signal),
    ])
    if (request.signal.aborted) return
    categoryOptions.value = categories
    tagOptions.value = tagsForSite
    const received = { categoryId: draft.categoryId, tagIds: [...draft.tagIds].sort((a, b) => a - b) }
    category.value = received.categoryId ?? 0
    tags.value = [...received.tagIds]
    original.value = received
  } catch (cause) {
    if (request.signal.aborted) return
    if (cause instanceof ApiError && cause.status === 409) {
      emit('stale')
      error.value = 'Load the current draft revision to edit its classification.'
    } else {
      error.value = 'Could not load article classification.'
    }
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}, { immediate: true })

function reset() {
  category.value = original.value?.categoryId ?? 0
  tags.value = [...(original.value?.tagIds ?? [])]
}
</script>

<template>
  <section class="editor-taxonomy" aria-labelledby="editor-taxonomy-title">
    <h2 id="editor-taxonomy-title">Classification</h2>
    <p v-if="loading" role="status">Loading classification…</p>
    <template v-else-if="error">
      <ElAlert :title="error" type="error" :closable="false" />
      <ElButton :disabled="props.disabled" @click="retry++">Retry classification</ElButton>
    </template>
    <template v-else-if="original">
      <label for="edit-category">Category</label>
      <ElSelect id="edit-category" v-model="category" ariaLabel="Category" :disabled="props.disabled" filterable>
        <ElOption :value="0" label="No category" />
        <ElOption v-for="item in categoryOptions" :key="item.id" :value="item.id" :label="item.name" />
      </ElSelect>
      <label for="edit-tags">Tags</label>
      <ElSelect id="edit-tags" v-model="tags" ariaLabel="Tags" :disabled="props.disabled" :multiple-limit="maxTags" multiple filterable>
        <ElOption v-for="item in tagOptions" :key="item.id" :value="item.id" :label="item.name" />
      </ElSelect>
      <div class="editor-taxonomy-actions">
        <ElButton :disabled="props.disabled || !dirty" @click="emit('save', selected)">Save classification</ElButton>
        <ElButton v-if="dirty" :disabled="props.disabled" text @click="reset">Discard classification changes</ElButton>
      </div>
    </template>
  </section>
</template>
