<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  AdminArchiveTarget, executeAdminArticleArchive, readAdminArticleArchiveAvailability,
  readAdminArticleArchivePage, requestAdminArticleArchiveProof,
  type AdminArchivedArticle, type AdminArchivedArticles, type AdminArticleArchiveIntent, type AdminArticleArchiveReceipt,
} from '../../../Contracts/admin-article-archive'
import { isValidAdminArticleRollbackReason, type AdminArticleRollbackPreview } from '../../../Contracts/admin-article-rollback'

const props = defineProps<{
  sessionSignal: AbortSignal
  preview?: AdminArticleRollbackPreview
  blocked: boolean
}>()
const emit = defineEmits<{
  'session-lost': [cause: unknown]
  'working-change': [working: boolean]
  'invalidate-review': []
}>()
const lifetime = new AbortController()
const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
const available = ref(false)
const saving = ref(false)
const reading = ref(false)
const page = shallowRef<AdminArchivedArticles>()
const before = ref<number>()
const selected = shallowRef<AdminArchivedArticle>()
const reason = ref('')
const confirmed = ref(false)
const failure = ref('')
const listFailure = ref('')
const retry = shallowRef<AdminArticleArchiveIntent>()
const receipt = shallowRef<AdminArticleArchiveReceipt>()
const archivedTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const review = computed(() => {
  if (selected.value) {
    const row = selected.value
    return {
      articleId: row.articleId, expectedRevision: row.revision, expectedReleaseId: row.privateReleaseId,
      sourceRevision: row.revision, targetStatus: AdminArchiveTarget.Published,
    }
  }
  const preview = props.preview
  if (preview?.packageComplete) {
    return {
      articleId: preview.articleId, expectedRevision: preview.currentRevision, expectedReleaseId: preview.currentPublicationId,
      sourceRevision: preview.sourceRevision, targetStatus: AdminArchiveTarget.Archived,
    }
  }
})
const working = computed(() => saving.value || retry.value !== undefined)
const blocked = computed(() => props.blocked || working.value)
const canSubmit = computed(() => !!review.value && !blocked.value && !reading.value &&
  confirmed.value && isValidAdminArticleRollbackReason(reason.value.trim()))
const notice = computed(() => {
  const result = receipt.value
  if (!result) return ''
  return result.targetStatus === AdminArchiveTarget.Archived
    ? `Archived revision ${result.revision} as private release ${result.releaseId}`
    : `Republished revision ${result.revision} as publication ${result.releaseId}`
})
watch(working, value => emit('working-change', value), { flush: 'sync' })
watch(review, () => { reason.value = ''; confirmed.value = false })
onScopeDispose(() => lifetime.abort())

async function load(requestedBefore?: number) {
  if (reading.value || signal.aborted) return
  reading.value = true
  listFailure.value = ''
  try {
    const next = await readAdminArticleArchivePage(requestedBefore, signal)
    if (!signal.aborted) {
      page.value = next
      before.value = requestedBefore
      selected.value = undefined
    }
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else listFailure.value = 'Could not read archived articles. Try again.'
  } finally { reading.value = false }
}

function select(row?: AdminArchivedArticle) {
  if (blocked.value || reading.value || signal.aborted) return
  selected.value = row
  failure.value = ''
  receipt.value = undefined
}

async function submit() {
  if (!available.value || props.blocked || saving.value || reading.value || signal.aborted) return
  const pending = retry.value
  const coordinates = review.value
  const intent = pending ?? (coordinates && canSubmit.value
    ? { ...coordinates, idempotencyKey: crypto.randomUUID(), reason: reason.value.trim() }
    : undefined)
  if (!intent) return
  saving.value = true
  failure.value = ''
  receipt.value = undefined
  let sent = pending !== undefined
  try {
    const proof = pending ? undefined : await requestAdminArticleArchiveProof(intent, signal)
    if (signal.aborted) return
    sent = true
    const saved = await executeAdminArticleArchive(intent, proof, signal)
    if (signal.aborted) return
    receipt.value = saved
    retry.value = undefined
    selected.value = undefined
    reason.value = ''
    confirmed.value = false
    emit('invalidate-review')
    await load()
  } catch (cause) {
    if (signal.aborted) return
    confirmed.value = false
    if (cause instanceof ApiError && cause.status === 401) {
      emit('session-lost', cause)
    } else if (sent && (!(cause instanceof ApiError) || cause.status >= 500)) {
      retry.value = intent
      failure.value = 'The result is unknown. Check this same command before trying again.'
    } else if (pending || cause instanceof ApiError && cause.status === 409) {
      retry.value = undefined
      selected.value = undefined
      emit('invalidate-review')
      failure.value = 'Review the current article before repeating this operation.'
      await load()
    } else if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
      failure.value = 'Passkey confirmation was canceled or expired.'
    } else {
      failure.value = 'Could not complete the archive operation. Check access and try again.'
    }
  } finally { saving.value = false }
}

