<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElEmptyState, ElInlineActions, ElKeyValueGrid,
  ElKeyValueItem, ElOption, ElSelect, ElSettingsSection, ElSkeleton,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readAdminTaxonomy, readAdminTaxonomyDependencies,
  type AdminTaxonomyDependencies, type AdminTaxonomyPage } from '../../../Contracts/admin-taxonomy'
import { taxonomyMetadataAvailable } from '../../../Contracts/admin-tag-metadata'
import AdminTagMetadata from './AdminTagMetadata.vue'

type TaxonomyKind = Parameters<typeof readAdminTaxonomy>[0]
type ReferenceDetails = { name: string } & (
  { state: 'loading' } |
  { state: 'ready'; counts: AdminTaxonomyDependencies } |
  { state: 'failed'; message: MessageKey }
)
const props = defineProps<{ initialKind: TaxonomyKind; active: boolean }>()
const emit = defineEmits<{ 'session-lost': [error: ApiError] }>()
const kind = ref<TaxonomyKind>(props.initialKind)
const metadataKind = computed(() => kind.value === 'categories' ? 'category' : 'tag')
const kindLabel = computed(() => t(kind.value === 'categories' ? 'admin.taxonomy.kindCategory' : 'admin.taxonomy.kindTag'))
const kindsLabel = computed(() => t(kind.value === 'categories' ? 'admin.taxonomy.kindsCategories' : 'admin.taxonomy.kindsTags'))
const metadataLabel = computed(() => kind.value === 'categories' ? t('admin.taxonomy.m1') : t('admin.taxonomy.m2'))
const page = shallowRef<AdminTaxonomyPage>()
const cursors = shallowRef<readonly (number | null)[]>([null])
const pageNumber = ref(0)
const pending = ref(false)
const failure = ref<'forbidden' | 'request'>()
const canEditMetadata = ref(false)
const target = ref<number>()
const edited = ref<number>()
const notice = ref<{ key: MessageKey; kind: TaxonomyKind }>()
const heading = ref<HTMLElement>()
const inspectButton = ref<InstanceType<typeof ElButton>>()
const references = shallowRef<ReferenceDetails>()
let opener: HTMLElement | undefined
let request: AbortController | undefined
let referenceRequest: AbortController | undefined
let viewGeneration = 0

async function load(index: number) {
  viewGeneration++
  clearReferences()
  request?.abort()
  const current = new AbortController()
  const listKind = kind.value
  const itemKind = metadataKind.value
  request = current
  page.value = undefined
  edited.value = undefined
  target.value = undefined
  canEditMetadata.value = false
  failure.value = undefined
  pageNumber.value = index
  pending.value = true
  try {
    const data = await readAdminTaxonomy(listKind, cursors.value[index] ?? null, current.signal)
    if (current.signal.aborted) return
    page.value = data
    // Listing and reference inspection do not depend on the optional writer.
    pending.value = false
    const enabled = await taxonomyMetadataAvailable(itemKind, current.signal).catch(() => false)
    if (!current.signal.aborted) canEditMetadata.value = enabled
  } catch (error) {
    if (current.signal.aborted) return
    if (error instanceof ApiError && error.status === 401) emit('session-lost', error)
    else failure.value = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'request'
  } finally {
    if (request === current) {
      request = undefined
      pending.value = false
    }
  }
}

function clearReferences() {
  referenceRequest?.abort()
  referenceRequest = undefined
  references.value = undefined
}

async function inspectReferences() {
  const item = page.value?.items.find(entry => entry.id === target.value)
  if (!item || references.value?.state === 'loading') return
  clearReferences()
  const currentKind = kind.value
  const current = new AbortController()
  referenceRequest = current
  references.value = { name: item.name, state: 'loading' }
  try {
    const counts = await readAdminTaxonomyDependencies(currentKind, item.id, current.signal)
    if (!current.signal.aborted) references.value = { name: item.name, state: 'ready', counts }
  } catch (error) {
    if (current.signal.aborted) return
    if (error instanceof ApiError && error.status === 401) {
      clearReferences()
      emit('session-lost', error)
    } else {
      const message = error instanceof ApiError && error.status === 403
        ? 'admin.taxonomy.m33' : 'admin.taxonomy.m34'
      references.value = { name: item.name, state: 'failed', message }
    }
  } finally {
    if (referenceRequest === current) referenceRequest = undefined
  }
}

async function closeReferences() {
  const id = target.value
  const view = viewGeneration
  clearReferences()
  await nextTick()
  if (view === viewGeneration && target.value === id && !references.value) inspectButton.value?.ref?.focus()
}

function openEditor(id: number | undefined, event: Event) {
  if (id === undefined || edited.value !== undefined || !canEditMetadata.value) return
  edited.value = id
  notice.value = undefined
  opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
}

