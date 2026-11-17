<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElDialog, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { commentReportReasons, reportComment, type CommentReportReason } from '../../../Contracts/comment-reports'
import { WireLimits } from '../../../Contracts/wire.generated'
import { currentSession, identityEpoch } from '../session'

const props = defineProps<{ articleId: number; commentId?: string }>()
const emit = defineEmits<{ close: [] }>()
const reasonLabels: Record<CommentReportReason, MessageKey> = {
  spam: 'comment.reason.spam', harassment: 'comment.reason.harassment', hate: 'comment.reason.hate', privacy: 'comment.reason.privacy',
  illegal: 'comment.reason.illegal', misinformation: 'comment.reason.misinformation', other: 'comment.reason.other',
}
const reason = ref<CommentReportReason>()
const detail = ref('')
const pending = ref(false)
const error = ref<MessageKey | ''>('')
const receipt = shallowRef<Awaited<ReturnType<typeof reportComment>>>()
let request: AbortController | undefined

function reset() {
  request?.abort()
  request = undefined
  reason.value = undefined
  detail.value = ''
  pending.value = false
  error.value = ''
  receipt.value = undefined
}

function close() {
  reset()
  emit('close')
}

function dismiss(done: () => void) {
  close()
  done()
}

watch([() => props.articleId, () => props.commentId], reset, { flush: 'sync' })
watch([identityEpoch, () => currentSession.value?.siteSessionId], close, { flush: 'sync' })
onBeforeUnmount(reset)

async function send() {
  const target = props.commentId
  const category = reason.value
  const session = currentSession.value
  if (!target || !category || !session?.siteSessionId || session.expiresAt <= Date.now() || pending.value || receipt.value) return
  const controller = new AbortController()
  const epoch = identityEpoch.value
  request = controller
  pending.value = true
  error.value = ''
  try {
    const result = await reportComment(props.articleId, target, category, detail.value, session.siteSessionId, controller.signal)
    if (!controller.signal.aborted && epoch === identityEpoch.value && session.siteSessionId === currentSession.value?.siteSessionId)
      receipt.value = result
  } catch (failure) {
    if (!controller.signal.aborted && epoch === identityEpoch.value && session.siteSessionId === currentSession.value?.siteSessionId)
      error.value = failure instanceof ApiError && failure.status === 404
        ? 'comment.reportUnavailable' : 'comment.reportUnconfirmed'
  } finally {
    if (request === controller) {
      request = undefined
      pending.value = false
    }
  }
}
</script>

<template>
  <ElDialog :model-value="!!commentId" :title="t('comment.reportTitle')" append-to-body destroy-on-close
    :close-on-click-modal="false" :before-close="dismiss" width="min(calc(100vw - 2rem), 30rem)">
    <p v-if="receipt" role="status">
      {{ receipt.duplicate ? t('comment.reportDuplicate') : t('comment.reportSaved') }}
      {{ t('comment.reportId', { id: String(receipt.id) }) }}
    </p>
    <div v-else class="comment-report-fields">
      <ElSelect v-model="reason" :ariaLabel="t('comment.reportReason')" :placeholder="t('comment.chooseReason')" :disabled="pending">
        <ElOption v-for="choice in commentReportReasons" :key="choice" :label="t(reasonLabels[choice])" :value="choice" />
      </ElSelect>
      <ElInput v-model="detail" type="textarea" :label="t('comment.reportDetails')" v-bind="{ rows: 4, maxlength: WireLimits.CommentReportDetailChars }"
        :disabled="pending" />
      <ElAlert v-if="error" :title="t(error)" type="error" :closable="false" />
    </div>
    <template #footer>
      <ElButton native-type="button" @click="close">{{ receipt ? t('comment.close') : t('comment.cancel') }}</ElButton>
      <ElButton v-if="!receipt" native-type="button" type="primary" :disabled="!reason || pending" :loading="pending" @click="send">
        {{ t('comment.sendReport') }}
      </ElButton>
    </template>
  </ElDialog>
</template>

<style scoped>
.comment-report-fields { display: grid; gap: var(--fsus-space-3); }
</style>