onMounted(async () => {
  try {
    const enabled = await readAdminArticleArchiveAvailability(signal)
    if (!signal.aborted && enabled) {
      available.value = true
      await load()
    }
  } catch (cause) {
    if (!signal.aborted && cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
  }
})
</script>

<template>
  <div v-if="available" class="admin-archive">
    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" />
    <ElAlert v-if="notice" :title="notice" type="success" :closable="false" />
    <ElButton v-if="retry" native-type="button" :loading="saving" :disabled="props.blocked || reading" @click="submit">
      Check archive command result
    </ElButton>
    <div v-else-if="review" class="archive-review">
      <template v-if="selected">
        <h3>Republish {{ selected.title }}</h3>
        <p>Article {{ selected.articleId }} · Revision {{ selected.revision }} · Private release {{ selected.privateReleaseId }}</p>
      </template>
      <label for="admin-archive-reason">{{ selected ? 'Reason for republishing this revision' : 'Reason for archiving this revision' }}</label>
      <ElInput id="admin-archive-reason" v-model="reason" type="textarea" :disabled="blocked" @input="confirmed = false" />
      <ElCheckbox :model-value="confirmed" :disabled="blocked" @update:model-value="confirmed = $event === true">
        {{ selected ? 'Publish this exact archived revision' : 'Create an archived revision and withdraw the current publication' }}
      </ElCheckbox>
      <div class="archive-actions">
        <ElButton native-type="button" :type="selected ? 'primary' : 'danger'" :plain="!selected"
          :disabled="!canSubmit" :loading="saving" @click="submit">
          {{ selected ? 'Republish with Passkey' : 'Archive revision and withdraw' }}
        </ElButton>
        <ElButton v-if="selected" native-type="button" text :disabled="blocked || reading" @click="select()">Cancel republish</ElButton>
      </div>
    </div>
    <section class="admin-archive" aria-labelledby="archived-articles-heading" :aria-busy="reading">
      <h3 id="archived-articles-heading">Archived articles</h3>
      <ElAlert v-if="listFailure" :title="listFailure" type="error" :closable="false" />
      <p v-else-if="page?.items.length === 0" role="status">No archived articles on this page.</p>
      <ul v-else-if="page" class="archive-list">
        <li v-for="row in page.items" :key="row.articleId">
          <strong>{{ row.title }}</strong>
          <p>Article {{ row.articleId }} · Revision {{ row.revision }}</p>
          <time :datetime="new Date(Number(row.archivedUnixMs)).toISOString()">
            {{ archivedTime.format(Number(row.archivedUnixMs)) }}
          </time>
          <ElButton native-type="button" text :disabled="blocked || reading" @click="select(row)">Review for republishing</ElButton>
        </li>
      </ul>
      <div class="archive-actions">
        <ElButton native-type="button" text :disabled="blocked || reading" @click="load()">
          {{ before === undefined ? 'Refresh archived articles' : 'First archive page' }}
        </ElButton>
        <ElButton v-if="page?.nextId" native-type="button" text :disabled="blocked || reading"
          @click="load(page?.nextId ?? undefined)">Next archive page</ElButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.admin-archive, .archive-review { display: grid; align-items: start; gap: .5rem; }
.admin-archive { margin-block-start: .5rem; padding-block-start: .75rem; border-block-start: 1px solid var(--el-border-color); }
.admin-archive h3, .admin-archive p { margin-block: 0; overflow-wrap: anywhere; }
.archive-list { display: grid; gap: .75rem; margin: 0; padding: 0; list-style: none; }
.archive-list li { display: grid; justify-items: start; gap: .25rem; overflow-wrap: anywhere; }
.archive-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.archive-actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
</style>
