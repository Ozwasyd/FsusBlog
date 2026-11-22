<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElDialog, ElEmptyState, ElInlineActions,
  ElInput, ElSettingsSection, ElSkeleton,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readAdminTaxonomy, type AdminTaxonomyItem, type AdminTaxonomyPage } from '../../../Contracts/admin-taxonomy'
import { deleteTaxonomy, taxonomyMetadataAvailable } from '../../../Contracts/admin-tag-metadata'
import AdminTagMetadata from './AdminTagMetadata.vue'

type TaxonomyKind = Parameters<typeof readAdminTaxonomy>[0]

const props = defineProps<{ initialKind: TaxonomyKind; active: boolean }>()
const emit = defineEmits<{
  'session-lost': [error: ApiError]
  'view-articles': [filter: { kind: 'category' | 'tag'; id: number; name: string }]
}>()
const kind = ref<TaxonomyKind>(props.initialKind)
const metadataKind = computed<'category' | 'tag'>(() => kind.value === 'categories' ? 'category' : 'tag')
const kindLabel = computed(() => t(kind.value === 'categories' ? 'admin.taxonomy.kindCategory' : 'admin.taxonomy.kindTag'))
const page = shallowRef<AdminTaxonomyPage>()
const cursors = shallowRef<readonly (number | null)[]>([null])
const pageNumber = ref(0)
const pending = ref(false)
const failure = ref<'request'>()
const canEditMetadata = ref(false)
const searchQuery = ref('')
const edited = ref<number>()
const deleteTarget = shallowRef<AdminTaxonomyItem>()
const deleting = ref(false)
const deleteError = ref('')
const notice = ref<{ key: MessageKey; kind: TaxonomyKind; name?: string }>()
const heading = ref<HTMLElement>()
let opener: HTMLElement | undefined
let deleteOpener: HTMLElement | undefined
let request: AbortController | undefined
let deleteController: AbortController | undefined
let viewGeneration = 0

const filteredItems = computed(() => {
  const items = page.value?.items ?? []
  const query = searchQuery.value.trim().toLocaleLowerCase()
  if (!query) return items
  return items.filter(item => item.name.toLocaleLowerCase().includes(query))
})

const editorTitle = computed(() => {
  if (edited.value === undefined) return ''
  return edited.value === 0
    ? t('admin.tagMetadata.m7', { kind: kindLabel.value })
    : t('admin.tagMetadata.m8', { kind: kindLabel.value })
})

async function load(index: number) {
  viewGeneration++
  request?.abort()
  const current = new AbortController()
  const listKind = kind.value
  const itemKind = metadataKind.value
  request = current
  page.value = undefined
  edited.value = undefined
  deleteTarget.value = undefined
  deleteError.value = ''
  canEditMetadata.value = false
  failure.value = undefined
  pageNumber.value = index
  pending.value = true
  try {
    const [data, enabled] = await Promise.all([
      readAdminTaxonomy(listKind, cursors.value[index] ?? null, current.signal),
      taxonomyMetadataAvailable(itemKind, current.signal).catch(() => false),
    ])
    if (current.signal.aborted) return
    page.value = data
    canEditMetadata.value = enabled
  } catch (error) {
    if (current.signal.aborted) return
    if (error instanceof ApiError && error.status === 401) emit('session-lost', error)
    else failure.value = 'request'
  } finally {
    if (request === current) {
      request = undefined
      pending.value = false
    }
  }
}