async function closeEditor(saved: boolean) {
  const id = edited.value
  if (id === undefined) return
  const previousOpener = opener
  opener = undefined
  edited.value = undefined
  let replacement: Promise<void> | undefined
  if (saved) {
    notice.value = id === 0 ? { key: 'admin.taxonomy.m39', kind: kind.value } : { key: 'admin.taxonomy.m40', kind: kind.value }
    replacement = load(pageNumber.value)
  }
  const view = viewGeneration
  await replacement
  await nextTick()
  if (viewGeneration !== view || edited.value !== undefined) return
  if (previousOpener?.isConnected) previousOpener.focus()
  else heading.value?.focus()
}

function next() {
  if (pending.value || !page.value?.nextId) return
  cursors.value = [...cursors.value.slice(0, pageNumber.value + 1), page.value.nextId]
  void load(pageNumber.value + 1)
}

onMounted(() => { void load(0) })
watch(() => props.active, active => {
  // Preserve an open metadata editor; otherwise a revisit starts from fresh page-one facts.
  if (!active || edited.value !== undefined) return
  cursors.value = [null]
  notice.value = undefined
  void load(0)
})
watch(target, clearReferences, { flush: 'sync' })
onBeforeUnmount(() => {
  viewGeneration++
  request?.abort()
  clearReferences()
})
</script>

