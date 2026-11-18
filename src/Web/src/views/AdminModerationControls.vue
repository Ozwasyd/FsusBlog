<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElCheckbox, ElCopyableDetail, ElEmptyState, ElFormSection,
  ElInlineActions, ElInput, ElResourceList,
  ElResourceListItem, ElSettingsSection, ElSkeleton, ElTag, ElTimeline, ElTimelineItem,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { readAdminCommentQueue, type AdminCommentCursor, type AdminCommentQueue } from '../../../Contracts/admin-identity'
import {
  claimComment,
  decideComment,
  releaseCommentClaim,
  renewCommentClaim,
  validModerationReason,
  type AdminModerationClaim,
  type AdminModerationDecision,
} from '../../../Contracts/admin-moderation'
import { claimModerationBatch, proveAndDecideModerationBatch, readModerationBatchConflicts } from '../../../Contracts/admin-moderation-batch'
import { proveAdminModerationDecision } from '../../../Contracts/admin-step-up'
import { readCommentRevisions, readModerationTimeline, validModerationCoordinates,
  type CommentRevisionPage, type ModerationTimeline } from '../../../Contracts/comment-moderation-timeline'
import { WireLimits } from '../../../Contracts/wire.generated'
import AdminAppealReview from './AdminAppealReview.vue'

type ConflictMessage = { key: MessageKey; conflicts: readonly AdminCommentCursor[] }
type DisplayMessage = MessageKey | { key: MessageKey; params: Record<string, string | number> } | ConflictMessage
function displayMessage(message: DisplayMessage): string {
  if (typeof message === 'string') return t(message)
  if ('conflicts' in message) return t(message.key, {
    unavailable: message.conflicts.map(row => t('admin.moderation.m62', {
      article: row.articleId, comment: row.commentId.toString(),
    })).join(' · '),
  })
  return t(message.key, message.params)
}

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: ApiError] }>()
const queue = shallowRef<AdminCommentQueue | null>(null)
const claim = shallowRef<AdminModerationClaim | null>(null)
const batchClaims = shallowRef<readonly AdminModerationClaim[] | null>(null)
const selected = shallowRef<ReadonlySet<string>>(new Set())
const reason = ref('')
const trimmedReason = computed(() => reason.value.trim())
const reasonValid = computed(() => validModerationReason(trimmedReason.value))
const batchReason = ref('')
const trimmedBatchReason = computed(() => batchReason.value.trim())
const batchReasonValid = computed(() => validModerationReason(trimmedBatchReason.value))
const batchHeading = ref<HTMLElement>()
const batchExpiry = computed(() => batchClaims.value && Math.min(...batchClaims.value.map(row => Number(row.expiresAt))))
const selectedTargets = computed(() => queue.value?.comments.filter(row => selected.value.has(coordinate(row))) ?? [])
const visibleComments = computed(() => batchClaims.value ? selectedTargets.value : queue.value?.comments ?? [])
const batchAvailable = computed(() => queue.value?.batchEnabled === true &&
  queue.value.comments.length >= WireLimits.AdminModerationBatchMinimum && !claim.value)
const busy = ref(false)
const failure = ref<DisplayMessage | ''>('')
const notice = ref<DisplayMessage | ''>('')
const historyArticle = ref('')
const historyComment = ref('')
const history = shallowRef<ModerationTimeline | null>(null)
const revisions = shallowRef<CommentRevisionPage | null>(null)
const revisionHeading = ref<HTMLElement>()
const canReadHistory = computed(() => !busy.value && validModerationCoordinates(historyArticle.value, historyComment.value))
const statuses = ['admin.moderation.m1', 'admin.moderation.m2', 'admin.moderation.m3', 'admin.moderation.m4'] as const
const eventLabels: Record<string, MessageKey> = {
  create: 'admin.moderation.m5', approve: 'admin.moderation.m2', reject: 'admin.moderation.m3', hide: 'admin.moderation.m4', edit: 'admin.moderation.m6', delete: 'admin.moderation.m7',
  appeal: 'admin.moderation.m8', appeal_decision: 'admin.moderation.m9',
}
const lifetime = new AbortController()
let cursor: AdminCommentCursor | null = null
let claimTimer: ReturnType<typeof setTimeout> | undefined
let batchTimer: ReturnType<typeof setTimeout> | undefined
let reviewAuthority = new AbortController()

onMounted(() => {
  if (!props.sessionSignal.aborted && !queue.value) void load()
})

