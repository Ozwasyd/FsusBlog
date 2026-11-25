<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElCheckbox, ElDangerZone, ElDialog, ElEmptyState, ElFormSection,
  ElInlineActions, ElInput, ElResourceList,
  ElResourceListItem, ElSettingsSection,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  AdminArchiveTarget, executeAdminArticleArchive, readAdminArticleArchiveAvailability,
  readAdminArticleArchivePage, readAdminArticleArchivePreview, requestAdminArticleArchiveProof,
  type AdminArchivedArticle, type AdminArchivedArticles, type AdminArticleArchiveIntent,
  type AdminArticleArchivePreview, type AdminArticleArchiveReceipt,
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
const previewOpen = ref(false)
const previewResult = shallowRef<AdminArticleArchivePreview>()
const previewError = ref<MessageKey | ''>('')
let previewRequest: AbortController | undefined
const reason = ref('')
const confirmed = ref(false)
const failure = ref<MessageKey | ''>('')
const listFailure = ref<MessageKey | ''>('')
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
    ? t('admin.archive.archived', { revision: String(result.revision), release: String(result.releaseId) })
    : t('admin.archive.republished', { revision: String(result.revision), release: String(result.releaseId) })
})
watch(working, value => emit('working-change', value), { flush: 'sync' })
watch(review, () => { reason.value = ''; confirmed.value = false })
watch(selected, closeArchivePreview, { flush: 'sync' })
signal.addEventListener('abort', closeArchivePreview, { once: true })
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
    else listFailure.value = 'admin.archive.listFailed'
  } finally { reading.value = false }
}

function select(row?: AdminArchivedArticle) {
  if (blocked.value || reading.value || signal.aborted) return
  selected.value = row
  failure.value = ''
  receipt.value = undefined
}

async function openArchivePreview(row: AdminArchivedArticle) {
  if (blocked.value || signal.aborted || previewOpen.value) return
  const request = new AbortController()
  previewRequest = request
  previewOpen.value = true
  try {
    const result = await readAdminArticleArchivePreview(row, AbortSignal.any([signal, request.signal]))
    if (!signal.aborted && !request.signal.aborted && selected.value === row) previewResult.value = result
  } catch (cause) {
    if (signal.aborted || request.signal.aborted || selected.value !== row) return
    if (cause instanceof ApiError && cause.status === 401) {
      closeArchivePreview()
      emit('session-lost', cause)
    } else {
      previewError.value = 'admin.archive.previewFailed'
    }
  }
}

