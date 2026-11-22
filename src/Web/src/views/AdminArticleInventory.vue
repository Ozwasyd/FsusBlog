<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ElAlert, ElButton, ElDialog, ElEmptyState, ElInlineActions,
  ElInput, ElSkeleton, ElTable, ElTableColumn, ElTag,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { adminDeleteArticle } from '../../../Contracts/admin-identity'
import { isValidAdminArticleRollbackReason } from '../../../Contracts/admin-article-rollback'
import { executeTrashPublication, executeTrashRestore, readTrashPublication, readTrashPublicationAvailability,
  readTrashRestoreAvailability, requestTrashPublicationProof, requestTrashRestoreProof } from '../../../Contracts/admin-article-trash'
import { listAdminArticles, type AuthorArticlePage, type AuthorArticleQuery, type AuthorArticleRow } from '../../../Contracts/author-articles'
import type { AdminArticleTrashPublicationIntent, AdminArticleTrashPublicationPreview, AdminArticleTrashRestoreIntent } from '../../../Contracts/wire.generated'
import { useDelayedBusy } from '../delayedBusy'

const props = withDefaults(defineProps<{
  sessionSignal: AbortSignal
  trash?: boolean
  active?: boolean
  keyword?: string
  taxonomyFilter?: { kind: 'category' | 'tag'; id: number; name: string }
}>(), { trash: false, active: true, keyword: '', taxonomyFilter: undefined })
const emit = defineEmits<{
  'session-lost': [cause: ApiError]
  busy: [value: boolean]
  'update:keyword': [value: string]
  'clear-taxonomy-filter': []
}>()
const lifetime = new AbortController()
const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
const page = shallowRef<AuthorArticlePage>()
const query = shallowRef<AuthorArticleQuery>({ trash: props.trash })
const keyword = computed({ get: () => props.keyword, set: value => emit('update:keyword', value) })
const reading = ref(false)
const failed = ref(false)
const restoreAvailable = ref(false)
const publicationAvailable = ref(false)
const publication = shallowRef<AdminArticleTrashPublicationPreview>()
const reason = ref('')
const selected = shallowRef<AuthorArticleRow>()
const retry = shallowRef<AdminArticleTrashRestoreIntent | AdminArticleTrashPublicationIntent>()
const configuredPublicOrigin = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-origin"]')?.content ?? ''
const publicBase = configuredPublicOrigin && configuredPublicOrigin !== globalThis.location?.origin ? configuredPublicOrigin : ''
const restoring = ref(false)
const restoreFailure = ref<MessageKey | ''>('')
const deleteTarget = shallowRef<AuthorArticleRow>()
const deleting = ref(false)
const deleteFailure = ref<MessageKey | ''>('')
const notice = ref<MessageKey | ''>('')
const noticeParams = shallowRef<Record<string, string | number>>({})
const stateLabels: Record<AuthorArticleRow['state'], MessageKey> = {
  draft: 'admin.inventory.stateDraft', scheduled: 'admin.inventory.stateScheduled',
  published: 'admin.inventory.statePublished', retracted: 'admin.inventory.stateRetracted', deleted: 'admin.inventory.stateDeleted',
}
const stateTagTypes: Record<AuthorArticleRow['state'], 'info' | 'warning' | 'success' | 'danger'> = {
  draft: 'info',
  scheduled: 'warning',
  published: 'success',
  retracted: 'warning',
  deleted: 'danger',
}
const mutating = computed(() => restoring.value || deleting.value || !!retry.value)
const busy = computed(() => reading.value || mutating.value)
const readSource = ref<'initial' | 'search' | 'page' | 'after-mutation' | null>(null)
const searchLoading = useDelayedBusy(() => reading.value && readSource.value === 'search')
let readRequest: AbortController | undefined
const headingId = `admin-article-inventory-${props.trash ? 'trash' : 'active'}`
const keywordId = `${headingId}-keyword`
const rows = computed(() => [...page.value?.items ?? []])
watch(() => busy.value || !!selected.value || !!deleteTarget.value, value => emit('busy', value), { immediate: true, flush: 'sync' })
watch(() => props.active, active => { if (active) void search(query.value.trash, 'initial') })
watch(() => props.taxonomyFilter, () => { if (props.active) void search(query.value.trash, 'initial') })
onScopeDispose(() => {
  readRequest?.abort()
  lifetime.abort()
})

onMounted(() => {
  if (props.active) void search(query.value.trash, 'initial')
  for (const [available, read] of [[restoreAvailable, readTrashRestoreAvailability], [publicationAvailable, readTrashPublicationAvailability]] as const) {
    void read(signal).then(value => { if (!signal.aborted) available.value = value }).catch(sessionError)
  }
})

