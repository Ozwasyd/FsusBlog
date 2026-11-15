<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue'
import { ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { exportArticleRevision, type ArticleExportFormat } from '../../../Contracts/markdown-export'
import { credentialEpoch, currentSession, identityEpoch, recheckCredential } from '../session'

const props = withDefaults(defineProps<{ article: number; revision: bigint; selected: bigint; disabled?: boolean; format?: ArticleExportFormat; attachment?: string }>(), {
  format: 'md',
})
const failure = ref('')
const loading = ref(false)
const formatLabels: Record<ArticleExportFormat, string> = { md: 'Markdown', docx: 'Word', html: 'HTML', epub: 'EPUB', pdf: 'PDF' }
const pdfAvailable = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-pdf-export"]')?.content === '1'
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
  const { article, revision, selected, format, attachment } = props
  const image = attachment && session.siteSessionId ? { id: attachment, credential: session.siteSessionId } : undefined
  if (attachment && !image) return
  const controller = request = new AbortController()
  const epoch = identityEpoch.value
  loading.value = true
  failure.value = ''
  try {
    const data = await exportArticleRevision(format, article, revision, selected, controller.signal, image)
    if (controller.signal.aborted || epoch !== identityEpoch.value || session.expiresAt <= Date.now() ||
        !currentSession.value?.canAuthor || props.disabled || article !== props.article ||
        revision !== props.revision || selected !== props.selected || format !== props.format || attachment !== props.attachment) return
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
    else if (format === 'html' && attachment && error instanceof ApiError && error.status === 400)
      failure.value = 'Use basic text Markdown and an image up to 512 KiB. The combined HTML must fit within 2 MiB.'
    else if (format === 'html' && error instanceof ApiError && error.status === 400)
      failure.value = 'Offline HTML requires basic text Markdown without links, images, or render directives, and must fit within 2 MiB.'
    else if (format === 'epub' && error instanceof ApiError && error.status === 400)
      failure.value = 'EPUB requires a title and basic text Markdown without links, images, or render directives. It must fit within 2 MiB.'
    else if (format === 'pdf' && error instanceof ApiError && error.status === 400)
      failure.value = 'PDF requires basic text Markdown and supported characters within the page and size limits.'
    else failure.value = `Could not download ${formatLabels[format]}. Try again.`
  } finally {
    if (request === controller) {
      request = undefined
      loading.value = false
    }
  }
}

watch(() => [props.article, props.revision, props.selected, props.disabled, props.format, props.attachment, credentialEpoch.value], reset, { flush: 'sync' })
onScopeDispose(reset)
</script>

<template>
  <span v-if="format !== 'pdf' || pdfAvailable" class="markdown-export">
    <ElButton native-type="button" :loading="loading" :disabled="disabled || loading" @click="download">
      Download {{ selected === revision ? 'saved' : 'revision' }} {{ formatLabels[format] }}{{ attachment ? ' with this image' : '' }}
    </ElButton>
    <span v-if="failure" class="markdown-export-error" role="alert">{{ failure }}</span>
  </span>
</template>

<style scoped>
.markdown-export { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .45rem; }
.markdown-export-error { font-size: .875rem; }
</style>