<template>
  <ElSettingsSection
    class="admin-taxonomy"
    :ariaLabelledby="`admin-taxonomy-heading-${kind}`"
    v-bind="{ 'aria-busy': pending }"
    density="compact"
  >
    <template #title>
      <span :id="`admin-taxonomy-heading-${kind}`" ref="heading" tabindex="-1">{{ t('admin.taxonomy.m3') }}</span>
    </template>
    <template #actions>
      <ElButton class="taxonomy-refresh" native-type="button" text :disabled="pending || edited !== undefined" @click="load(pageNumber)">{{ t('admin.articles.refresh') }}</ElButton>
    </template>

    <p v-if="notice" class="taxonomy-status" role="status">{{ t(notice.key, { label: t(notice.kind === 'categories' ? 'admin.taxonomy.m1' : 'admin.taxonomy.m2') }) }}</p>
    <ElSkeleton v-if="pending" :rows="3" animated />
    <ElAlert v-else-if="failure === 'forbidden'" :title="t('admin.taxonomy.m7')" type="warning" :closable="false" show-icon />
    <ElAlert v-else-if="failure === 'request'" :title="t('admin.taxonomy.m8')" type="error" :closable="false" show-icon>
      <ElButton native-type="button" text @click="load(pageNumber)">{{ t('admin.taxonomy.m9') }}</ElButton>
    </ElAlert>
    <template v-else-if="page">
      <ElInlineActions v-if="canEditMetadata">
        <ElButton native-type="button" :disabled="edited !== undefined" @click="openEditor(0, $event)">{{ t('admin.taxonomy.m41', { kind: kindLabel }) }}</ElButton>
      </ElInlineActions>
      <AdminTagMetadata
        v-if="edited !== undefined"
        :key="`${kind}:${edited}`"
        :kind="metadataKind"
        :id="edited"
        @close="closeEditor(false)"
        @saved="closeEditor(true)"
        @session-lost="emit('session-lost', $event)"
      />
      <ElEmptyState v-if="page.items.length === 0" size="inline" :title="kind === 'categories' ? t('admin.taxonomy.m10') : t('admin.taxonomy.m11')" />
      <div v-else class="taxonomy-table-scroll" tabindex="0" role="region" :aria-label="t('admin.taxonomy.m12')" :aria-describedby="`taxonomy-count-notes-${kind}`">
        <table>
          <caption>{{ kind === 'categories' ? t('admin.taxonomy.m13') : t('admin.taxonomy.m14') }}</caption>
          <thead>
            <tr>
              <th scope="col">{{ kind === 'categories' ? t('admin.taxonomy.m1') : t('admin.taxonomy.m2') }}</th>
              <th scope="col">{{ t('admin.taxonomy.m15') }}</th>
              <th scope="col">{{ t('admin.taxonomy.m16') }}</th>
              <th scope="col">{{ t('admin.taxonomy.m17') }}</th>
              <th scope="col">{{ t('admin.taxonomy.m18') }}</th>
              <th scope="col">{{ t('admin.taxonomy.m19') }}</th>
              <th scope="col">{{ t('admin.taxonomy.m20') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in page.items" :key="item.id">
              <th scope="row">{{ item.name }}</th>
              <td>{{ item.published }}</td>
              <td>{{ item.drafts }}</td>
              <td>{{ item.scheduled }}</td>
              <td>{{ item.retracted }}</td>
              <td>{{ item.deleted }}</td>
              <td>{{ item.retainedArticles }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="page.items.length" class="taxonomy-actions" role="group" :aria-label="t(canEditMetadata ? 'admin.taxonomy.m46' : 'admin.taxonomy.m47', { kind: kindsLabel })">
        <label :for="`admin-${metadataKind}-target`" class="taxonomy-select-label">{{ t(canEditMetadata ? 'admin.taxonomy.m48' : 'admin.taxonomy.m49', { label: metadataLabel }) }}</label>
        <ElSelect
          :id="`admin-${metadataKind}-target`"
          v-model="target"
          class="taxonomy-select"
          :ariaLabel="t(canEditMetadata ? 'admin.taxonomy.m48' : 'admin.taxonomy.m49', { label: metadataLabel })"
          :placeholder="t('admin.taxonomy.m42', { kind: kindLabel })"
        >
          <ElOption v-for="item in page.items" :key="item.id" :label="item.name" :value="item.id" />
        </ElSelect>
        <ElInlineActions>
          <ElButton ref="inspectButton" native-type="button" text :disabled="!target || references?.state === 'loading'" @click="inspectReferences">
            {{ t('admin.taxonomy.m21') }}
          </ElButton>
          <ElButton v-if="canEditMetadata" native-type="button" text :disabled="!target || edited !== undefined" @click="openEditor(target, $event)">
            {{ t('admin.taxonomy.m43', { kind: kindLabel }) }}
          </ElButton>
        </ElInlineActions>
      </div>

      <section v-if="references" class="taxonomy-references" :aria-label="t('admin.taxonomy.m22')" :aria-busy="references.state === 'loading'">
        <h3>{{ t('admin.taxonomy.m44', { name: references.name }) }}</h3>
        <p v-if="references.state === 'loading'" class="taxonomy-status" role="status">{{ t('admin.taxonomy.m23') }}</p>
        <ElAlert v-else-if="references.state === 'failed'" :title="t(references.message)" type="error" :closable="false" />
        <template v-else>
          <ElKeyValueGrid density="compact">
            <ElKeyValueItem :label="t('admin.taxonomy.m24')" :value="String(references.counts.activeArticles)" />
            <ElKeyValueItem :label="t('admin.taxonomy.m25')" :value="String(references.counts.retainedOnlyArticles)" />
            <ElKeyValueItem :label="t('admin.taxonomy.m26')" :value="String(references.counts.reservedAliases)" />
          </ElKeyValueGrid>
          <p v-if="references.counts.activeArticles || references.counts.retainedOnlyArticles || references.counts.reservedAliases" class="taxonomy-ref-note">
            {{ t('admin.taxonomy.m27') }}
          </p>
          <p v-else class="taxonomy-ref-note">{{ t('admin.taxonomy.m28') }}</p>
        </template>
        <ElInlineActions>
          <ElButton native-type="button" text @click="closeReferences">{{ t('admin.taxonomy.m29') }}</ElButton>
        </ElInlineActions>
      </section>

      <p v-if="page.items.length" :id="`taxonomy-count-notes-${kind}`" class="taxonomy-notes">
        <span class="taxonomy-scroll-note">{{ t('admin.taxonomy.m50') }}</span>
        {{ t('admin.taxonomy.m51', { kind: kindLabel }) }}
      </p>

      <nav v-if="pageNumber > 0 || page.nextId !== null" class="taxonomy-actions" :aria-label="t('admin.taxonomy.m30')">
        <ElInlineActions>
          <ElButton native-type="button" :disabled="pageNumber === 0" @click="load(pageNumber - 1)">{{ t('admin.taxonomy.m31') }}</ElButton>
          <span class="taxonomy-page-status" role="status">{{ t('admin.taxonomy.m45', { page: pageNumber + 1 }) }}</span>
          <ElButton native-type="button" :disabled="page.nextId === null" @click="next">{{ t('admin.taxonomy.m32') }}</ElButton>
        </ElInlineActions>
      </nav>
    </template>
  </ElSettingsSection>
</template>

<style scoped>
.admin-taxonomy h2 {
  font-size: var(--el-font-size-large);
  margin: 0;
}

.taxonomy-status,
.taxonomy-notes,
.taxonomy-ref-note {
  margin: 0;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.taxonomy-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.taxonomy-select-label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
}

.taxonomy-select {
  flex: 0 1 15rem;
  min-inline-size: 11rem;
  max-inline-size: 100%;
}

.taxonomy-table-scroll {
  overflow-x: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--el-bg-color);
}

.taxonomy-table-scroll:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.taxonomy-references {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--fsus-color-surface-raised, var(--el-fill-color-light));
}

.taxonomy-references h3 {
  margin: 0;
  font-size: var(--el-font-size-base);
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.taxonomy-page-status {
  font-size: var(--el-font-size-small);
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}

.taxonomy-scroll-note {
  display: none;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}

caption {
  text-align: start;
  padding: 12px 14px 8px;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

th, td {
  padding: 10px 14px;
  text-align: end;
  border-block-start: 1px solid var(--el-border-color-lighter);
  white-space: nowrap;
  font-size: var(--el-font-size-small);
}

thead th {
  background: var(--fsus-color-surface-raised, var(--el-fill-color-light));
  color: var(--el-text-color-secondary);
  font-weight: 600;
}

tbody tr:hover {
  background: var(--el-fill-color-light);
}

th:first-child {
  min-width: 8rem;
  max-width: 18rem;
  text-align: start;
  white-space: normal;
  overflow-wrap: anywhere;
  color: var(--el-text-color-primary);
}

@media (max-width: 46rem) {
  .taxonomy-scroll-note {
    display: inline;
  }
}
</style>