onUnmounted(() => {
  lifetime.abort()
  clearTimeout(claimTimer)
  clearTimeout(batchTimer)
})

watch(() => props.sessionSignal, (signal, _, onCleanup) => {
  reviewAuthority.abort()
  const authority = new AbortController()
  reviewAuthority = authority
  clearReview()
  const reset = () => {
    authority.abort()
    clearReview()
  }
  if (signal.aborted) reset()
  else {
    signal.addEventListener('abort', reset, { once: true })
    onCleanup(() => signal.removeEventListener('abort', reset))
    void load()
  }
}, { immediate: true, flush: 'sync' })

function clearHistory() {
  history.value = null
  revisions.value = null
}

watch([historyArticle, historyComment], clearHistory, { flush: 'sync' })

function clearReview() {
  setClaim(null)
  clearBatch()
  cursor = null
  queue.value = null
  busy.value = false
  notice.value = ''
  failure.value = ''
  historyArticle.value = ''
  historyComment.value = ''
  clearHistory()
}

function isClaimed(row: AdminCommentCursor): boolean {
  return claim.value?.articleId === row.articleId && claim.value.commentId === row.commentId
}

function setClaim(next: AdminModerationClaim | null) {
  clearTimeout(claimTimer)
  if (!next || !isClaimed(next)) reason.value = ''
  claim.value = next
  if (!next) return
  const until = Number(next.expiresAt)
  const expire = () => {
    const remaining = until - Date.now()
    if (remaining > 0) claimTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
    else {
      setClaim(null)
      failure.value = 'admin.moderation.m10'
    }
  }
  expire()
}

async function run(action: (signal: AbortSignal) => Promise<void>, explain: (error: unknown) => DisplayMessage) {
  if (busy.value || props.sessionSignal.aborted) return
  const signal = AbortSignal.any([lifetime.signal, reviewAuthority.signal, props.sessionSignal])
  busy.value = true
  failure.value = ''
  notice.value = ''
  try { await action(signal) }
  catch (error) {
    if (signal.aborted) return
    if (error instanceof ApiError && error.status === 401) {
      clearReview()
      emit('sessionLost', error)
    } else if (error instanceof ApiError && error.status === 403) {
      clearReview()
      failure.value = 'admin.moderation.m11'
    } else failure.value = explain(error)
  } finally {
    if (!signal.aborted) busy.value = false
  }
}

function repeatableConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 409)
}

function load(after: AdminCommentCursor | null = null) {
  if (claim.value || batchClaims.value) return
  return run(async signal => {
    clearBatch()
    queue.value = null
    const response = await readAdminCommentQueue(after, signal)
    if (signal.aborted) return
    cursor = after
    queue.value = response
  }, () => 'admin.moderation.m12')
}

function loadHistory() {
  const article = historyArticle.value
  const comment = historyComment.value
  if (!validModerationCoordinates(article, comment)) return
  return run(async signal => {
    clearHistory()
    const result = await readModerationTimeline(article, comment, signal)
    if (!signal.aborted && article === historyArticle.value && comment === historyComment.value) history.value = result
  }, error => error instanceof ApiError && error.status === 404
    ? 'admin.moderation.m13' : 'admin.moderation.m14')
}

function loadRevisions(before: number | null = null) {
  if (!canReadHistory.value) return
  const article = historyArticle.value
  const comment = historyComment.value
  return run(async signal => {
    if (!before) clearHistory()
    const page = await readCommentRevisions(article, comment, before, signal)
    if (signal.aborted || article !== historyArticle.value || comment !== historyComment.value) return
    revisions.value = page
    await nextTick()
    if (!signal.aborted) revisionHeading.value?.focus()
  }, error => error instanceof ApiError && error.status === 404
    ? 'admin.moderation.m15' : 'admin.moderation.m16')
}

function claimForReview(target: AdminCommentCursor) {
  if (claim.value || batchClaims.value || selected.value.size) return
  return run(async signal => {
    const receipt = await claimComment(target, signal)
    if (!signal.aborted) setClaim(receipt)
  }, error => repeatableConflict(error) ? 'admin.moderation.m17'
    : 'admin.moderation.m18')
}

function renew() {
  const receipt = claim.value
  if (!receipt) return
  return run(async signal => {
    const renewed = await renewCommentClaim(receipt, signal)
    if (!signal.aborted) setClaim(renewed)
  }, error => claimFailure(error, 'admin.moderation.m19'))
}