watch(selected, async (row, _, onCleanup) => {
  publication.value = undefined
  reason.value = ''
  if (!row || !publicationAvailable.value) return
  const request = new AbortController()
  onCleanup(() => request.abort())
  try {
    const former = await readTrashPublication(row.id, row.revision, AbortSignal.any([signal, request.signal]))
    if (!signal.aborted && !request.signal.aborted && selected.value === row) publication.value = former
  } catch (cause) {
    if (!request.signal.aborted) sessionError(cause)
  }
}, { flush: 'sync' })

function sessionError(cause: unknown) {
  if (!signal.aborted && cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
}

async function load(next: AuthorArticleQuery, source: 'initial' | 'search' | 'page' | 'after-mutation' = 'page') {
  if (mutating.value || signal.aborted) return
  readRequest?.abort()
  const current = readRequest = new AbortController()
  const requestSignal = AbortSignal.any([signal, current.signal])
  reading.value = true
  readSource.value = source
  failed.value = false
  query.value = next
  try {
    const result = await listAdminArticles(next, requestSignal)
    if (!requestSignal.aborted) page.value = result
  } catch (cause) {
    if (requestSignal.aborted) return
    page.value = undefined
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else failed.value = true
  } finally {
    if (readRequest === current) {
      readRequest = undefined
      reading.value = false
      readSource.value = null
    }
  }
}

function search(trash = query.value.trash, source: 'initial' | 'search' = 'search') {
  return load({
    trash,
    keyword: keyword.value.trim(),
    match: 'title-summary',
    ...(props.taxonomyFilter?.kind === 'category' ? { categoryId: props.taxonomyFilter.id } : {}),
    ...(props.taxonomyFilter?.kind === 'tag' ? { tagId: props.taxonomyFilter.id } : {}),
  }, source)
}

function nextPage() {
  if (page.value?.nextId) return load({ ...query.value, beforeId: page.value.nextId }, 'page')
}

async function restore(publicly = false) {
  const pending = retry.value
  const row = selected.value
  const former = publication.value
  if (restoring.value || reading.value || signal.aborted || (!pending && !row)) return
  if (!pending && (publicly ? !former || !isValidAdminArticleRollbackReason(reason.value.trim()) : !restoreAvailable.value)) return
  const intent = pending ?? {
    articleId: row!.id, expectedRevision: row!.revision, idempotencyKey: crypto.randomUUID(),
    ...(publicly && former ? { sourceRevision: former.sourceRevision, sourcePublicationId: former.sourcePublicationId, reason: reason.value.trim() } : {}),
  }
  const publicIntent = 'sourcePublicationId' in intent ? intent as AdminArticleTrashPublicationIntent : undefined
  restoreFailure.value = ''
  notice.value = ''
  restoring.value = true
  let submitted = !!pending
  let refresh = false
  try {
    const proof = pending ? undefined : publicIntent
      ? await requestTrashPublicationProof(publicIntent, signal) : await requestTrashRestoreProof(intent, signal)
    signal.throwIfAborted()
    submitted = true
    const receipt = publicIntent ? await executeTrashPublication(publicIntent, proof, signal) : await executeTrashRestore(intent, proof, signal)
    if (signal.aborted) return
    retry.value = undefined
    selected.value = undefined
    noticeParams.value = { article: receipt.articleId, revision: String(receipt.revision) }
    notice.value = publicIntent ? 'admin.inventory.republished' : 'admin.inventory.restored'
    refresh = true
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) {
      emit('session-lost', cause)
    } else if (submitted && (!(cause instanceof ApiError) || cause.status >= 500)) {
      selected.value = undefined
      retry.value = intent
      restoreFailure.value = 'admin.inventory.unknown'
    } else {
      retry.value = undefined
      selected.value = undefined
      restoreFailure.value = 'admin.inventory.restoreFailed'
      refresh = true
    }
  } finally { restoring.value = false }
  if (refresh && !signal.aborted) await load({ ...query.value, beforeId: undefined }, 'after-mutation')
}

async function confirmDelete() {
  const row = deleteTarget.value
  if (!row || deleting.value || signal.aborted) return
  deleting.value = true
  deleteFailure.value = ''
  notice.value = ''
  try {
    await adminDeleteArticle(row.id, signal)
    if (signal.aborted) return
    const deletedTitle = row.title
    deleteTarget.value = undefined
    noticeParams.value = { title: deletedTitle }
    notice.value = 'admin.inventory.deleted'
    deleting.value = false
    await load({ ...query.value, beforeId: undefined }, 'after-mutation')
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) {
      deleteTarget.value = undefined
      emit('session-lost', cause)
    } else {
      deleteFailure.value = 'admin.inventory.deleteFailed'
    }
  } finally { deleting.value = false }
}
</script>

