<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
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
import { proveAdminModerationDecision } from '../../../Contracts/admin-step-up'
import AdminAppealReview from './AdminAppealReview.vue'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: ApiError] }>()
const queue = shallowRef<AdminCommentQueue | null>(null)
const claim = shallowRef<AdminModerationClaim | null>(null)
const reason = ref('')
const trimmedReason = computed(() => reason.value.trim())
const reasonValid = computed(() => validModerationReason(trimmedReason.value))
const busy = ref(false)
const failure = ref('')
const notice = ref('')
const lifetime = new AbortController()
let cursor: AdminCommentCursor | null = null
let claimTimer: ReturnType<typeof setTimeout> | undefined

onUnmounted(() => {
  lifetime.abort()
  clearTimeout(claimTimer)
})

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
  const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
  busy.value = true
  failure.value = ''
  notice.value = ''
  try { await action(signal) }
  catch (error) {
    if (signal.aborted) return
    if (error instanceof ApiError && error.status === 401) emit('sessionLost', error)
    else if (error instanceof ApiError && error.status === 403) {
      setClaim(null)
      queue.value = null
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
  if (claim.value) return
  return run(async signal => {
    queue.value = null
    const response = await readAdminCommentQueue(after, signal)
    if (signal.aborted) return
    cursor = after
    queue.value = response
  }, () => 'Could not load the moderation queue. Try again.')
}

function claimForReview(target: AdminCommentCursor) {
  if (claim.value) return
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
</script>

<template>
  <section class="auth-form admin-moderation" aria-labelledby="admin-moderation-heading">
    <h2 id="admin-moderation-heading">Moderation queue</h2>
    <ElButton native-type="button" :disabled="Boolean(claim)" :loading="busy" @click="load()">Load moderation queue</ElButton>
    <AdminAppealReview :session-signal="sessionSignal" @session-lost="emit('sessionLost', $event)" />
    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="notice" type="success" :closable="false" show-icon />
    <template v-if="queue">
      <p v-if="queue.comments.length === 0" role="status">No comments are waiting for moderation.</p>
      <ol v-else class="moderation-comments">
        <li v-for="item in queue.comments" :key="`${item.articleId}-${item.commentId}`">
          <article>
            <h3>{{ item.displayName }}</h3>
            <p>
              Article {{ item.articleId }} · Comment {{ item.commentId.toString() }}
              · <time :datetime="new Date(item.createdAt).toISOString()">{{ new Date(item.createdAt).toLocaleString() }}</time>
            </p>
            <p class="moderation-body">{{ item.body }}</p>
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
            <ElButton v-else native-type="button" :disabled="busy || Boolean(claim)" @click="claimForReview(item)">Claim comment for review</ElButton>
          </article>
        </li>
      </ol>
      <ElButton v-if="queue.next" native-type="button" :disabled="busy || Boolean(claim)" @click="load(queue.next)">Next page</ElButton>
    </template>
  </section>
</template>

<style scoped>
.admin-moderation { margin-block-start: 1.5rem; }
.moderation-comments { display: grid; gap: 1.5rem; padding-inline-start: 1.5rem; }
.moderation-comments h3, .moderation-body { overflow-wrap: anywhere; }
.moderation-body { white-space: pre-wrap; }
.moderation-claim { display: grid; gap: 0.75rem; }
.moderation-claim p { margin: 0; }
.moderation-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.moderation-actions .moderation-action { margin-inline-start: 0; }
</style>