function release() {
  const receipt = claim.value
  if (!receipt) return
  return run(async signal => {
    await releaseCommentClaim(receipt, signal)
    if (signal.aborted) return
    setClaim(null)
    notice.value = 'admin.moderation.m20'
  }, error => claimFailure(error, 'admin.moderation.m21'))
}

function claimFailure(error: unknown, fallback: DisplayMessage): DisplayMessage {
  if (!repeatableConflict(error)) return fallback
  setClaim(null)
  return 'admin.moderation.m22'
}

function decide(decision: 1 | 2) {
  const receipt = claim.value
  if (!receipt || !reasonValid.value) return
  const command: AdminModerationDecision = {
    articleId: receipt.articleId,
    commentId: receipt.commentId,
    expectedStatus: 0,
    decision,
    reason: trimmedReason.value,
    commentVersion: receipt.commentVersion,
    claimToken: receipt.claimToken,
    claimGeneration: receipt.claimGeneration,
    claimVersion: receipt.claimVersion,
  }
  return run(async signal => {
    const proof = await proveAdminModerationDecision(command, signal)
    if (signal.aborted || claim.value !== receipt) return
    await decideComment(command, proof, signal)
    if (signal.aborted) return
    setClaim(null)
    queue.value = null
    notice.value = decision === 1 ? 'admin.moderation.m23' : 'admin.moderation.m24'
    const updated = await readAdminCommentQueue(cursor, signal)
    if (!signal.aborted) queue.value = updated
  }, error => claimFailure(error, notice.value
    ? 'admin.moderation.m25' : 'admin.moderation.m26'))
}

function coordinate(row: AdminCommentCursor): string {
  return `${row.articleId}/${row.commentId}`
}

function select(row: AdminCommentCursor, checked: boolean) {
  if (!batchAvailable.value || batchClaims.value || busy.value || props.sessionSignal.aborted) return
  const next = new Set(selected.value)
  if (!checked) next.delete(coordinate(row))
  else if (next.size < WireLimits.AdminModerationBatchCount) next.add(coordinate(row))
  selected.value = next
}

function clearBatch() {
  clearTimeout(batchTimer)
  batchClaims.value = null
  selected.value = new Set()
  batchReason.value = ''
}

function startBatch() {
  const targets = selectedTargets.value
  if (!batchAvailable.value || batchClaims.value || targets.length < WireLimits.AdminModerationBatchMinimum) return
  return run(async signal => {
    const receipts = await claimModerationBatch(targets, signal)
    if (signal.aborted) return
    batchClaims.value = receipts
    const expire = () => {
      if (batchClaims.value !== receipts) return
      const remaining = (batchExpiry.value ?? 0) - Date.now()
      if (remaining > 0) batchTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
      else {
        clearBatch()
        failure.value = 'admin.moderation.m27'
      }
    }
    expire()
    await nextTick()
    if (!signal.aborted && batchClaims.value === receipts) batchHeading.value?.focus()
  }, error => batchConflict(error, targets) ?? 'admin.moderation.m28')
}

function batchConflict(error: unknown, targets: readonly AdminCommentCursor[]): ConflictMessage | null {
  const conflicts = readModerationBatchConflicts(error, targets)
  if (!conflicts) return null
  return { key: 'admin.moderation.m63', conflicts }
}

async function releaseBatchClaims(receipts: readonly AdminModerationClaim[], signal: AbortSignal): Promise<boolean> {
  let released = true
  for (const receipt of receipts) {
    try { await releaseCommentClaim(receipt, signal) }
    catch (error) {
      if (signal.aborted || (error instanceof ApiError && (error.status === 401 || error.status === 403))) throw error
      if (!repeatableConflict(error)) released = false
    }
  }
  return released
}

function cancelBatch() {
  const receipts = batchClaims.value
  if (!receipts) return
  return run(async signal => {
    clearBatch()
    const released = await releaseBatchClaims(receipts, signal)
    if (signal.aborted) return
    if (released) notice.value = 'admin.moderation.m29'
    else failure.value = 'admin.moderation.m30'
  }, () => 'admin.moderation.m30')
}

