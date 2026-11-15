<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
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
import { readModerationTimeline, validModerationCoordinates, type ModerationTimeline } from '../../../Contracts/comment-moderation-timeline'
import { WireLimits } from '../../../Contracts/wire.generated'
import AdminAppealReview from './AdminAppealReview.vue'

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
const failure = ref('')
const notice = ref('')
const historyArticle = ref('')
const historyComment = ref('')
const history = shallowRef<ModerationTimeline | null>(null)
const statuses = ['Pending', 'Approved', 'Rejected', 'Hidden'] as const
const eventLabels: Record<string, string> = {
  create: 'Submitted', approve: 'Approved', reject: 'Rejected', hide: 'Hidden', edit: 'Edited', delete: 'Deleted',
  appeal: 'Appeal submitted', appeal_decision: 'Appeal decided',
}
const lifetime = new AbortController()
let cursor: AdminCommentCursor | null = null
let claimTimer: ReturnType<typeof setTimeout> | undefined
let batchTimer: ReturnType<typeof setTimeout> | undefined
let reviewAuthority = new AbortController()

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
  }
}, { immediate: true, flush: 'sync' })

watch([historyArticle, historyComment], () => { history.value = null }, { flush: 'sync' })

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
  history.value = null
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
      failure.value = 'Your review claim expired.'
    }
  }
  expire()
}

async function run(action: (signal: AbortSignal) => Promise<void>, explain: (error: unknown) => string) {
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
      failure.value = 'You do not have permission to view the moderation queue.'
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
  }, () => 'Could not load the moderation queue. Try again.')
}

function loadHistory() {
  const article = historyArticle.value
  const comment = historyComment.value
  if (!validModerationCoordinates(article, comment)) return
  return run(async signal => {
    history.value = null
    const result = await readModerationTimeline(article, comment, signal)
    if (!signal.aborted && article === historyArticle.value && comment === historyComment.value) history.value = result
  }, error => error instanceof ApiError && error.status === 404
    ? 'Comment history was not found for these IDs.' : 'Could not load comment history. Try again.')
}

function claimForReview(target: AdminCommentCursor) {
  if (claim.value || batchClaims.value || selected.value.size) return
  return run(async signal => {
    const receipt = await claimComment(target, signal)
    if (!signal.aborted) setClaim(receipt)
  }, error => repeatableConflict(error) ? 'Another reviewer has claimed this comment or it is no longer pending.'
    : 'Could not claim the comment. Try again.')
}

function renew() {
  const receipt = claim.value
  if (!receipt) return
  return run(async signal => {
    const renewed = await renewCommentClaim(receipt, signal)
    if (!signal.aborted) setClaim(renewed)
  }, error => claimFailure(error, 'Could not renew the claim. Try again.'))
}

function release() {
  const receipt = claim.value
  if (!receipt) return
  return run(async signal => {
    await releaseCommentClaim(receipt, signal)
    if (signal.aborted) return
    setClaim(null)
    notice.value = 'Claim released.'
  }, error => claimFailure(error, 'Could not release the claim. Try again.'))
}

function claimFailure(error: unknown, fallback: string): string {
  if (!repeatableConflict(error)) return fallback
  setClaim(null)
  return 'This claim is no longer active. Reload the moderation queue.'
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
    notice.value = decision === 1 ? 'Comment approved.' : 'Comment rejected.'
    const updated = await readAdminCommentQueue(cursor, signal)
    if (!signal.aborted) queue.value = updated
  }, error => claimFailure(error, notice.value
    ? 'Could not reload the moderation queue. Try again.' : 'Could not complete the decision. Verify your Passkey and try again.'))
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
        failure.value = 'Your batch review claims expired.'
      }
    }
    expire()
    await nextTick()
    if (!signal.aborted && batchClaims.value === receipts) batchHeading.value?.focus()
  }, error => batchConflict(error, targets) ?? 'Could not claim the selected comments. Try again.')
}

