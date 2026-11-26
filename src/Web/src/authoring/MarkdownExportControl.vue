<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { onScopeDispose, ref, watch } from 'vue'
import { ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { exportArticleRevision, type ArticleExportFormat } from '../../../Contracts/markdown-export'
import { credentialEpoch, currentSession, identityEpoch, recheckCredential } from '../authorSession'
import { downloadExport, exportFormatLabels } from './articleExport'

const props = withDefaults(defineProps<{
  article: number
  revision: bigint
  selected: bigint
  disabled?: boolean
  format?: ArticleExportFormat
  attachment?: string
  size?: 'default' | 'small'
  block?: boolean
}>(), {
  format: 'md',
  size: 'default',
  block: false,
})
const failure = ref('')
const loading = ref(false)
const invalidInput: Partial<Record<ArticleExportFormat, MessageKey>> = {
  html: 'author.markdownExportControl.offline.html.requires.basic.text.markdown.without.links.images',
  epub: 'author.markdownExportControl.epub.requires.a.title.and.basic.text.markdown.without',
  pdf: 'author.markdownExportControl.pdf.requires.basic.text.markdown.and.supported.characters.within',
}
const invalidAttachment: Partial<Record<ArticleExportFormat, MessageKey>> = {
  html: 'author.markdownExportControl.use.basic.text.markdown.and.images.totaling.up.to',
  epub: 'author.markdownExportControl.use.a.title.basic.text.markdown.and.images.totaling',
  docx: 'author.markdownExportControl.use.png.or.jpeg.images.totaling.up.to.512',
  pdf: 'author.markdownExportControl.use.supported.text.and.saved.images.totaling.up.to',
}
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
    downloadExport(data, `article.${format}`)
  } catch (error) {
    if (controller.signal.aborted || epoch !== identityEpoch.value) return
    if (error instanceof ApiError && error.status === 401 && session.siteSessionId)
      await recheckCredential(session.siteSessionId, controller.signal)
    else if (error instanceof ApiError && error.status === 409) failure.value = t('author.markdownExportControl.load.the.current.draft.before.exporting')
    else if (error instanceof ApiError && [403, 404].includes(error.status)) failure.value = t('author.markdownExportControl.this.revision.is.unavailable')
    else {
      const key = error instanceof ApiError && error.status === 400
        ? (attachment ? invalidAttachment : invalidInput)[format] : undefined
      failure.value = key ? t(key) : t('author.markdownExportControl.download.failed', { format: exportFormatLabels[format] })
    }
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
  <span v-if="format !== 'pdf' || pdfAvailable" class="markdown-export" :class="{ 'markdown-export--block': block }">
    <ElButton class="markdown-export-button" native-type="button" :size="size" :loading="loading" :disabled="disabled || loading" @click="download">
      {{ t('author.markdownExportControl.download', {
        p0: t(selected === revision ? 'author.markdownExportControl.scopeSaved' : 'author.markdownExportControl.scopeRevision'),
        p1: exportFormatLabels[format],
        p2: attachment?.includes(',')
          ? t('author.markdownExportControl.withImages')
          : attachment
            ? t('author.markdownExportControl.withImage')
            : '',
      }) }}
    </ElButton>
    <span v-if="failure" class="markdown-export-error" role="alert">{{ failure }}</span>
  </span>
</template>

<style scoped>
.markdown-export { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .45rem; }
.markdown-export--block { display: grid; min-inline-size: 0; }
.markdown-export--block .markdown-export-button { inline-size: 100%; margin: 0; }
.markdown-export-error { font-size: .875rem; color: var(--el-color-danger); }
</style>
