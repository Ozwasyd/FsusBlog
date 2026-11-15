<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  executeAdminArticleDraftRollback, readAdminArticleDraftRollbackAvailability, requestAdminArticleDraftRollbackProof,
  executeAdminArticleRollback, isValidAdminArticleRollbackReason, readAdminArticleRollbackAvailability,
  readAdminArticleRollbackPreview, requestAdminArticleRollbackProof,
  type AdminArticleDraftRollbackIntent, type AdminArticleDraftRollbackReceipt,
  type AdminArticleRollbackIntent, type AdminArticleRollbackPreview, type AdminArticleRollbackReceipt,
} from '../../../Contracts/admin-article-rollback'

type RollbackIntent = AdminArticleRollbackIntent | AdminArticleDraftRollbackIntent
type RollbackReceipt = AdminArticleRollbackReceipt | AdminArticleDraftRollbackReceipt

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [cause: unknown] }>()
const lifetime = new AbortController()
const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
const available = ref(false)
const draftAvailable = ref(false)
const articleId = ref('')
const sourceRevision = ref('')
const reason = ref('')
const confirmed = ref(false)
const draftReason = ref('')
const draftConfirmed = ref(false)
const busy = ref(false)
const error = ref('')
const preview = shallowRef<AdminArticleRollbackPreview>()
const retry = shallowRef<RollbackIntent>()
const receipt = shallowRef<RollbackReceipt>()
const sourceCoordinates = computed(() => {
  if (!/^[1-9][0-9]{0,9}$/.test(articleId.value) || !/^[1-9][0-9]{0,18}$/.test(sourceRevision.value)) return
  const article = Number(articleId.value)
  const source = BigInt(sourceRevision.value)
  if (article <= 2_147_483_647 && source <= 9_223_372_036_854_775_807n) return { article, source }
})
const canRollback = computed(() => !!preview.value?.packageComplete && !busy.value && !retry.value)
const canPublish = computed(() => canRollback.value &&
  confirmed.value && isValidAdminArticleRollbackReason(reason.value.trim()))
const canRestoreDraft = computed(() => canRollback.value && draftAvailable.value &&
  draftConfirmed.value && isValidAdminArticleRollbackReason(draftReason.value.trim()))
const receiptTitle = computed(() => {
  const result = receipt.value
  if (!result) return ''
  return 'privateReleaseId' in result
    ? `Restored revision ${result.revision} as a private draft`
    : `Published revision ${result.revision} as publication ${result.publicationId}`
})
const draftRetry = computed(() => retry.value !== undefined && 'targetStatus' in retry.value)
const blockers = [
  '', 'This revision has no retained rights snapshot.', 'This revision has no retained responsibility snapshot.',
  'Private attachments need review before this revision can be published.', 'Clear the pending publication schedule before continuing.',
  'Resolve the unpublished draft before replacing the current publication.',
]

function resetPreview() {
  preview.value = undefined
  receipt.value = undefined
  error.value = ''
  confirmed.value = false
  draftConfirmed.value = false
}

async function readPreview() {
  const coordinates = sourceCoordinates.value
  if (!coordinates || busy.value || retry.value || signal.aborted) return
  resetPreview()
  busy.value = true
  try {
    const result = await readAdminArticleRollbackPreview(coordinates.article, coordinates.source, signal)
    if (!signal.aborted) preview.value = result
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else if (cause instanceof ApiError && cause.status === 404) error.value = 'This article or historical publication is unavailable.'
    else if (cause instanceof ApiError && cause.status === 409) error.value = 'Resolve current draft or publication changes before opening another preview.'
    else error.value = 'Could not load the publication review. Try again.'
  } finally { busy.value = false }
}

function accept(next: RollbackReceipt) {
  receipt.value = next
  retry.value = undefined
  preview.value = undefined
  reason.value = ''
  confirmed.value = false
  draftReason.value = ''
  draftConfirmed.value = false
}

function execute(intent: RollbackIntent, proof?: string): Promise<RollbackReceipt> {
  return 'targetStatus' in intent
    ? executeAdminArticleDraftRollback(intent, proof, signal)
    : executeAdminArticleRollback(intent, proof, signal)
}

async function rollback(toDraft: boolean) {
  const base = preview.value
  if (!base || !(toDraft ? canRestoreDraft.value : canPublish.value) || signal.aborted) return
  const coordinates: AdminArticleRollbackIntent = {
    articleId: base.articleId,
    expectedRevision: base.currentRevision,
    expectedPublicationId: base.currentPublicationId,
    sourceRevision: base.sourceRevision,
    idempotencyKey: crypto.randomUUID(),
    reason: (toDraft ? draftReason.value : reason.value).trim(),
  }
  const intent = toDraft ? { ...coordinates, targetStatus: 0 } : coordinates
  busy.value = true
  error.value = ''
  let attempted = false
  try {
    const proof = await ('targetStatus' in intent
      ? requestAdminArticleDraftRollbackProof(intent, signal)
      : requestAdminArticleRollbackProof(intent, signal))
    if (signal.aborted) return
    attempted = true
    const saved = await execute(intent, proof)
    if (!signal.aborted) accept(saved)
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
      error.value = 'Passkey confirmation was canceled or expired.'
    } else if (cause instanceof ApiError && cause.status === 409) {
      preview.value = undefined
      error.value = 'The publication changed. Preview the current coordinates again.'
    } else if (!attempted && cause instanceof ApiError && cause.status === 401) {
      emit('session-lost', cause)
    } else if (attempted && (!(cause instanceof ApiError) || cause.status >= 500)) {
      retry.value = intent
      error.value = toDraft ? 'The draft rollback result is unknown. Check the same command before trying again.'
        : 'The publication result is unknown. Check the same command before publishing again.'
    } else {
      error.value = toDraft ? 'Could not restore the draft. Review the article and verify your administrator permissions.'
        : 'Could not publish this revision. Review the article and verify your administrator permissions.'
    }
    confirmed.value = false
    draftConfirmed.value = false
  } finally { busy.value = false }
}

