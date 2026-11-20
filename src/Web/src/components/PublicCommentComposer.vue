<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { commentEligibility, submitPublicComment } from '../../../Contracts/comment-write'
import { passkeyAvailable } from '../../../Contracts/passkey'
import type { PublicCommentEligibility } from '../../../Contracts/wire.generated'
import { currentSession, identityEpoch } from '../session'

const props = defineProps<{ articleId: number; publication: bigint; writeEnabled?: boolean; reply?: { id: string; name: string } }>()
const emit = defineEmits<{ availability: [value: boolean]; cancel: [] }>()
const route = useRoute()
const eligibility = shallowRef<PublicCommentEligibility & { canReply: boolean }>()
const body = ref('')
const confirm = ref(false)
const pending = ref(false)
const result = ref<MessageKey | ''>('')
const problem = ref<MessageKey | ''>('')
const candidate = shallowRef<{ body: string; id: string }>()
const canSignIn = ref(false)
const utf8 = new TextEncoder()
const hasReaderSession = computed(() => Boolean(currentSession.value && currentSession.value.expiresAt > Date.now()))
const showSignIn = computed(() => Boolean(props.writeEnabled) && !hasReaderSession.value && canSignIn.value)
const signInLocation = computed(() => ({ name: 'login', query: { redirect: `${route.path}#article-comments-title` } }))
const ready = computed(() => confirm.value && body.value.trim().length > 0 && body.value.trim().length <= 1000 &&
  utf8.encode(body.value.trim()).length <= 4096)
let action: AbortController | undefined
onBeforeUnmount(() => action?.abort())

function resetDraft() {
  action?.abort()
  action = undefined
  pending.value = false
  confirm.value = false
  body.value = ''
  candidate.value = undefined
  result.value = ''
  problem.value = ''
}

watch(() => props.reply?.id, resetDraft, { flush: 'sync' })
watch([() => props.writeEnabled, hasReaderSession], async ([open, signedIn], _, cleanup) => {
  canSignIn.value = false
  if (!open || signedIn) return
  const controller = new AbortController()
  cleanup(() => controller.abort())
  try {
    const available = await passkeyAvailable(controller.signal)
    if (!controller.signal.aborted) canSignIn.value = available
  } catch {
    if (!controller.signal.aborted) canSignIn.value = false
  }
}, { immediate: true })
watch([currentSession, identityEpoch, () => props.articleId, () => props.publication], async ([session], _, cleanup) => {
  const controller = new AbortController()
  cleanup(() => controller.abort())
  resetDraft()
  eligibility.value = undefined
  emit('availability', false)
  if (!session || session.expiresAt <= Date.now()) return
  try {
    const value = await commentEligibility(props.articleId, props.publication, controller.signal)
    if (!controller.signal.aborted) {
      eligibility.value = value
      emit('availability', value.canReply && !!session.siteSessionId)
    }
  } catch {
    // A disabled site or a user without an approved public handle gets the read-only entry.
  }
}, { immediate: true, flush: 'sync' })

async function send() {
  const session = currentSession.value
  const target = props.reply
  if (!eligibility.value || !ready.value || pending.value || !session || session.expiresAt <= Date.now()) return
  const reply = target && session.siteSessionId && eligibility.value.canReply
    ? { parent: target.id, session: session.siteSessionId } : undefined
  if (target && !reply) return
  const text = body.value.trim().replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (candidate.value?.body !== text) candidate.value = { body: text, id: crypto.randomUUID() }
  const controller = new AbortController()
  action = controller
  pending.value = true
  problem.value = ''
  result.value = ''
  const epoch = identityEpoch.value
  try {
    const receipt = await submitPublicComment(props.articleId, props.publication, eligibility.value.displayName,
      candidate.value.body, candidate.value.id, controller.signal, reply)
    if (controller.signal.aborted || identityEpoch.value !== epoch) return
    candidate.value = undefined
    body.value = ''
    confirm.value = false
    result.value = receipt.moderationStatus === 0
      ? target ? 'comment.replySubmitted' : 'comment.submitted'
      : 'comment.confirmed'
  } catch (error) {
    if (!controller.signal.aborted && identityEpoch.value === epoch) {
      problem.value = error instanceof ApiError && (error.status === 401 || error.status === 403)
        ? 'comment.submitUnavailable'
        : 'comment.submitFailed'
    }
  } finally {
    if (action === controller) {
      action = undefined
      pending.value = false
    }
  }
}
</script>

<template>
  <form v-if="eligibility" class="public-comment-composer" @submit.prevent="send">
    <h3>{{ reply ? t('comment.replyTo', { name: reply.name }) : t('comment.leave') }}</h3>
    <ElInput v-model="body" type="textarea" :label="reply ? t('comment.reply') : t('comment.bodyLabel')" v-bind="{ rows: 4, maxlength: 1000 }" :disabled="pending" />
    <ElCheckbox :model-value="confirm" :disabled="pending" @update:model-value="value => confirm = value === true">
      {{ t('comment.publishAs', { name: eligibility.displayName }) }}
    </ElCheckbox>
    <div class="public-comment-composer-actions">
      <ElButton class="public-comment-btn" type="primary" native-type="submit" :disabled="!ready" :loading="pending">{{ t('comment.submit') }}</ElButton>
      <ElButton v-if="reply" class="public-comment-btn" native-type="button" @click="emit('cancel')">{{ t('comment.cancelReply') }}</ElButton>
    </div>
    <p v-if="pending" class="public-comment-status" role="status">{{ t('comment.submitting') }}</p>
    <p v-if="result" class="public-comment-status" role="status">{{ t(result) }}</p>
    <ElAlert v-if="problem" :title="t(problem)" type="error" :closable="false" />
  </form>
  <p v-else-if="showSignIn" class="public-comment-sign-in">
    <span class="muted">{{ t('comment.signInPrompt') }}</span>
    <RouterLink class="public-comment-sign-in-link" :to="signInLocation">{{ t('comment.signInAction') }}</RouterLink>
  </p>
</template>

<style scoped>
.public-comment-composer { display: grid; gap: .875rem; margin-block: 1.5rem 0; }
.public-comment-composer h3 { margin: 0; color: var(--fsus-ink); font-size: .9375rem; font-weight: 700; }
.public-comment-composer-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
.public-comment-btn + .public-comment-btn { margin-inline-start: 0; }
.public-comment-status { margin: 0; color: var(--fsus-color-text-quiet); font-size: .875rem; }
.public-comment-sign-in {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: .25rem .75rem;
  margin-block: 1rem 0;
  font-size: .875rem;
}
.public-comment-sign-in-link {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  color: var(--fsus-scholarly-blue);
  font-weight: 500;
  text-decoration: none;
}
.public-comment-sign-in-link:hover,
.public-comment-sign-in-link:focus-visible {
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: .25em;
}
</style>