<template>
  <section class="inventory" :aria-labelledby="headingId" :aria-busy="reading">
    <h2 :id="headingId" class="inventory-title">{{ t('admin.inventory.heading') }}</h2>
    <div class="inventory-toolbar">
      <form class="inventory-search" @submit.prevent="search()">
        <label :for="keywordId">{{ t('admin.inventory.keyword') }}</label>
        <ElInput :id="keywordId" v-model="keyword" :disabled="mutating" clearable />
        <ElButton native-type="submit" :disabled="mutating" :loading="searchLoading">{{ t('admin.inventory.search') }}</ElButton>
      </form>
      <RouterLink v-if="!trash" :to="{ name: 'write' }" custom v-slot="{ href, navigate }">
        <ElButton tag="a" type="primary" class="inventory-write-link" v-bind="{ href }" @click="navigate">
          {{ t('admin.inventory.writeNew') }}
        </ElButton>
      </RouterLink>
    </div>
    <div v-if="taxonomyFilter && !trash" class="inventory-filter-bar" role="status">
      <ElTag size="small" type="info">
        {{ t('admin.inventory.taxonomyFilter', { kind: t(taxonomyFilter.kind === 'category' ? 'admin.taxonomy.kindCategory' : 'admin.taxonomy.kindTag'), name: taxonomyFilter.name }) }}
      </ElTag>
      <ElButton native-type="button" text size="small" :disabled="mutating" @click="emit('clear-taxonomy-filter')">
        {{ t('admin.inventory.clearFilter') }}
      </ElButton>
    </div>
    <ElSkeleton v-if="reading && !page" :rows="4" />
    <ElAlert v-if="failed" :title="t('admin.inventory.loadFailed')" type="error" :closable="false" />
    <ElAlert v-if="restoreFailure" :title="t(restoreFailure)" type="warning" :closable="false" />
    <p v-if="notice" class="inventory-status" role="status">{{ t(notice, noticeParams) }}</p>
    <ElInlineActions v-if="retry">
      <ElButton native-type="button" :loading="restoring" @click="restore()">{{ t('admin.inventory.check') }}</ElButton>
    </ElInlineActions>
    <template v-if="page">
      <p class="inventory-count" role="status">{{ t(query.trash ? (page.total === 1 ? 'admin.inventory.deletedOne' : 'admin.inventory.deletedMany') : (page.total === 1 ? 'admin.inventory.activeOne' : 'admin.inventory.activeMany'), { count: page.total }) }}</p>
      <ElEmptyState v-if="!rows.length" :title="t(query.trash ? 'admin.articles.emptyTrash' : 'admin.articles.emptyArticles')" size="compact" />
      <ElTable v-else :data="rows" row-key="id" :responsive="!query.trash || restoreAvailable || publicationAvailable ? 'auto' : 'scroll'" class="inventory-table">
        <ElTableColumn prop="title" :label="t('admin.articles.title')" min-width="240">
          <template #default="{ row }">
            <div class="inventory-record">
              <div class="inventory-record-head">
                <strong>{{ row.title }}</strong>
                <ElTag size="small" :type="stateTagTypes[row.state as AuthorArticleRow['state']]">
                  {{ t(stateLabels[row.state as AuthorArticleRow['state']]) }}
                </ElTag>
              </div>
              <div class="inventory-meta">{{ t('admin.inventory.row', { article: row.id, revision: String(row.revision), state: t(stateLabels[row.state as AuthorArticleRow['state']]) }) }}</div>
              <div v-if="row.category || row.tags.length" class="inventory-meta">{{ [row.category, ...row.tags].filter(Boolean).map((entry: { name: string }) => entry.name).join(' · ') }}</div>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn v-if="!query.trash || restoreAvailable || publicationAvailable" :label="t('admin.articles.actions')" min-width="180">
          <template #default="{ row }">
            <ElButton v-if="query.trash" native-type="button" :disabled="busy" @click="selected = row">
              {{ restoreAvailable ? t('admin.inventory.restoreDraft') : t('admin.inventory.review') }}
            </ElButton>
            <ElInlineActions v-else>
              <ElButton v-if="row.state === 'published'" tag="a" text size="small" class="inventory-action-link" v-bind="{ href: `${publicBase}/article/${row.id}`, target: '_blank', rel: 'noopener' }">
                {{ t('admin.inventory.view') }}
              </ElButton>
              <RouterLink :to="{ name: 'edit', params: { id: row.id } }" custom v-slot="{ href, navigate }">
                <ElButton tag="a" text size="small" class="inventory-action-link" v-bind="{ href }" @click="navigate">
                  {{ t('admin.inventory.edit') }}
                </ElButton>
              </RouterLink>
              <ElButton native-type="button" text size="small" type="danger" :disabled="busy" @click="deleteFailure = ''; deleteTarget = row">
                {{ t('admin.inventory.delete') }}
              </ElButton>
            </ElInlineActions>
          </template>
        </ElTableColumn>
      </ElTable>
      <ElInlineActions v-if="query.beforeId || page.nextId" class="inventory-actions">
        <ElButton v-if="query.beforeId" native-type="button" :disabled="busy" @click="load({ ...query, beforeId: undefined })">{{ t('admin.inventory.first') }}</ElButton>
        <ElButton v-if="page.nextId" native-type="button" :disabled="busy" @click="nextPage">{{ t('admin.inventory.next') }}</ElButton>
      </ElInlineActions>
    </template>
    <ElDialog :model-value="!!selected" :title="t('admin.inventory.restoreTitle')" width="min(30rem, 90vw)"
      :close-on-press-escape="!restoring" :close-on-click-modal="!restoring" :show-close="!restoring"
      @update:model-value="visible => { if (!visible && !restoring) selected = undefined }">
      <div class="inventory-dialog-body">
        <p v-if="selected">{{ t('admin.inventory.confirmDraft', { revision: String(selected.revision), title: selected.title }) }}</p>
        <div v-if="publication" class="inventory-publication">
          <p>{{ t('admin.inventory.confirmPublic', { revision: String(publication.sourceRevision), title: publication.title }) }}</p>
          <div class="inventory-field">
            <label for="admin-trash-publication-reason">{{ t('admin.inventory.reason') }}</label>
            <ElInput id="admin-trash-publication-reason" v-model="reason" :disabled="restoring" />
          </div>
          <ElInlineActions>
            <ElButton native-type="button" :disabled="!isValidAdminArticleRollbackReason(reason.trim())" :loading="restoring" @click="restore(true)">
              {{ t('admin.inventory.restorePublic') }}
            </ElButton>
          </ElInlineActions>
        </div>
      </div>
      <template #footer>
        <ElInlineActions>
          <ElButton native-type="button" :disabled="restoring" @click="selected = undefined">{{ t('admin.inventory.cancel') }}</ElButton>
          <ElButton v-if="restoreAvailable" native-type="button" type="primary" :loading="restoring" @click="restore()">{{ t('admin.inventory.restorePrivate') }}</ElButton>
        </ElInlineActions>
      </template>
    </ElDialog>
    <ElDialog :model-value="!!deleteTarget" :title="t('admin.inventory.deleteTitle')" width="min(28rem, 90vw)"
      :close-on-press-escape="!deleting" :close-on-click-modal="!deleting" :show-close="!deleting"
      @update:model-value="visible => { if (!visible && !deleting) deleteTarget = undefined }">
      <div v-if="deleteTarget" class="inventory-dialog-body">
        <ElAlert v-if="deleteFailure" :title="t(deleteFailure)" type="error" :closable="false" />
        <p>{{ t('admin.inventory.deleteConfirm', { title: deleteTarget.title }) }}</p>
      </div>
      <template #footer>
        <ElInlineActions>
          <ElButton native-type="button" :disabled="deleting" @click="deleteTarget = undefined">{{ t('admin.inventory.cancel') }}</ElButton>
          <ElButton native-type="button" type="danger" :loading="deleting" @click="confirmDelete">{{ t('admin.inventory.deleteAction') }}</ElButton>
        </ElInlineActions>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.inventory-title { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.inventory-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.inventory-search { display: grid; grid-template-columns: auto minmax(12rem, 30rem) auto; align-items: center; justify-content: start; gap: 10px; flex: 1 1 20rem; }
.inventory-write-link, .inventory-action-link { text-decoration: none; }
.inventory-filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.inventory-search label,
.inventory-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
}
.inventory-record { display: grid; gap: 4px; min-width: 0; white-space: normal; }
.inventory-record-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.inventory-record-head > strong { color: var(--el-text-color-primary); font-weight: 600; overflow-wrap: anywhere; }
.inventory-meta, .inventory-count, .inventory-status { color: var(--el-text-color-secondary); font-size: var(--el-font-size-small); overflow-wrap: anywhere; }
.inventory-count, .inventory-status { margin: 4px 0; }
.inventory-table { min-width: 0; }
.inventory-dialog-body, .inventory-publication, .inventory-field { display: grid; gap: 10px; }
.inventory-dialog-body p { margin: 0; }
@media (max-width: 40rem) {
  .inventory-search { grid-template-columns: minmax(0, 1fr) auto; }
  .inventory-search label { grid-column: 1 / -1; }
}

.inventory { display: grid; gap: var(--fsus-space-2); overflow-wrap: anywhere; }
</style>