function closeArchivePreview() {
  previewRequest?.abort()
  previewRequest = undefined
  previewOpen.value = false
  previewResult.value = undefined
  previewError.value = ''
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
      failure.value = 'admin.archive.unknown'
    } else if (pending || cause instanceof ApiError && cause.status === 409) {
      retry.value = undefined
      selected.value = undefined
      emit('invalidate-review')
      failure.value = 'admin.archive.reviewAgain'
      await load()
    } else if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
      failure.value = 'admin.archive.passkeyCanceled'
    } else {
      failure.value = 'admin.archive.failed'
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
    <ElAlert v-if="failure" :title="t(failure)" type="error" :closable="false" />
    <ElAlert v-if="notice" :title="notice" type="success" :closable="false" />
    <div v-if="retry">
      <ElButton native-type="button" :loading="saving" :disabled="props.blocked || reading" @click="submit">
        {{ t('admin.archive.check') }}
      </ElButton>
    </div>
    <component :is="selected ? ElFormSection : ElDangerZone" v-else-if="review" class="archive-review" density="compact">
      <template v-if="selected">
        <div class="archive-selected-head">
          <h3>{{ t('admin.archive.republishTitle', { title: selected.title }) }}</h3>
          <p class="archive-coordinates">{{ t('admin.archive.coordinates', { article: selected.articleId, revision: String(selected.revision), release: String(selected.privateReleaseId) }) }}</p>
          <div>
            <ElButton native-type="button" text :disabled="blocked || reading" v-bind="{ 'aria-haspopup': 'dialog' }"
              @click="openArchivePreview(selected)">{{ t('admin.archive.preview') }}</ElButton>
          </div>
        </div>
      </template>
      <div class="archive-field">
        <label for="admin-archive-reason">{{ selected ? t('admin.archive.republishReason') : t('admin.archive.archiveReason') }}</label>
        <ElInput id="admin-archive-reason" v-model="reason" type="textarea" :disabled="blocked" @input="confirmed = false" />
      </div>
      <ElCheckbox :model-value="confirmed" :disabled="blocked" @update:model-value="confirmed = $event === true">
        {{ selected ? t('admin.archive.confirmRepublish') : t('admin.archive.confirmArchive') }}
      </ElCheckbox>
      <ElInlineActions class="archive-actions">
        <ElButton native-type="button" :type="selected ? 'primary' : 'danger'" :plain="!selected"
          :disabled="!canSubmit" :loading="saving" @click="submit">
          {{ selected ? t('admin.archive.republish') : t('admin.archive.archive') }}
        </ElButton>
        <ElButton v-if="selected" native-type="button" text :disabled="blocked || reading" @click="select()">{{ t('admin.archive.cancel') }}</ElButton>
      </ElInlineActions>
    </component>

    <ElSettingsSection class="admin-archive-list-section" title-tag="h3" ariaLabelledby="archived-articles-heading" v-bind="{ 'aria-busy': reading }" density="compact">
      <template #title>
        <span id="archived-articles-heading">{{ t('admin.archive.heading') }}</span>
      </template>
      <template #actions>
        <ElInlineActions>
          <ElButton native-type="button" text :disabled="blocked || reading" @click="load()">
            {{ before === undefined ? t('admin.archive.refresh') : t('admin.archive.first') }}
          </ElButton>
          <ElButton v-if="page?.nextId" native-type="button" text :disabled="blocked || reading"
            @click="load(page?.nextId ?? undefined)">{{ t('admin.archive.next') }}</ElButton>
        </ElInlineActions>
      </template>
      <ElAlert v-if="listFailure" :title="t(listFailure)" type="error" :closable="false" />
      <ElEmptyState v-else-if="page?.items.length === 0" size="inline" :title="t('admin.archive.empty')" role="status" />
      <ElResourceList v-else-if="page" class="archive-list" density="compact">
        <ElResourceListItem v-for="row in page.items" :key="row.articleId" :title="row.title">
          <template #meta>
            <span>
              {{ t('admin.archive.row', { article: row.articleId, revision: String(row.revision) }) }}
              · <time :datetime="new Date(Number(row.archivedUnixMs)).toISOString()">
                {{ archivedTime.format(Number(row.archivedUnixMs)) }}
              </time>
            </span>
          </template>
          <template #actions>
            <ElButton native-type="button" text :disabled="blocked || reading" @click="select(row)">{{ t('admin.archive.review') }}</ElButton>
          </template>
        </ElResourceListItem>
      </ElResourceList>
    </ElSettingsSection>

    <ElDialog :model-value="previewOpen" :title="t('admin.archive.sourceTitle')" append-to-body destroy-on-close
      width="min(52rem, calc(100vw - 2rem))" top="5vh" @close="closeArchivePreview">
      <ElAlert v-if="previewError" :title="t(previewError)" type="error" :closable="false" />
      <template v-else-if="previewResult">
        <h3 class="archive-preview-title">{{ previewResult.title }}</h3>
        <pre class="archive-source" tabindex="0" :aria-label="t('admin.archive.sourceLabel')">{{ previewResult.markdown }}</pre>
      </template>
      <p v-else-if="previewOpen" role="status">{{ t('admin.archive.loading') }}</p>
    </ElDialog>
  </div>
</template>

<style scoped lang="scss">
@use '../review-panel' as layout;
@use '../shared-fields' as fields;
.admin-archive { display: grid; gap: 16px; }
.archive-selected-head, .archive-field { display: grid; gap: 6px; }
.archive-selected-head h3 { @include layout.review-item-heading; }
.archive-coordinates { margin: 0; font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.archive-field label { @include fields.admin-label; }
.archive-preview-title { margin: 0 0 10px; overflow-wrap: anywhere; }
.archive-source { max-block-size: 55vh; margin: 0; padding: 12px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--fsus-radius-control, 6px); background: var(--fsus-color-surface-raised, var(--el-fill-color-light)); overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