function decideBatch(decision: 1 | 2) {
  const receipts = batchClaims.value
  if (!receipts || !batchReasonValid.value) return
  const rows = receipts.map(({ expiresAt: _, ...receipt }) => ({ ...receipt, expectedStatus: 0 as const }))
  const command = { decision, reason: trimmedBatchReason.value, rows }
  return run(async signal => {
    try {
      const receipt = await proveAndDecideModerationBatch(command, signal)
      if (signal.aborted) return
      clearBatch()
      failure.value = ''
      queue.value = null
      notice.value = decision === 1 ? { key: 'admin.moderation.m65', params: { count: receipt.count } } : { key: 'admin.moderation.m66', params: { count: receipt.count } }
      const updated = await readAdminCommentQueue(cursor, signal)
      if (!signal.aborted) queue.value = updated
    } catch (error) {
      if (signal.aborted) return
      const conflict = batchConflict(error, rows)
      if (!conflict) throw error
      clearBatch()
      const released = await releaseBatchClaims(receipts, signal)
      if (!signal.aborted) failure.value = released ? conflict : { ...conflict, key: 'admin.moderation.m64' }
    }
  }, () => notice.value ? 'admin.moderation.m25'
    : 'admin.moderation.m31')
}
</script>

<template>
  <ElSettingsSection class="admin-moderation" ariaLabelledby="admin-moderation-heading" density="compact">
    <template #title>
      <span id="admin-moderation-heading">{{ t('admin.moderation.m32') }}</span>
    </template>
    <template #actions>
      <ElButton native-type="button" :text="Boolean(queue)" :disabled="Boolean(claim || batchClaims)" :loading="busy" @click="load()">{{ t('admin.moderation.m33') }}</ElButton>
    </template>

    <ElAlert v-if="failure" :title="displayMessage(failure)" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="displayMessage(notice)" type="success" :closable="false" show-icon />
    <ElSkeleton v-if="busy && !queue" :rows="3" animated />

    <template v-if="queue">
      <div v-if="batchAvailable" class="moderation-batch-panel">
        <template v-if="batchClaims && batchExpiry">
          <h3 ref="batchHeading" tabindex="-1">{{ t('admin.moderation.m44') }}</h3>
          <p role="status">{{ t('admin.moderation.m69', { count: batchClaims.length }) }}</p>
          <p class="moderation-expiry">
            {{ t('admin.moderation.m45') }}
            <time :datetime="new Date(batchExpiry).toISOString()">{{ new Date(batchExpiry).toLocaleTimeString() }}</time>
          </p>
          <div class="moderation-field">
            <label for="admin-moderation-batch-reason">{{ t('admin.moderation.m46') }}</label>
            <ElInput id="admin-moderation-batch-reason" v-model="batchReason" type="textarea" :disabled="busy" />
          </div>
          <p v-if="trimmedBatchReason && !batchReasonValid" class="moderation-validation">{{ t('admin.moderation.m47') }}</p>
          <ElInlineActions>
            <ElButton native-type="button" type="primary" :disabled="busy || !batchReasonValid" @click="decideBatch(1)">
              {{ t('admin.moderation.m48') }}
            </ElButton>
            <ElButton native-type="button" :disabled="busy || !batchReasonValid" @click="decideBatch(2)">
              {{ t('admin.moderation.m49') }}
            </ElButton>
            <ElButton native-type="button" :disabled="busy" @click="cancelBatch">{{ t('admin.moderation.m50') }}</ElButton>
          </ElInlineActions>
        </template>
        <div v-else class="moderation-batch-bar">
          <ElButton native-type="button"
            :disabled="busy || selected.size < WireLimits.AdminModerationBatchMinimum" @click="startBatch">{{ t('admin.moderation.m51') }}</ElButton>
          <p class="moderation-status" role="status">
            {{ t('admin.moderation.m70', { count: selected.size, min: WireLimits.AdminModerationBatchMinimum, max: WireLimits.AdminModerationBatchCount }) }}
          </p>
        </div>
      </div>

      <ElEmptyState v-if="queue.comments.length === 0" size="inline" :title="t('admin.moderation.m52')" role="status" />
      <ElResourceList v-else class="moderation-comments" density="compact">
        <div v-for="item in visibleComments" :key="`${item.articleId}-${item.commentId}`" class="moderation-comment-row" role="listitem">
          <article class="moderation-comment-card">
            <header class="moderation-comment-header">
              <h3>{{ item.displayName }}</h3>
              <p class="moderation-comment-meta">
                {{ t('admin.moderation.m71', { article: item.articleId, comment: item.commentId.toString() }) }}
                · <time :datetime="new Date(item.createdAt).toISOString()">{{ new Date(item.createdAt).toLocaleString() }}</time>
              </p>
            </header>
            <p class="moderation-body">{{ item.body }}</p>
            <div class="moderation-comment-controls">
              <ElCheckbox
                v-if="batchAvailable"
                class="moderation-selection"
                :model-value="selected.has(coordinate(item))"
                :disabled="busy || Boolean(batchClaims) || (selected.size >= WireLimits.AdminModerationBatchCount && !selected.has(coordinate(item)))"
                @update:model-value="select(item, $event === true)"
              >
                {{ t('admin.moderation.m72', { comment: item.commentId.toString() }) }}
              </ElCheckbox>
              <div v-if="claim && isClaimed(item)" class="moderation-claim">
                <p class="moderation-status" role="status">{{ t('admin.moderation.m53') }}</p>
                <p class="moderation-expiry">
                  {{ t('admin.moderation.m54') }}
                  <time :datetime="new Date(Number(claim.expiresAt)).toISOString()">{{ new Date(Number(claim.expiresAt)).toLocaleTimeString() }}</time>
                </p>
                <div class="moderation-field">
                  <label for="admin-moderation-reason">{{ t('admin.moderation.m55') }}</label>
                  <ElInput id="admin-moderation-reason" v-model="reason" type="textarea" :disabled="busy" />
                </div>
                <p v-if="trimmedReason && !reasonValid" class="moderation-validation">{{ t('admin.moderation.m47') }}</p>
                <ElInlineActions>
                  <ElButton native-type="button" type="primary" :disabled="busy || !reasonValid" @click="decide(1)">
                    {{ t('admin.moderation.m56') }}
                  </ElButton>
                  <ElButton native-type="button" :disabled="busy || !reasonValid" @click="decide(2)">
                    {{ t('admin.moderation.m57') }}
                  </ElButton>
                  <ElButton native-type="button" :disabled="busy" @click="renew">{{ t('admin.moderation.m58') }}</ElButton>
                  <ElButton native-type="button" :disabled="busy" @click="release">{{ t('admin.moderation.m59') }}</ElButton>
                </ElInlineActions>
              </div>
              <ElButton
                v-else-if="!batchClaims"
                native-type="button"
                :disabled="busy || Boolean(claim) || selected.size > 0"
                @click="claimForReview(item)"
              >{{ t('admin.moderation.m60') }}</ElButton>
            </div>
          </article>
        </div>
      </ElResourceList>

      <div v-if="queue.next" class="moderation-more">
        <ElButton native-type="button" text :disabled="busy || Boolean(claim || batchClaims)" @click="load(queue.next)">{{ t('admin.moderation.m61') }}</ElButton>
      </div>
    </template>

    <AdminAppealReview :session-signal="sessionSignal" @session-lost="emit('sessionLost', $event)" />

    <ElFormSection title-tag="h3" ariaLabelledby="admin-comment-history-heading" density="compact">
      <template #title>
        <span id="admin-comment-history-heading">{{ t('admin.moderation.m34') }}</span>
      </template>
      <form id="admin-comment-history-form" class="moderation-lookup-form" @submit.prevent="loadHistory">
        <div class="moderation-lookup-fields">
          <div class="moderation-field">
            <label for="admin-comment-history-article">{{ t('admin.moderation.m35') }}</label>
            <ElInput id="admin-comment-history-article" v-model="historyArticle" v-bind="{ inputmode: 'numeric', maxlength: 10 }" :disabled="busy" />
          </div>
          <div class="moderation-field">
            <label for="admin-comment-history-comment">{{ t('admin.moderation.m36') }}</label>
            <ElInput id="admin-comment-history-comment" v-model="historyComment" v-bind="{ inputmode: 'numeric', maxlength: 19 }" :disabled="busy" />
          </div>
        </div>
        <ElInlineActions>
          <ElButton native-type="submit" :disabled="!canReadHistory">{{ t('admin.moderation.m37') }}</ElButton>
          <ElButton native-type="button" :disabled="!canReadHistory" @click="loadRevisions()">{{ t('admin.moderation.m38') }}</ElButton>
        </ElInlineActions>
      </form>

      <template v-if="history">
        <p class="moderation-status" role="status">
          {{ t('admin.moderation.m67', { status: t(history.deleted ? 'admin.moderation.m7' : statuses[history.currentStatus]) }) }}
        </p>
        <ElAlert v-if="!history.consistent" :title="t('admin.moderation.m39')" type="warning" :closable="false" />
        <ElEmptyState v-if="history.events.length === 0" size="inline" :title="t('admin.moderation.m40')" />
        <ElTimeline v-else class="moderation-timeline">
          <ElTimelineItem
            v-for="(event, index) in history.events"
            :key="index"
            :timestamp="new Date(event.occurredAtUtc).toLocaleString()"
            placement="top"
          >
            <div class="moderation-timeline-event">
              <div class="moderation-timeline-head">
                <strong>{{ Object.hasOwn(eventLabels, event.eventType) ? t(eventLabels[event.eventType]) : event.eventType }}</strong>
                <template v-if="eventLabels[event.eventType] !== statuses[event.nextStatus]"> · {{ t(statuses[event.nextStatus]) }}</template>
                · {{ event.actorType }}
                · <time :datetime="event.occurredAtUtc">{{ new Date(event.occurredAtUtc).toLocaleString() }}</time>
              </div>
              <p v-if="event.reasonCode" class="moderation-body">{{ event.reasonCode }}</p>
            </div>
          </ElTimelineItem>
        </ElTimeline>
      </template>

      <template v-if="revisions">
        <h4 ref="revisionHeading" class="moderation-subheading" tabindex="-1">{{ t('admin.moderation.m41') }}</h4>
        <ElResourceList class="moderation-revisions" density="compact">
          <ElResourceListItem
            v-for="revision in revisions.rows"
            :key="revision.version"
            :title="t('admin.moderation.m68', { version: revision.version })"
          >
            <template #badge>
              <ElTag size="small" type="info">{{ revision.operation }}</ElTag>
            </template>
            <template #meta>
              <time :datetime="revision.createdAtUtc">{{ new Date(revision.createdAtUtc).toLocaleString() }}</time>
            </template>
            <p class="moderation-body">{{ revision.content }}</p>
            <details class="moderation-digest-details">
              <summary>{{ t('admin.moderation.m42') }}</summary>
              <ElCopyableDetail :value="revision.contentSha256" />
            </details>
          </ElResourceListItem>
        </ElResourceList>
        <ElInlineActions v-if="revisions.next">
          <ElButton native-type="button" :disabled="!canReadHistory" @click="loadRevisions(revisions.next)">{{ t('admin.moderation.m43') }}</ElButton>
        </ElInlineActions>
      </template>
    </ElFormSection>
  </ElSettingsSection>
