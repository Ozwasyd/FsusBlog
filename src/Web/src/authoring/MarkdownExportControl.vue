<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue'
import { ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { exportArticleRevision, type ArticleExportFormat } from '../../../Contracts/markdown-export'
import { credentialEpoch, currentSession, identityEpoch, recheckCredential } from '../session'

const props = withDefaults(defineProps<{ article: number; revision: bigint; selected: bigint; disabled?: boolean; format?: ArticleExportFormat }>(), {
  format: 'md',
})
const failure = ref('')
const loading = ref(false)
let request: AbortController | undefined

function reset() {
  request?.abort()
  request = undefined
  loading.value = false
  failure.value = ''
}

async function download() {
  const session = currentSession.value
  if (!session?.canAuthor || props.disabled || request) return
  const controller = request = new AbortController()
  const epoch = identityEpoch.value
  const { article, revision, selected, format } = props
  loading.value = true
  failure.value = ''
  try {
    const data = await exportArticleRevision(format, article, revision, selected, controller.signal)
    if (controller.signal.aborted || epoch !== identityEpoch.value || session.expiresAt <= Date.now() ||
        !currentSession.value?.canAuthor || props.disabled || article !== props.article ||
        revision !== props.revision || selected !== props.selected || format !== props.format) return
    const url = URL.createObjectURL(data)
    try {
      const link = document.createElement('a')
      link.href = url
      link.download = `article.${format}`
      link.click()
    } finally {
      // Let the browser begin reading before releasing the attachment URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  } catch (error) {
    if (controller.signal.aborted || epoch !== identityEpoch.value) return
    if (error instanceof ApiError && error.status === 401 && session.siteSessionId)
      await recheckCredential(session.siteSessionId, controller.signal)
    else if (error instanceof ApiError && error.status === 409) failure.value = 'Load the current draft before exporting.'
    else if (error instanceof ApiError && [403, 404].includes(error.status)) failure.value = 'This revision is unavailable.'
    else failure.value = format === 'docx' ? 'Could not download Word. Try again.' : 'Could not download Markdown. Try again.'
  } finally {
    if (request === controller) {
      request = undefined
      loading.value = false
    }
  }
}

watch(() => [props.article, props.revision, props.selected, props.disabled, props.format, credentialEpoch.value], reset, { flush: 'sync' })
onScopeDispose(reset)
</script>

<template>
  <span class="markdown-export">
    <ElButton native-type="button" :loading="loading" :disabled="disabled || loading" @click="download">
      Download {{ selected === revision ? 'saved' : 'revision' }} {{ format === 'docx' ? 'Word' : 'Markdown' }}
    </ElButton>
    <span v-if="failure" class="markdown-export-error" role="alert">{{ failure }}</span>
  </span>
</template>

<style scoped>
.markdown-export { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .45rem; }
.markdown-export-error { font-size: .875rem; }
</style>
