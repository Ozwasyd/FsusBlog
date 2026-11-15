<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElEmptyState, ElSkeleton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readAdminTaxonomy, type AdminTaxonomyPage } from '../../../Contracts/admin-taxonomy'
import { taxonomyMetadataAvailable } from '../../../Contracts/admin-tag-metadata'
import AdminTagMetadata from './AdminTagMetadata.vue'

type TaxonomyKind = Parameters<typeof readAdminTaxonomy>[0]
const emit = defineEmits<{ 'session-lost': [error: ApiError] }>()
const kind = ref<TaxonomyKind>('categories')
const metadataKind = computed(() => kind.value === 'categories' ? 'category' : 'tag')
const metadataLabel = computed(() => kind.value === 'categories' ? 'Category' : 'Tag')
const page = shallowRef<AdminTaxonomyPage>()
const cursors = shallowRef<readonly (number | null)[]>([null])
const pageNumber = ref(0)
const pending = ref(false)
const failure = ref<'forbidden' | 'request'>()
const canEditMetadata = ref(false)
const target = ref<number>()
const edited = ref<number>()
const notice = ref('')
const heading = ref<HTMLElement>()
let opener: HTMLElement | undefined
let request: AbortController | undefined
let viewGeneration = 0

function reset(next: TaxonomyKind) {
  kind.value = next
  cursors.value = [null]
  notice.value = ''
  void load(0)
}

async function load(index: number) {
  viewGeneration++
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
    // Existing category reads don't depend on the optional metadata writer.
    if (itemKind === 'category') pending.value = false
    if (itemKind === 'category' || data.items.length) {
      const enabled = await taxonomyMetadataAvailable(itemKind, current.signal).catch(() => false)
      if (!current.signal.aborted) canEditMetadata.value = enabled
    }
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

function openEditor(id: number | undefined, event: Event) {
  if (id === undefined || edited.value !== undefined || !canEditMetadata.value) return
  edited.value = id
  notice.value = ''
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
    notice.value = id === 0 ? 'Category created.' : `${metadataLabel.value} metadata saved.`
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

onBeforeUnmount(() => {
  viewGeneration++
  request?.abort()
})
</script>

<template>
  <section class="admin-taxonomy" aria-labelledby="admin-taxonomy-heading" :aria-busy="pending">
    <h2 id="admin-taxonomy-heading" ref="heading" tabindex="-1">Taxonomy usage</h2>
    <div class="taxonomy-actions" role="group" aria-label="Taxonomy type">
      <ElButton native-type="button" :type="kind === 'categories' ? 'primary' : undefined"
        v-bind="{ 'aria-pressed': kind === 'categories' }" @click="reset('categories')">Categories</ElButton>
      <ElButton native-type="button" :type="kind === 'tags' ? 'primary' : undefined"
        v-bind="{ 'aria-pressed': kind === 'tags' }" @click="reset('tags')">Tags</ElButton>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <ElSkeleton v-if="pending" :rows="3" animated />
    <ElAlert v-else-if="failure === 'forbidden'" title="You do not have permission to view taxonomy usage." type="warning" :closable="false" show-icon />
    <ElAlert v-else-if="failure === 'request'" title="Could not load taxonomy usage." type="error" :closable="false" show-icon>
      <ElButton native-type="button" text @click="load(pageNumber)">Try again</ElButton>
    </ElAlert>
    <template v-else-if="page">
      <div v-if="kind === 'categories' && canEditMetadata" class="taxonomy-actions">
        <ElButton native-type="button" :disabled="edited !== undefined" @click="openEditor(0, $event)">Create category</ElButton>
      </div>
      <AdminTagMetadata v-if="edited !== undefined" :key="`${kind}:${edited}`" :kind="metadataKind" :id="edited"
        @close="closeEditor(false)" @saved="closeEditor(true)"
        @session-lost="emit('session-lost', $event)" />
      <ElEmptyState v-if="page.items.length === 0" :title="kind === 'categories' ? 'No categories found' : 'No tags found'" />
      <div v-else class="taxonomy-table-scroll" tabindex="0" role="region" aria-label="Taxonomy usage table" aria-describedby="taxonomy-count-notes">
        <table>
          <caption>{{ kind === 'categories' ? 'Category usage' : 'Tag usage' }}</caption>
          <thead>
            <tr>
              <th scope="col">{{ kind === 'categories' ? 'Category' : 'Tag' }}</th>
              <th scope="col">Published</th>
              <th scope="col">Draft</th>
              <th scope="col">Scheduled</th>
              <th scope="col">Retracted</th>
              <th scope="col">Deleted</th>
              <th scope="col">Retained references</th>
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
      <div v-if="canEditMetadata && page.items.length" class="taxonomy-actions" role="group" :aria-label="`Edit ${kind} on this page`">
        <label :for="`admin-${metadataKind}-target`">{{ metadataLabel }} to edit</label>
        <select :id="`admin-${metadataKind}-target`" v-model="target">
          <option :value="undefined" disabled>Choose a {{ metadataKind }}</option>
          <option v-for="item in page.items" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
        <ElButton native-type="button" text :disabled="!target || edited !== undefined" @click="openEditor(target, $event)">
          Edit selected {{ metadataKind }}
        </ElButton>
      </div>
      <p v-if="page.items.length" id="taxonomy-count-notes" class="taxonomy-notes">
        <span class="taxonomy-scroll-note">Scroll the table to see all counts. </span>
        An article can be both published and scheduled. Retained references include articles with this {{ kind === 'categories' ? 'category' : 'tag' }} on any saved revision.
      </p>
      <nav v-if="pageNumber > 0 || page.nextId !== null" class="taxonomy-actions" aria-label="Taxonomy pagination">
        <ElButton native-type="button" :disabled="pageNumber === 0" @click="load(pageNumber - 1)">Previous page</ElButton>
        <span role="status">Page {{ pageNumber + 1 }}</span>
        <ElButton native-type="button" :disabled="page.nextId === null" @click="next">Next page</ElButton>
      </nav>
    </template>
  </section>
</template>

<style scoped>
.admin-taxonomy { margin-block-start: 1.5rem; display: grid; grid-template-columns: minmax(0, 1fr); gap: .75rem; }
.admin-taxonomy h2 { margin: 0; }
.taxonomy-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.taxonomy-actions > :deep(.el-button + .el-button) { margin-inline-start: 0; }
.taxonomy-table-scroll { overflow-x: auto; }
.taxonomy-table-scroll:focus-visible { outline: 2px solid var(--fsus-color-action-primary); outline-offset: 2px; }
.taxonomy-notes { margin: 0; color: var(--fsus-color-text-muted); }
.taxonomy-scroll-note { display: none; }
table { width: 100%; border-collapse: collapse; }
caption { text-align: start; padding-block: .5rem; color: var(--fsus-color-text-muted); }
th, td { padding: .5rem .625rem; text-align: end; border-block-end: 1px solid var(--fsus-border); white-space: nowrap; }
th:first-child { min-width: 8rem; max-width: 18rem; text-align: start; white-space: normal; overflow-wrap: anywhere; }
@media (max-width: 46rem) { .taxonomy-scroll-note { display: inline; } }
</style>