</template>

<style scoped>
.moderation-comments {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--el-bg-color);
  overflow: hidden;
}

.moderation-lookup-form,
.moderation-claim,
.moderation-timeline-event {
  display: grid;
  gap: 10px;
}

.moderation-lookup-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.moderation-field {
  display: grid;
  gap: 6px;
}

.moderation-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
}

.moderation-status,
.moderation-expiry,
.moderation-validation,
.moderation-subheading,
.moderation-body {
  margin: 0;
}

.moderation-status,
.moderation-expiry,
.moderation-comment-meta {
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.moderation-comment-meta {
  margin: 0;
}

.moderation-validation {
  font-size: var(--el-font-size-small);
  color: var(--el-color-danger);
}

.moderation-subheading {
  font-size: var(--el-font-size-base);
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.moderation-timeline {
  padding-inline-start: 4px;
  overflow-wrap: anywhere;
}

.moderation-timeline-head {
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.moderation-timeline-head strong {
  color: var(--el-text-color-primary);
}

.moderation-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--el-font-size-base);
  line-height: 1.5;
  color: var(--el-text-color-primary);
}

.moderation-digest-details {
  display: grid;
  gap: 6px;
}

.moderation-digest-details summary {
  cursor: pointer;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.moderation-batch-panel {
  display: grid;
  gap: 10px;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--fsus-color-surface-raised, var(--el-fill-color-light));
}

.moderation-batch-panel h3,
.moderation-batch-panel p {
  margin: 0;
}

.moderation-batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.moderation-comment-row {
  padding: 14px 16px;
}

.moderation-comment-row + .moderation-comment-row {
  border-top: 1px solid var(--el-border-color-lighter);
}

.moderation-comment-card {
  display: grid;
  gap: 10px;
}

.moderation-comment-header {
  display: grid;
  gap: 4px;
}

.moderation-comment-header h3 {
  margin: 0;
  font-size: var(--el-font-size-base);
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow-wrap: anywhere;
}

.moderation-comment-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.moderation-selection {
  max-width: 100%;
  height: auto;
  min-height: var(--el-checkbox-height, 2rem);
  margin-inline: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

.moderation-claim {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--fsus-color-surface-raised, var(--el-fill-color-light));
}

.moderation-more {
  display: flex;
  justify-content: flex-start;
}
</style>