function openEditor(id: number, event?: Event) {
  if (edited.value !== undefined || !canEditMetadata.value) return
  edited.value = id
  notice.value = undefined
  opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
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

function openDelete(item: AdminTaxonomyItem, event?: Event) {
  if (deleting.value || !canEditMetadata.value) return
  deleteError.value = ''
  deleteOpener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  deleteTarget.value = item
}

async function closeDelete() {
  if (deleting.value) return
  const previousOpener = deleteOpener
  deleteOpener = undefined
  deleteTarget.value = undefined
  deleteError.value = ''
  await nextTick()
  if (previousOpener?.isConnected) previousOpener.focus({ preventScroll: true })
}

async function confirmDelete() {
  const item = deleteTarget.value
  if (!item || deleting.value || item.retainedArticles > 0) return
  deleting.value = true
  deleteError.value = ''
  deleteController?.abort()
  const controller = new AbortController()
  deleteController = controller
  try {
    await deleteTaxonomy(metadataKind.value, item.id, controller.signal)
    if (controller.signal.aborted) return
    const deletedName = item.name
    const targetPage = page.value && page.value.items.length <= 1 && pageNumber.value > 0
      ? pageNumber.value - 1
      : pageNumber.value
    if (targetPage < pageNumber.value) cursors.value = cursors.value.slice(0, targetPage + 1)
    deleteOpener = undefined
    deleteTarget.value = undefined
    notice.value = { key: 'admin.taxonomy.deleted', kind: kind.value, name: deletedName }
    const view = viewGeneration
    await load(targetPage)
    await nextTick()
    if (viewGeneration === view + 1) heading.value?.focus()
  } catch (error) {
    if (controller.signal.aborted) return
    if (error instanceof ApiError && error.status === 401) {
      deleteOpener = undefined
      deleteTarget.value = undefined
      emit('session-lost', error)
    } else if (error instanceof ApiError && error.status === 409) {
      deleteError.value = error.message
    } else {
      deleteError.value = t('admin.taxonomy.deleteFailed', { kind: kindLabel.value })
    }
  } finally {
    if (deleteController === controller) deleteController = undefined
    deleting.value = false
  }
}

function viewLinkedArticles(item: AdminTaxonomyItem) {
  deleteOpener = undefined
  deleteTarget.value = undefined
  emit('view-articles', { kind: metadataKind.value, id: item.id, name: item.name })
}

function formatOtherStates(item: AdminTaxonomyItem) {
  if (item.drafts === 0 && item.scheduled === 0 && item.retracted === 0 && item.deleted === 0 && item.retainedArticles === item.published) {
    return t('admin.taxonomy.noOtherStates')
  }
  return t('admin.taxonomy.otherStateSummary', {
    drafts: item.drafts,
    scheduled: item.scheduled,
    retracted: item.retracted,
    deleted: item.deleted,
    retained: item.retainedArticles,
  })
}

function next() {
  if (pending.value || !page.value?.nextId) return
  cursors.value = [...cursors.value.slice(0, pageNumber.value + 1), page.value.nextId]
  void load(pageNumber.value + 1)
}

onMounted(() => { void load(0) })
watch(() => props.active, active => {
  if (!active || edited.value !== undefined || deleteTarget.value !== undefined) return
  cursors.value = [null]
  notice.value = undefined
  void load(0)
})
onBeforeUnmount(() => {
  viewGeneration++
  request?.abort()
  deleteController?.abort()
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
      <ElButton class="taxonomy-refresh" text :disabled="pending || edited !== undefined" @click="load(pageNumber)">{{ t('admin.articles.refresh') }}</ElButton>
    </template>

    <p v-if="notice" class="taxonomy-status" role="status">
      {{ notice.name
        ? t(notice.key, { kind: t(notice.kind === 'categories' ? 'admin.taxonomy.m1' : 'admin.taxonomy.m2'), name: notice.name })
        : t(notice.key, { label: t(notice.kind === 'categories' ? 'admin.taxonomy.m1' : 'admin.taxonomy.m2') }) }}
    </p>
    <ElSkeleton v-if="pending" animated />
    <ElAlert v-else-if="failure === 'request'" :title="t('admin.taxonomy.m8')" type="error" :closable="false" show-icon>
      <ElButton text @click="load(pageNumber)">{{ t('admin.taxonomy.m9') }}</ElButton>
    </ElAlert>
    <template v-else-if="page">
      <div class="taxonomy-toolbar">
        <ElInput
          v-model="searchQuery"
          class="taxonomy-search-input"
          :placeholder="t('admin.taxonomy.searchPlaceholder', { kind: kindLabel })"
          :label="t('admin.taxonomy.searchPlaceholder', { kind: kindLabel })"
          clearable
        />
        <ElButton
          v-if="canEditMetadata"
          type="primary"
          :disabled="edited !== undefined"
          @click="openEditor(0, $event)"
        >
          {{ t('admin.taxonomy.m41', { kind: kindLabel }) }}
        </ElButton>
      </div>

      <ElEmptyState v-if="page.items.length === 0" :title="kind === 'categories' ? t('admin.taxonomy.m10') : t('admin.taxonomy.m11')" />
      <ElEmptyState v-else-if="filteredItems.length === 0" :title="t('admin.taxonomy.noSearchMatch', { kind: kindLabel })" />
      <div v-else class="taxonomy-table-scroll" tabindex="0" role="region" :aria-label="t('admin.taxonomy.m12')" :aria-describedby="`taxonomy-count-notes-${kind}`">
        <table>
          <thead>
            <tr>
              <th scope="col">{{ kind === 'categories' ? t('admin.taxonomy.m1') : t('admin.taxonomy.m2') }}</th>
              <th scope="col">{{ t('admin.taxonomy.m15') }}</th>
              <th scope="col">{{ t('admin.taxonomy.otherStates') }}</th>
              <th scope="col">{{ t('admin.taxonomy.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredItems" :key="item.id">
              <th scope="row">{{ item.name }}</th>
              <td>
                <ElButton
                  v-if="item.published > 0"
                  text
                  size="small"
                  class="taxonomy-count-link"
                  @click="viewLinkedArticles(item)"
                >
                  {{ item.published }}
                </ElButton>
                <span v-else>0</span>
              </td>
              <td class="taxonomy-other-states">{{ formatOtherStates(item) }}</td>
              <td class="taxonomy-row-actions">
                <ElInlineActions>
                  <ElButton text size="small" @click="viewLinkedArticles(item)">
                    {{ t('admin.taxonomy.viewArticles') }}
                  </ElButton>
                  <ElButton v-if="canEditMetadata" text size="small" :disabled="edited !== undefined" @click="openEditor(item.id, $event)">
                    {{ t('admin.taxonomy.edit') }}
                  </ElButton>
                  <ElButton v-if="canEditMetadata" text size="small" type="danger" :disabled="deleting" @click="openDelete(item, $event)">
                    {{ t('admin.taxonomy.delete') }}
                  </ElButton>
                </ElInlineActions>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="page.items.length" :id="`taxonomy-count-notes-${kind}`" class="taxonomy-notes">
        <span class="taxonomy-scroll-note">{{ t('admin.taxonomy.m50') }}</span>
        {{ t('admin.taxonomy.m51', { kind: kindLabel }) }}
      </p>

      <nav v-if="pageNumber > 0 || page.nextId !== null" class="taxonomy-actions" :aria-label="t('admin.taxonomy.m30')">
        <ElInlineActions>
          <ElButton :disabled="pageNumber === 0" @click="load(pageNumber - 1)">{{ t('admin.taxonomy.m31') }}</ElButton>
          <span class="taxonomy-page-status" role="status">{{ t('admin.taxonomy.m45', { page: pageNumber + 1 }) }}</span>
          <ElButton :disabled="page.nextId === null" @click="next">{{ t('admin.taxonomy.m32') }}</ElButton>
        </ElInlineActions>
      </nav>
    </template>

    <ElDialog
      :model-value="edited !== undefined"
      :title="editorTitle"
      width="min(30rem, 92vw)"
      append-to-body
      @update:model-value="visible => { if (!visible) closeEditor(false) }"
    >
      <AdminTagMetadata
        v-if="edited !== undefined"
        :key="`${kind}:${edited}`"
        :kind="metadataKind"
        :id="edited"
        @close="closeEditor(false)"
        @saved="closeEditor(true)"
        @session-lost="emit('session-lost', $event)"
      />
    </ElDialog>

    <ElDialog
      :model-value="!!deleteTarget"
      :title="t('admin.taxonomy.deleteTitle', { kind: kindLabel })"
      width="min(28rem, 92vw)"
      append-to-body
      :close-on-press-escape="!deleting"
      :close-on-click-modal="!deleting"
      :show-close="!deleting"
      @update:model-value="visible => { if (!visible) void closeDelete() }"
    >
      <div v-if="deleteTarget" class="taxonomy-delete-body">
        <ElAlert v-if="deleteError" :title="deleteError" type="error" :closable="false" />
        <p v-if="deleteTarget.retainedArticles > 0">
          {{ t('admin.taxonomy.deleteBlocked', { kind: kindLabel, name: deleteTarget.name, count: deleteTarget.retainedArticles }) }}
        </p>
        <p v-else>
          {{ t('admin.taxonomy.deleteConfirm', { kind: kindLabel, name: deleteTarget.name }) }}
        </p>
      </div>
      <template #footer>
        <ElInlineActions>
          <ElButton :disabled="deleting" @click="closeDelete">{{ t('admin.taxonomy.deleteCancel') }}</ElButton>
          <ElButton
            v-if="deleteTarget && deleteTarget.retainedArticles > 0"
            type="primary"
            @click="viewLinkedArticles(deleteTarget)"
          >
            {{ t('admin.taxonomy.goViewArticles') }}
          </ElButton>
          <ElButton
            v-else-if="deleteTarget"
            type="danger"
            :loading="deleting"
            @click="confirmDelete"
          >
            {{ t('admin.taxonomy.deleteAction') }}
          </ElButton>
        </ElInlineActions>
      </template>
    </ElDialog>
  </ElSettingsSection>
</template>

<style scoped>
.admin-taxonomy h2 {
  font-size: var(--el-font-size-large);
  margin: 0;
}

.taxonomy-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.taxonomy-search-input {
  flex: 1 1 14rem;
  max-width: 22rem;
}

.taxonomy-status,
.taxonomy-notes {
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

th, td {
  padding: 10px 14px;
  text-align: start;
  border-block-start: 1px solid var(--el-border-color-lighter);
  white-space: nowrap;
  font-size: var(--el-font-size-small);
}

thead th {
  border-block-start: none;
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
  white-space: normal;
  overflow-wrap: anywhere;
  color: var(--el-text-color-primary);
}

.taxonomy-count-link {
  padding: 0 4px;
  min-height: auto;
  font-variant-numeric: tabular-nums;
}

.taxonomy-other-states {
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.taxonomy-row-actions {
  white-space: nowrap;
}

.taxonomy-row-actions :deep(.el-inline-actions) {
  flex-wrap: nowrap;
}

.taxonomy-delete-body {
  display: grid;
  gap: 10px;
}

.taxonomy-delete-body p {
  margin: 0;
  color: var(--el-text-color-regular);
  line-height: 1.5;
}

@media (max-width: 46rem) {
  .taxonomy-scroll-note {
    display: inline;
  }
}
</style>
