<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElDialog, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { isValidAdminArticleRollbackReason } from '../../../Contracts/admin-article-rollback'
import { executeTrashPublication, executeTrashRestore, readTrashPublication, readTrashPublicationAvailability,
  readTrashRestoreAvailability, requestTrashPublicationProof, requestTrashRestoreProof } from '../../../Contracts/admin-article-trash'
import { listAdminArticles, type AuthorArticlePage, type AuthorArticleQuery, type AuthorArticleRow } from '../../../Contracts/author-articles'
import type { AdminArticleTrashPublicationIntent, AdminArticleTrashPublicationPreview, AdminArticleTrashRestoreIntent } from '../../../Contracts/wire.generated'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [cause: ApiError] }>()
const lifetime = new AbortController()
const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
const page = shallowRef<AuthorArticlePage>()
const query = shallowRef<AuthorArticleQuery>({ trash: false })
const keyword = ref('')
const reading = ref(false)
const failed = ref(false)
const restoreAvailable = ref(false)
const publicationAvailable = ref(false)
const publication = shallowRef<AdminArticleTrashPublicationPreview>()
const reason = ref('')
const selected = shallowRef<AuthorArticleRow>()
const retry = shallowRef<AdminArticleTrashRestoreIntent | AdminArticleTrashPublicationIntent>()
const restoring = ref(false)
const restoreFailure = ref<MessageKey | ''>('')
const notice = ref<MessageKey | ''>('')
const noticeParams = shallowRef<Record<string, string | number>>({})
const stateLabels: Record<AuthorArticleRow['state'], MessageKey> = {
  draft: 'admin.inventory.stateDraft', scheduled: 'admin.inventory.stateScheduled',
  published: 'admin.inventory.statePublished', retracted: 'admin.inventory.stateRetracted', deleted: 'admin.inventory.stateDeleted',
}
const busy = computed(() => reading.value || restoring.value || !!retry.value)
onScopeDispose(() => lifetime.abort())

onMounted(() => {
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

async function load(next: AuthorArticleQuery) {
  if (busy.value || signal.aborted) return
  reading.value = true
  failed.value = false
  page.value = undefined
  query.value = next
  try {
    const result = await listAdminArticles(next, signal)
    if (!signal.aborted) page.value = result
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else failed.value = true
  } finally { reading.value = false }
}

function search(trash = query.value.trash) {
  return load({ trash, keyword: keyword.value.trim(), match: 'title-summary' })
}

function nextPage() {
  if (page.value?.nextId) return load({ ...query.value, beforeId: page.value.nextId })
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
  if (refresh && !signal.aborted) await load({ ...query.value, beforeId: undefined })
}
</script>

<template>
  <section class="inventory" aria-labelledby="admin-article-inventory-heading" :aria-busy="reading">
    <h2 id="admin-article-inventory-heading">{{ t('admin.inventory.heading') }}</h2>
    <div class="inventory-actions">
      <ElButton native-type="button" :disabled="busy" v-bind="{ 'aria-pressed': !query.trash }" @click="search(false)">{{ t('admin.inventory.active') }}</ElButton>
      <ElButton native-type="button" :disabled="busy" v-bind="{ 'aria-pressed': query.trash }" @click="search(true)">{{ t('admin.inventory.trash') }}</ElButton>
    </div>
    <form class="inventory-actions" @submit.prevent="search()">
      <label for="admin-article-keyword">{{ t('admin.inventory.keyword') }}</label>
      <ElInput id="admin-article-keyword" v-model="keyword" :disabled="busy" />
      <ElButton native-type="submit" :disabled="busy" :loading="reading">{{ t('admin.inventory.search') }}</ElButton>
    </form>
    <ElAlert v-if="failed" :title="t('admin.inventory.loadFailed')" type="error" :closable="false" />
    <ElAlert v-if="restoreFailure" :title="t(restoreFailure)" type="warning" :closable="false" />
    <p v-if="notice" role="status">{{ t(notice, noticeParams) }}</p>
    <ElButton v-if="retry" native-type="button" :loading="restoring" @click="restore()">{{ t('admin.inventory.check') }}</ElButton>
    <template v-if="page">
      <p role="status">{{ t(query.trash ? (page.total === 1 ? 'admin.inventory.deletedOne' : 'admin.inventory.deletedMany') : (page.total === 1 ? 'admin.inventory.activeOne' : 'admin.inventory.activeMany'), { count: page.total }) }}</p>
      <ul v-if="page.items.length" class="inventory-list">
        <li v-for="item in page.items" :key="item.id">
          <strong>{{ item.title }}</strong>
          <div>{{ t('admin.inventory.row', { article: item.id, revision: String(item.revision), state: t(stateLabels[item.state]) }) }}</div>
          <div v-if="item.category || item.tags.length">{{ [item.category, ...item.tags].filter(Boolean).map(entry => entry?.name).join(' · ') }}</div>
          <ElButton v-if="query.trash && (restoreAvailable || publicationAvailable)" native-type="button" :disabled="busy" @click="selected = item">
            {{ restoreAvailable ? t('admin.inventory.restoreDraft') : t('admin.inventory.review') }}
          </ElButton>
        </li>
      </ul>
      <div v-if="query.beforeId || page.nextId" class="inventory-actions">
        <ElButton v-if="query.beforeId" native-type="button" :disabled="busy" @click="load({ ...query, beforeId: undefined })">{{ t('admin.inventory.first') }}</ElButton>
        <ElButton v-if="page.nextId" native-type="button" :disabled="busy" @click="nextPage">{{ t('admin.inventory.next') }}</ElButton>
      </div>
    </template>
    <ElDialog :model-value="!!selected" :title="t('admin.inventory.restoreTitle')" width="min(30rem, 90vw)"
      :close-on-press-escape="!restoring" :close-on-click-modal="!restoring" :show-close="!restoring"
      @update:model-value="visible => { if (!visible && !restoring) selected = undefined }">
      <p v-if="selected">{{ t('admin.inventory.confirmDraft', { revision: String(selected.revision), title: selected.title }) }}</p>
      <div v-if="publication" class="inventory">
        <p>{{ t('admin.inventory.confirmPublic', { revision: String(publication.sourceRevision), title: publication.title }) }}</p>
        <label for="admin-trash-publication-reason">{{ t('admin.inventory.reason') }}</label>
        <ElInput id="admin-trash-publication-reason" v-model="reason" :disabled="restoring" />
        <ElButton native-type="button" :disabled="!isValidAdminArticleRollbackReason(reason.trim())" :loading="restoring" @click="restore(true)">
          {{ t('admin.inventory.restorePublic') }}
        </ElButton>
      </div>
      <template #footer>
        <ElButton native-type="button" :disabled="restoring" @click="selected = undefined">{{ t('admin.inventory.cancel') }}</ElButton>
        <ElButton v-if="restoreAvailable" native-type="button" type="primary" :loading="restoring" @click="restore()">{{ t('admin.inventory.restorePrivate') }}</ElButton>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.inventory, .inventory-list { display: grid; gap: var(--fsus-space-2); overflow-wrap: anywhere; }
.inventory-actions { display: flex; gap: var(--fsus-space-2); flex-wrap: wrap; align-items: center; }
.inventory-actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
</style>