function batchConflict(error: unknown, targets: readonly AdminCommentCursor[]): string | null {
  const conflicts = readModerationBatchConflicts(error, targets)
  if (!conflicts) return null
  const unavailable = conflicts.map(row => `article ${row.articleId}, comment ${row.commentId}`).join(' · ')
  return `Could not review ${unavailable}. Reload the moderation queue.`
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
    if (released) notice.value = 'Batch review canceled.'
    else failure.value = 'Could not release all claims. Unreleased claims expire automatically.'
  }, () => 'Could not release all claims. Unreleased claims expire automatically.')
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
      notice.value = decision === 1 ? `${receipt.count} comments approved.` : `${receipt.count} comments rejected.`
      const updated = await readAdminCommentQueue(cursor, signal)
      if (!signal.aborted) queue.value = updated
    } catch (error) {
      if (signal.aborted) return
      const conflict = batchConflict(error, rows)
      if (!conflict) throw error
      clearBatch()
      const released = await releaseBatchClaims(receipts, signal)
      if (!signal.aborted) failure.value = released ? conflict : `${conflict} Unreleased claims expire automatically.`
    }
  }, () => notice.value ? 'Could not reload the moderation queue. Try again.'
    : 'Could not complete the batch decision. Verify your Passkey and try again.')
}
</script>