async function checkReceipt() {
  const intent = retry.value
  if (!intent || busy.value || signal.aborted) return
  busy.value = true
  error.value = ''
  try {
    const stored = await execute(intent)
    if (!signal.aborted) accept(stored)
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status < 500) {
      retry.value = undefined
      preview.value = undefined
      error.value = 'The command result could not be recovered. Review the current publication before repeating the operation.'
    } else {
      error.value = 'targetStatus' in intent ? 'The draft rollback result is still unknown. Try checking this command again.'
        : 'The publication result is still unknown. Try checking this command again.'
    }
  } finally { busy.value = false }
}

onMounted(async () => {
  try {
    const enabled = await readAdminArticleRollbackAvailability(signal)
    if (signal.aborted || !enabled) return
    available.value = true
    const canDraft = await readAdminArticleDraftRollbackAvailability(signal)
    if (!signal.aborted) draftAvailable.value = canDraft
  } catch {
    // Only show actions whose independent availability checks succeeded.
  }
})
onScopeDispose(() => lifetime.abort())
</script>

<template>
  <section v-if="available" class="auth-form article-rollback" aria-labelledby="admin-article-rollback-heading" :aria-busy="busy">
    <h2 id="admin-article-rollback-heading">Restore a published article revision</h2>
    <form class="article-rollback" @submit.prevent="readPreview">
      <label for="admin-rollback-article">Article ID</label>
      <ElInput id="admin-rollback-article" v-model="articleId" v-bind="{ inputmode: 'numeric' }" :disabled="busy || !!retry" @input="resetPreview" />
      <label for="admin-rollback-source">Historical revision</label>
      <ElInput id="admin-rollback-source" v-model="sourceRevision" v-bind="{ inputmode: 'numeric' }" :disabled="busy || !!retry" @input="resetPreview" />
      <ElButton native-type="submit" :disabled="!sourceCoordinates || busy || !!retry">Preview publication rollback</ElButton>
    </form>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <ElAlert v-if="receiptTitle" :title="receiptTitle" type="success" :closable="false" />
    <ElButton v-if="retry" native-type="button" :loading="busy" @click="checkReceipt">
      {{ draftRetry ? 'Check draft rollback result' : 'Check publication result' }}
    </ElButton>
    <div v-else-if="preview" class="article-rollback">
      <h3>{{ preview.sourceTitle }}</h3>
      <dl>
        <dt>Current saved revision</dt><dd>{{ preview.currentRevision }}</dd>
        <dt>Current publication</dt><dd>{{ preview.currentPublicationId }}</dd>
        <dt>Source revision</dt><dd>{{ preview.sourceRevision }}</dd>
        <dt>Source publication</dt><dd>{{ preview.sourcePublicationId }}</dd>
      </dl>
      <ElAlert v-if="!preview.packageComplete" :title="blockers[preview.blockingReason]" type="warning" :closable="false" />
      <template v-else>
        <label for="admin-rollback-reason">Reason for publishing this revision</label>
        <ElInput id="admin-rollback-reason" v-model="reason" type="textarea" :disabled="busy" @input="confirmed = false" />
        <ElCheckbox :model-value="confirmed" :disabled="busy" @update:model-value="confirmed = $event === true">
          Publish a new revision with this historical content, rights, and responsibility
        </ElCheckbox>
        <ElButton native-type="button" type="primary" :disabled="!canPublish" :loading="busy" @click="rollback(false)">
          Publish revision with Passkey
        </ElButton>
        <div v-if="draftAvailable" class="article-rollback draft-rollback">
          <label for="admin-rollback-draft-reason">Reason for restoring this revision as a draft</label>
          <ElInput id="admin-rollback-draft-reason" v-model="draftReason" type="textarea" :disabled="busy" @input="draftConfirmed = false" />
          <ElCheckbox :model-value="draftConfirmed" :disabled="busy" @update:model-value="draftConfirmed = $event === true">
            Create a private draft from this revision and withdraw the current publication
          </ElCheckbox>
          <ElButton native-type="button" type="danger" plain :disabled="!canRestoreDraft" :loading="busy" @click="rollback(true)">
            Restore as draft and withdraw
          </ElButton>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.article-rollback { display: grid; align-items: start; gap: .5rem; }
.article-rollback h3 { margin-block: .5rem 0; overflow-wrap: anywhere; }
.article-rollback dl { margin-block: 0; }
.draft-rollback { margin-block-start: .5rem; padding-block-start: .75rem; border-block-start: 1px solid var(--el-border-color); }
</style>
