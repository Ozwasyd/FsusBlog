<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { commentEligibility, submitPublicComment } from '../../../Contracts/comment-write'
import type { PublicCommentEligibility } from '../../../Contracts/wire.generated'
import { currentSession, identityEpoch } from '../session'

const props = defineProps<{ articleId: number; publication: bigint; reply?: { id: string; name: string } }>()
const emit = defineEmits<{ availability: [value: boolean]; cancel: [] }>()
const eligibility = shallowRef<PublicCommentEligibility & { canReply: boolean }>()
const body = ref('')
const confirm = ref(false)
const pending = ref(false)
const result = ref<MessageKey | ''>('')
const problem = ref<MessageKey | ''>('')
const candidate = shallowRef<{ body: string; id: string }>()
const utf8 = new TextEncoder()
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
    <div>
      <ElButton type="primary" native-type="submit" :disabled="!ready" :loading="pending">{{ t('comment.submit') }}</ElButton>
      <ElButton v-if="reply" native-type="button" @click="emit('cancel')">{{ t('comment.cancelReply') }}</ElButton>
    </div>
    <p v-if="pending" role="status">{{ t('comment.submitting') }}</p>
    <p v-if="result" role="status">{{ t(result) }}</p>
    <ElAlert v-if="problem" :title="t(problem)" type="error" :closable="false" />
  </form>
</template>

<style scoped>
.public-comment-composer { display: grid; gap: 0.75rem; margin-block: 1.25rem; }
.public-comment-composer h3 { margin: 0; }
</style>
