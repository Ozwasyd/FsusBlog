<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElDialog, ElOption, ElSelect, ElSettingsSection } from '@ozwasyd/element-plus'
import { draftTaxonomy, taxonomyList, type DraftTaxonomy, type TaxonomySelection } from '../../../Contracts/taxonomy-client'
import type { TaxonomyListItem } from '../../../Contracts/taxonomy'
import { taxonomyMetadataAvailable, type AdminMetadataKind, type AdminTaxonomyMetadata } from '../../../Contracts/admin-tag-metadata'
import { ApiError } from '../../../Contracts/client'
import { invalidateSession } from '../authorSession'
import AdminTagMetadata from './AdminTagMetadata.vue'

const props = defineProps<{ articleId: number; revision: bigint; identity: number; disabled: boolean }>()
const emit = defineEmits<{ change: [dirty: boolean]; save: [selection: TaxonomySelection]; stale: []; modalChange: [active: boolean] }>()
const original = shallowRef<DraftTaxonomy & { identity: number }>()
const categoryOptions = shallowRef<TaxonomyListItem[]>([])
const tagOptions = shallowRef<TaxonomyListItem[]>([])
const category = ref(0)
const tags = ref<number[]>([])
const canCreateCategory = ref(false)
const canCreateTag = ref(false)
const creatingKind = ref<AdminMetadataKind>()
const loading = ref(false)
const error = ref('')
const retry = ref(0)
const maxTags = 32
const lifetime = new AbortController()
let opener: HTMLElement | undefined

const createDialogTitle = computed(() => creatingKind.value
  ? t('admin.taxonomy.m41', { kind: t(creatingKind.value === 'category' ? 'admin.taxonomy.kindCategory' : 'admin.taxonomy.kindTag') }) : '')
const selected = computed<TaxonomySelection>(() => ({ categoryId: category.value || null, tagIds: [...tags.value].sort((a, b) => a - b) }))
const dirty = computed(() => Boolean(original.value && (selected.value.categoryId !== original.value.categoryId || selected.value.tagIds.join(',') !== original.value.tagIds.join(','))))
const comparisonTaxonomy = computed(() => {
  const baseline = original.value
  if (!dirty.value || !baseline) return
  const named = (id: number, options: TaxonomyListItem[]) => options.find(item => item.id === id) ?? { id, name: `#${id}` }
  return {
    articleId: baseline.id, revision: baseline.revision, identity: baseline.identity,
    category: category.value ? named(category.value, categoryOptions.value) : null,
    tags: selected.value.tagIds.map(id => named(id, tagOptions.value)),
  }
})
defineExpose({ comparisonTaxonomy })