<template>
  <section class="auth-form admin-moderation" aria-labelledby="admin-moderation-heading">
    <h2 id="admin-moderation-heading">Moderation queue</h2>
    <ElButton native-type="button" :disabled="Boolean(claim || batchClaims)" :loading="busy" @click="load()">Load moderation queue</ElButton>
    <AdminAppealReview :session-signal="sessionSignal" @session-lost="emit('sessionLost', $event)" />
    <section class="moderation-claim" aria-labelledby="admin-comment-history-heading">
      <h3 id="admin-comment-history-heading">Comment moderation history</h3>
      <form class="moderation-claim" @submit.prevent="loadHistory">
        <label for="admin-comment-history-article">Article ID</label>
        <ElInput id="admin-comment-history-article" v-model="historyArticle" v-bind="{ inputmode: 'numeric', maxlength: 10 }" :disabled="busy" />
        <label for="admin-comment-history-comment">Comment ID</label>
        <ElInput id="admin-comment-history-comment" v-model="historyComment" v-bind="{ inputmode: 'numeric', maxlength: 19 }" :disabled="busy" />
        <div><ElButton native-type="submit" :disabled="busy || !validModerationCoordinates(historyArticle, historyComment)">Load comment history</ElButton></div>
      </form>
      <template v-if="history">
        <p role="status">Current status: {{ history.deleted ? 'Deleted' : statuses[history.currentStatus] }}.</p>
        <ElAlert v-if="!history.consistent" title="The recorded history does not establish the current status." type="warning" :closable="false" />
        <p v-if="history.events.length === 0">No moderation events were recorded.</p>
        <ol v-else class="moderation-history-list">
          <li v-for="(event, index) in history.events" :key="index">
            <strong>{{ Object.hasOwn(eventLabels, event.eventType) ? eventLabels[event.eventType] : event.eventType }}</strong>
            · {{ statuses[event.nextStatus] }} · {{ event.actorType }}
            · <time :datetime="event.occurredAtUtc">{{ new Date(event.occurredAtUtc).toLocaleString() }}</time>
            <p v-if="event.reasonCode" class="moderation-body">{{ event.reasonCode }}</p>
          </li>
        </ol>
      </template>
    </section>
    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="notice" type="success" :closable="false" show-icon />
    <template v-if="queue">
      <div v-if="batchAvailable" class="moderation-claim">
        <template v-if="batchClaims && batchExpiry">
          <h3 ref="batchHeading" tabindex="-1">Batch review</h3>
          <p role="status">{{ batchClaims.length }} comments claimed for review.</p>
          <p>
            Review claims expire
            <time :datetime="new Date(batchExpiry).toISOString()">{{ new Date(batchExpiry).toLocaleTimeString() }}</time>
          </p>
          <label for="admin-moderation-batch-reason">Reason for batch decision</label>
          <ElInput id="admin-moderation-batch-reason" v-model="batchReason" type="textarea" :disabled="busy" />
          <p v-if="trimmedBatchReason && !batchReasonValid">Use one line of plain text and keep the reason within 1,024 bytes.</p>
          <div class="moderation-actions">
            <ElButton class="moderation-action" native-type="button" type="primary" :disabled="busy || !batchReasonValid" @click="decideBatch(1)">
              Approve selected comments with Passkey
            </ElButton>
            <ElButton class="moderation-action" native-type="button" :disabled="busy || !batchReasonValid" @click="decideBatch(2)">
              Reject selected comments with Passkey
            </ElButton>
            <ElButton class="moderation-action" native-type="button" :disabled="busy" @click="cancelBatch">Cancel batch review</ElButton>
          </div>
        </template>
        <div v-else class="moderation-actions">
          <ElButton class="moderation-action" native-type="button"
            :disabled="busy || selected.size < WireLimits.AdminModerationBatchMinimum" @click="startBatch">Claim selected comments</ElButton>
          <p role="status">{{ selected.size }} selected ({{ WireLimits.AdminModerationBatchMinimum }}–{{ WireLimits.AdminModerationBatchCount }})</p>
        </div>
      </div>
      <p v-if="queue.comments.length === 0" role="status">No comments are waiting for moderation.</p>
      <ol v-else class="moderation-comments">
        <li v-for="item in visibleComments" :key="`${item.articleId}-${item.commentId}`">
          <article>
            <h3>{{ item.displayName }}</h3>
            <p>
              Article {{ item.articleId }} · Comment {{ item.commentId.toString() }}
              · <time :datetime="new Date(item.createdAt).toISOString()">{{ new Date(item.createdAt).toLocaleString() }}</time>
            </p>
            <p class="moderation-body">{{ item.body }}</p>
            <ElCheckbox v-if="batchAvailable" class="moderation-selection" :model-value="selected.has(coordinate(item))"
              :disabled="busy || Boolean(batchClaims) || (selected.size >= WireLimits.AdminModerationBatchCount && !selected.has(coordinate(item)))"
              @update:model-value="select(item, $event === true)">
              Select comment {{ item.commentId.toString() }} for batch review
            </ElCheckbox>
            <div v-if="claim && isClaimed(item)" class="moderation-claim">
              <p role="status">Claimed for review</p>
              <p>
                Claim expires
                <time :datetime="new Date(Number(claim.expiresAt)).toISOString()">{{ new Date(Number(claim.expiresAt)).toLocaleTimeString() }}</time>
              </p>
              <label for="admin-moderation-reason">Reason for moderation decision</label>
              <ElInput id="admin-moderation-reason" v-model="reason" type="textarea" :disabled="busy" />
              <p v-if="trimmedReason && !reasonValid">Use one line of plain text and keep the reason within 1,024 bytes.</p>
              <div class="moderation-actions">
                <ElButton class="moderation-action" native-type="button" type="primary" :disabled="busy || !reasonValid" @click="decide(1)">
                  Approve with Passkey
                </ElButton>
                <ElButton class="moderation-action" native-type="button" :disabled="busy || !reasonValid" @click="decide(2)">
                  Reject with Passkey
                </ElButton>
              </div>
              <div class="moderation-actions">
                <ElButton class="moderation-action" native-type="button" :disabled="busy" @click="renew">Renew claim</ElButton>
                <ElButton class="moderation-action" native-type="button" :disabled="busy" @click="release">Release claim</ElButton>
              </div>
            </div>
            <ElButton v-else-if="!batchClaims" native-type="button" :disabled="busy || Boolean(claim) || selected.size > 0"
              @click="claimForReview(item)">Claim comment for review</ElButton>
          </article>
        </li>
      </ol>
      <ElButton v-if="queue.next" native-type="button" :disabled="busy || Boolean(claim || batchClaims)" @click="load(queue.next)">Next page</ElButton>
    </template>
  </section>
</template>

<style scoped>
.admin-moderation { margin-block-start: 1.5rem; }
.moderation-comments { display: grid; gap: 1.5rem; padding-inline-start: 1.5rem; }
.moderation-comments h3, .moderation-body { overflow-wrap: anywhere; }
.moderation-body { white-space: pre-wrap; }
.moderation-selection { max-width: 100%; height: auto; min-height: var(--el-checkbox-height, 2rem); margin-inline: 0; white-space: normal; overflow-wrap: anywhere; }
.moderation-selection + .el-button { margin-inline-start: 0.75rem; }
.moderation-claim { display: grid; gap: 0.75rem; }
.moderation-claim p, .moderation-claim h3 { margin: 0; }
.moderation-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.moderation-actions .moderation-action { margin-inline-start: 0; }
.moderation-history-list { display: grid; gap: var(--fsus-space-2); padding-inline-start: 1.5rem; overflow-wrap: anywhere; }
</style>
