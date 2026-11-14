<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { commentEligibility, submitPublicComment } from '../../../Contracts/comment-write'
import type { PublicCommentEligibility } from '../../../Contracts/wire.generated'
import { currentSession, identityEpoch } from '../session'

const props = defineProps<{ articleId: number; publication: bigint }>()
const eligibility = shallowRef<PublicCommentEligibility>()
const body = ref('')
const confirm = ref(false)
const pending = ref(false)
const result = ref('')
const problem = ref('')
const candidate = shallowRef<{ body: string; id: string }>()
const utf8 = new TextEncoder()
const ready = computed(() => confirm.value && body.value.trim().length > 0 && body.value.trim().length <= 1000 &&
  utf8.encode(body.value.trim()).length <= 4096)
let action: AbortController | undefined
onBeforeUnmount(() => action?.abort())

watch([currentSession, identityEpoch, () => props.articleId, () => props.publication], async ([session], _, cleanup) => {
  const controller = new AbortController()
  cleanup(() => controller.abort())
  action?.abort()
  action = undefined
  pending.value = false
  eligibility.value = undefined
  confirm.value = false
  body.value = ''
  candidate.value = undefined
  result.value = ''
  problem.value = ''
  if (!session || session.expiresAt <= Date.now()) return
  try {
    const value = await commentEligibility(props.articleId, props.publication, controller.signal)
    if (!controller.signal.aborted) eligibility.value = value
  } catch {
    // A disabled site or a user without an approved public handle gets the read-only entry.
  }
}, { immediate: true })

async function send() {
  if (!eligibility.value || !ready.value || pending.value || !currentSession.value ||
      currentSession.value.expiresAt <= Date.now()) return
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
      candidate.value.body, candidate.value.id, controller.signal)
    if (controller.signal.aborted || identityEpoch.value !== epoch) return
    candidate.value = undefined
    body.value = ''
    confirm.value = false
    result.value = receipt.moderationStatus === 0 ? 'Comment submitted for review.' : 'Comment submission confirmed.'
  } catch (error) {
    if (!controller.signal.aborted && identityEpoch.value === epoch) {
      problem.value = error instanceof ApiError && (error.status === 401 || error.status === 403)
        ? 'Public comment submission is unavailable. Reload the article to check again.'
        : 'Could not submit the comment. You can retry.'
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
    <h3>Leave a public comment</h3>
    <ElInput v-model="body" type="textarea" label="Comment" v-bind="{ rows: 4, maxlength: 1000 }" :disabled="pending" />
    <ElCheckbox :model-value="confirm" :disabled="pending" @update:model-value="value => confirm = value === true">
      Publish as {{ eligibility.displayName }} after review
    </ElCheckbox>
    <div><ElButton type="primary" native-type="submit" :disabled="!ready" :loading="pending">Submit for review</ElButton></div>
    <p v-if="result" role="status">{{ result }}</p>
    <ElAlert v-if="problem" :title="problem" type="error" :closable="false" />
  </form>
</template>

<style scoped>
.public-comment-composer { display: grid; gap: 0.75rem; margin-block: 1.25rem; }
.public-comment-composer h3 { margin: 0; }
</style>