watch(dirty, value => emit('change', value), { flush: 'sync' })
watch(creatingKind, kind => emit('modalChange', kind !== undefined), { flush: 'sync' })
watch(() => [props.articleId, props.revision, props.identity, retry.value] as const, async ([article, revision, identity], __, cleanup) => {
  const request = new AbortController()
  cleanup(() => request.abort())
  creatingKind.value = original.value = undefined
  category.value = 0
  tags.value = []
  categoryOptions.value = tagOptions.value = []
  canCreateCategory.value = canCreateTag.value = false
  error.value = ''
  loading.value = true
  try {
    const [draft, categories, tagsForSite, categoryWritable, tagWritable] = await Promise.all([
      draftTaxonomy(article, revision, request.signal), taxonomyList('category', request.signal), taxonomyList('tag', request.signal),
      taxonomyMetadataAvailable('category', request.signal).catch(() => false), taxonomyMetadataAvailable('tag', request.signal).catch(() => false),
    ])
    if (request.signal.aborted) return
    categoryOptions.value = categories
    tagOptions.value = tagsForSite
    canCreateCategory.value = categoryWritable
    canCreateTag.value = tagWritable
    category.value = draft.categoryId ?? 0
    tags.value = [...draft.tagIds]
    original.value = { ...draft, identity }
  } catch (cause) {
    if (request.signal.aborted) return
    if (cause instanceof ApiError && cause.status === 409) {
      emit('stale')
      error.value = t('author.taxonomy.loadTheCurrentDraftRevisionToEditIts')
    } else error.value = t('author.taxonomy.couldNotLoadArticleClassification')
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}, { immediate: true })

onScopeDispose(() => { lifetime.abort(); emit('modalChange', false) })

function openCreate(kind: AdminMetadataKind, event?: Event) {
  if (props.disabled || creatingKind.value) return
  opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  creatingKind.value = kind
}

async function closeCreate() {
  const previousOpener = opener
  opener = creatingKind.value = undefined
  await nextTick()
  if (previousOpener?.isConnected) previousOpener.focus({ preventScroll: true })
}

const mergeCreatedOption = (items: readonly TaxonomyListItem[], created: AdminTaxonomyMetadata): TaxonomyListItem[] =>
  items.some(item => item.id === created.id)
    ? items.map(item => item.id === created.id ? { ...item, name: created.name } : item)
    : [...items, { id: created.id, name: created.name, articleCount: 0 }]

async function handleCreated(created: AdminTaxonomyMetadata) {
  const kind = creatingKind.value
  if (!kind) return
  const target = kind === 'category' ? categoryOptions : tagOptions
  const refreshed = await taxonomyList(kind, lifetime.signal).catch(() => target.value)
  if (lifetime.signal.aborted) return
  target.value = mergeCreatedOption(refreshed, created)
  if (kind === 'category') category.value = created.id
  else if (!tags.value.includes(created.id) && tags.value.length < maxTags) tags.value = [...tags.value, created.id]
  await closeCreate()
}

const handleSessionLost = () => { void closeCreate(); invalidateSession() }
const reset = () => { category.value = original.value?.categoryId ?? 0; tags.value = [...(original.value?.tagIds ?? [])] }
</script>

<template>
  <ElSettingsSection density="compact" title-tag="h3" ariaLabelledby="editor-taxonomy-title">
    <template #title><span id="editor-taxonomy-title">{{ t('author.taxonomy.classification') }}</span></template>
    <p v-if="loading" class="taxonomy-status" role="status">{{ t('author.taxonomy.loadingClassification') }}</p>
    <template v-else-if="error">
      <ElAlert :title="error" type="error" :closable="false" />
      <ElButton :disabled="props.disabled" @click="retry++">{{ t('author.taxonomy.retryClassification') }}</ElButton>
    </template>
    <div v-else-if="original" class="taxonomy-fields">
      <div class="taxonomy-field">
        <div class="editor-taxonomy-label-row">
          <label for="edit-category">{{ t('page.category') }}</label>
          <ElButton v-if="canCreateCategory" native-type="button" text size="small" :disabled="props.disabled || !!creatingKind" @click="openCreate('category', $event)">{{ t('admin.taxonomy.m41', { kind: t('admin.taxonomy.kindCategory') }) }}</ElButton>
        </div>
        <ElSelect id="edit-category" v-model="category" :ariaLabel="t('page.category')" :disabled="props.disabled" filterable>
          <ElOption :value="0" :label="t('author.taxonomy.noCategory')" />
          <ElOption v-for="item in categoryOptions" :key="item.id" :value="item.id" :label="item.name" />
        </ElSelect>
      </div>
      <div class="taxonomy-field">
        <div class="editor-taxonomy-label-row">
          <label for="edit-tags">{{ t('admin.taxonomy.m6') }}</label>
          <ElButton v-if="canCreateTag" native-type="button" text size="small" :disabled="props.disabled || !!creatingKind" @click="openCreate('tag', $event)">{{ t('admin.taxonomy.m41', { kind: t('admin.taxonomy.kindTag') }) }}</ElButton>
        </div>
        <ElSelect id="edit-tags" v-model="tags" :ariaLabel="t('admin.taxonomy.m6')" :disabled="props.disabled" :multiple-limit="maxTags" multiple filterable>
          <ElOption v-for="item in tagOptions" :key="item.id" :value="item.id" :label="item.name" />
        </ElSelect>
      </div>
      <div class="editor-taxonomy-actions">
        <ElButton size="small" :disabled="props.disabled || !dirty" @click="emit('save', selected)">{{ t('author.taxonomy.saveClassification') }}</ElButton>
        <ElButton v-if="dirty" size="small" :disabled="props.disabled" text @click="reset">{{ t('author.taxonomy.discardClassificationChanges') }}</ElButton>
      </div>
    </div>
    <ElDialog :model-value="creatingKind !== undefined" :title="createDialogTitle" width="min(30rem, 92vw)" append-to-body @update:model-value="visible => { if (!visible) closeCreate() }">
      <AdminTagMetadata v-if="creatingKind" :key="`create-${creatingKind}`" :kind="creatingKind" :id="0" @close="closeCreate()" @saved="handleCreated" @session-lost="handleSessionLost" />
    </ElDialog>
  </ElSettingsSection>
</template>

<style scoped>
.taxonomy-status { margin: 0; color: var(--fsus-muted); font-size: var(--fsus-font-size-sm, 0.875rem); }
.taxonomy-fields { display: grid; gap: var(--fsus-space-3); min-inline-size: 0; }
.taxonomy-field { display: grid; gap: var(--fsus-space-1); min-inline-size: 0; }
.editor-taxonomy-label-row { display: flex; align-items: center; justify-content: space-between; gap: var(--fsus-space-2); }
</style>
