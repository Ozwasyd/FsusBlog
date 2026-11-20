<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, ref, shallowReactive, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElButton, ElCheckbox, ElOption, ElSelect, ElSettingsSection } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { articleMedia, privateArticlePreview, type ArticleAttachment, type AttachmentEdit } from '../../../Contracts/article-media'
import type { PublishImagesSelection } from '../../../Contracts/published-media'
import { credentialEpoch } from '../authorSession'
import { createDocumentExportTask } from '../../../Contracts/document-export-tasks'
import { listMedia, type PrivateMediaItem } from '../../../Contracts/private-media'
import { maxDocumentExportImages } from '../../../Contracts/markdown-export'
import MarkdownExportControl from './MarkdownExportControl.vue'

const props = defineProps<{ articleId: number; revision: bigint; credential?: string; canChange: boolean; canPublish: boolean }>()
const emit = defineEmits<{ save: [edit: AttachmentEdit]; publishImages: [selection: PublishImagesSelection] }>()
const available = ref(true)
const expanded = ref(false)
const pending = ref(false)
const error = ref('')
const cover = ref<string | null>();
const attached = shallowRef<readonly ArticleAttachment[]>([])
const library = shallowRef<readonly PrivateMediaItem[]>([])
const more = ref(false)
const selected = ref<string>()
const publishEnabled = ref(false)
const publishCoverEnabled = ref(false)
const publicationSelection = shallowRef<readonly string[]>([])
const confirmation = shallowRef<PublishImagesSelection>()
const confirmationHeading = ref<HTMLElement>()
const reviewButton = ref<InstanceType<typeof ElButton>>()
const preview = shallowRef<{ id: string; path: string; type: string }>()
const batchFormats = { html: 'HTML', epub: 'EPUB', docx: 'Word', pdf: 'PDF' } as const
const pdfAvailable = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-pdf-export"]')?.content === '1'
type BatchFormat = keyof typeof batchFormats
const imageExports = shallowReactive(new Map<string, { id: string; queued?: boolean }>())
const exportSelection = shallowRef<readonly string[]>([])
const documentTasks = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-document-export-tasks"]')?.content === '1'
const savedImages = computed(() => attached.value.filter(asset => exportSelection.value.includes(asset.id)).map(asset => asset.id).join(','))
const exportKey = (format: BatchFormat, images: string) => `${format}:${images}`
const queued = (format: BatchFormat, images: string) => imageExports.get(exportKey(format, images))?.queued
const options = computed(() => library.value.filter(asset => !attached.value.some(entry => entry.id === asset.id)))
let task = new AbortController()

function current(signal: AbortSignal) { return task.signal === signal && !signal.aborted }
function label(id: string) { return library.value.find(asset => asset.id === id)?.name ?? id }

async function load() {
  const signal = task.signal
  const credential = props.credential
  if (!credential) return
  pending.value = true
  try {
    // A single disabled library response distinguishes configuration from draft concurrency errors.
    const page = await listMedia(undefined, signal, credential).catch(error => {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    })
    if (!current(signal)) return
    if (!page) { available.value = false; return }
    const existing = await articleMedia(props.articleId, props.revision, credential, signal)
    if (!current(signal)) return
    library.value = page.items
    more.value = page.hasMore
    attached.value = existing.entries
    cover.value = existing.cover
    if (existing.entries.length <= maxDocumentExportImages) exportSelection.value = existing.entries.map(asset => asset.id)
    publishEnabled.value = existing.publishImages
    publishCoverEnabled.value = existing.publishCover
    error.value = ''
  } catch { if (current(signal)) error.value = t('author.articleMedia.private.attachments.could.not.be.loaded') }
  finally { if (current(signal)) pending.value = false }
}

async function loadMore() {
  const signal = task.signal
  const credential = props.credential
  if (!credential || !more.value || pending.value) return
  pending.value = true
  try {
    const page = await listMedia(library.value.at(-1), signal, credential)
    if (!current(signal)) return
    const known = new Set(library.value.map(item => item.id))
    library.value = [...library.value, ...page.items.filter(item => !known.has(item.id))]
    more.value = page.hasMore
    error.value = ''
  } catch { if (current(signal)) error.value = t('author.articleMedia.the.next.page.of.private.images.could.not.be') }
  finally { if (current(signal)) pending.value = false }
}

async function openPreview(id: string) {
  const signal = task.signal
  const credential = props.credential
  if (!credential || pending.value) return
  pending.value = true
  try {
    const state = await articleMedia(props.articleId, props.revision, credential, signal)
    const pair = state.entries.find(entry => entry.id === id)
    if (!current(signal)) return
    if (!pair) throw new Error('Missing attachment')
    const bytes = await privateArticlePreview(pair.ticket, signal)
    if (!current(signal)) return
    closePreview()
    preview.value = { id, path: URL.createObjectURL(bytes), type: bytes.type }
    error.value = ''
  } catch { if (current(signal)) error.value = t('author.articleMedia.private.preview.expired.try.again.from.the.current.draft') }
  finally { if (current(signal)) pending.value = false }
}

async function queueDocument(format: BatchFormat, images: string) {
  const { articleId: article, revision, credential } = props
  if (!images || !credential || pending.value || queued(format, images)) return
  const signal = task.signal
  const key = exportKey(format, images)
  const id = imageExports.get(key)?.id ?? crypto.randomUUID()
  imageExports.set(key, { id })
  pending.value = true
  error.value = ''
  try {
    await createDocumentExportTask({ id, article, revision, sourceRevision: revision, format }, credential, signal, images)
    if (current(signal)) imageExports.set(key, { id, queued: true })
  } catch { if (current(signal)) error.value = t('author.articleMedia.queue.failed', { format: batchFormats[format] }) }
  finally { if (current(signal)) pending.value = false }
}

function toggleExport(id: string, checked: boolean) {
  if (pending.value || !props.credential) return
  const next = new Set(exportSelection.value)
  if (checked && next.size < maxDocumentExportImages) next.add(id)
  if (!checked) next.delete(id)
  exportSelection.value = [...next]
}

function togglePublication(id: string, checked: boolean) {
  if (!publishEnabled.value || !props.canPublish || pending.value || confirmation.value) return
  const next = new Set(publicationSelection.value)
  if (checked) next.add(id)
  else next.delete(id)
  publicationSelection.value = [...next]
}

async function reviewPublication() {
  const { articleId, revision, credential, canPublish } = props
  if (!credential || !publishEnabled.value || !canPublish || pending.value || !publicationSelection.value.length) return
  confirmation.value = { articleId, revision, credential, assets: publicationSelection.value.slice() }
  await nextTick()
  confirmationHeading.value?.focus()
}

async function cancelPublication() {
  confirmation.value = undefined
  await nextTick()
  reviewButton.value?.ref?.focus()
}

function publishSelection() {
  const selection = confirmation.value
  if (!selection || !publishEnabled.value || !props.canPublish || pending.value) return
  confirmation.value = undefined
  publicationSelection.value = []
  emit('publishImages', selection)
}

function closePreview() {
  if (preview.value) URL.revokeObjectURL(preview.value.path)
  preview.value = undefined
}

watch([() => props.articleId, () => props.revision, () => props.credential, credentialEpoch, expanded], () => {
  task.abort()
  task = new AbortController()
  attached.value = []
  cover.value = undefined
  imageExports.clear()
  exportSelection.value = []
  selected.value = undefined
  publicationSelection.value = []
  confirmation.value = undefined
  publishEnabled.value = false
  publishCoverEnabled.value = false
  closePreview()
  library.value = []
  pending.value = false
  error.value = ''
  available.value = true
  if (expanded.value) void load()
}, { flush: 'sync' })
watch(() => props.canPublish, enabled => { if (!enabled) confirmation.value = undefined }, { flush: 'sync' })
onBeforeUnmount(() => {
  task.abort()
  closePreview()
})
</script>

<template>
  <ElSettingsSection :title="t('author.articleMedia.private.attachments')">
    <ElButton native-type="button" :disabled="pending" @click="expanded = !expanded">
      {{ expanded ? t('author.articleMedia.hide.private.attachments') : t('author.articleMedia.manage.private.attachments') }}
    </ElButton>
    <template v-if="expanded">
      <p v-if="!available">{{ t('author.articleMedia.the.private.media.library.is.disabled') }}</p>
      <template v-else>
        <p v-if="error" role="alert">{{ error }}</p>
        <ul v-if="attached.length" class="attachment-list">
          <li v-for="asset in attached" :key="asset.id">
            <span>{{ label(asset.id) }}</span>
            <span v-if="cover === asset.id">{{ t('author.articleMedia.draft.cover') }}</span>
            <ElButton v-if="cover !== undefined" native-type="button" text :disabled="pending || !canChange"
              @click="emit('save', { cover: cover === asset.id ? null : asset.id })">
              {{ cover === asset.id ? t('author.articleMedia.remove.draft.cover') : t('author.articleMedia.use.cover', { name: label(asset.id) }) }}
            </ElButton>
            <ElButton native-type="button" text :disabled="pending" @click="openPreview(asset.id)">{{ t('author.articleMedia.preview', { p0: String(label(asset.id)) }) }}</ElButton>
            <ElButton native-type="button" text :disabled="pending || !canChange" @click="emit('save', { assetId: asset.id, attach: false })">{{ t('author.articleMedia.detach', { p0: String(label(asset.id)) }) }}</ElButton>
            <ElCheckbox v-if="attached.length > 1" :model-value="exportSelection.includes(asset.id)"
              :disabled="pending || !credential || (exportSelection.length >= maxDocumentExportImages && !exportSelection.includes(asset.id))"
              @update:model-value="value => toggleExport(asset.id, value === true)">{{ t('author.articleMedia.include.in.exports', { p0: String(label(asset.id)) }) }}</ElCheckbox>
            <ElCheckbox v-if="publishEnabled" :model-value="publicationSelection.includes(asset.id)"
              :disabled="pending || !canPublish || !!confirmation"
              @update:model-value="value => togglePublication(asset.id, value === true)">{{ t('author.articleMedia.publish', { p0: String(label(asset.id)) }) }}</ElCheckbox>
          </li>
        </ul>
        <p v-else-if="!pending">{{ t('author.articleMedia.no.images.are.attached.to.this.revision') }}</p>
        <p v-if="attached.length > maxDocumentExportImages">{{ t('author.articleMedia.select.up.to.saved.images.for.export', { p0: String(maxDocumentExportImages) }) }}</p>
        <div v-if="savedImages && (attached.length > 1 || pdfAvailable)" class="attachment-actions" role="region" :aria-label="t('author.articleMedia.export.selected.images')">
          <template v-for="(label, format) in batchFormats" :key="format">
            <template v-if="format === 'pdf' ? pdfAvailable : attached.length > 1">
              <MarkdownExportControl :article="articleId" :revision="revision" :selected="revision" :format="format"
                :attachment="savedImages" :disabled="pending || !credential" />
              <ElButton v-if="documentTasks" native-type="button"
                :disabled="pending || !credential || queued(format, savedImages)" @click="queueDocument(format, savedImages)">
                {{ queued(format, savedImages) ? t('author.articleMedia.saved.images.added', { format: label }) : t('author.articleMedia.queue.saved.images', { format: label }) }}
              </ElButton>
            </template>
          </template>
        </div>
        <div v-if="publishEnabled && attached.length" class="publication-actions">
          <ElButton v-if="!confirmation" ref="reviewButton" native-type="button"
            :disabled="pending || !canPublish || !publicationSelection.length" @click="reviewPublication">{{ t('author.articleMedia.review.image.publication') }}</ElButton>
          <section v-else :aria-label="t('author.articleMedia.confirm.image.publication')" class="publication-confirmation">
            <h3 ref="confirmationHeading" tabindex="-1">{{ t('author.articleMedia.publish.selected.images') }}</h3>
            <p>{{ t('author.articleMedia.anyone.can.download.these.images.after.publication.withdrawing') }}</p>
            <ul>
              <li v-for="asset in confirmation.assets" :key="asset">
                {{ label(asset) }}<span v-if="publishCoverEnabled && asset === cover"> {{ t('author.articleMedia.article.cover') }}</span>
              </li>
            </ul>
            <div class="attachment-actions">
              <ElButton native-type="button" :disabled="pending || !canPublish" @click="publishSelection">{{ t('author.articleMedia.publish.article.with.selected.images') }}</ElButton>
              <ElButton native-type="button" @click="cancelPublication">{{ t('author.articleMedia.cancel.image.publication') }}</ElButton>
            </div>
          </section>
        </div>
        <div v-if="options.length" class="attachment-actions">
          <ElSelect v-model="selected" :ariaLabel="t('author.articleMedia.choose.a.private.image')" :disabled="pending || !canChange" :placeholder="t('author.articleMedia.choose.a.private.image')">
            <ElOption v-for="option in options" :key="option.id" :value="option.id" :label="option.name" />
          </ElSelect>
          <ElButton v-if="selected" native-type="button" :disabled="pending || !canChange" @click="emit('save', { assetId: selected, attach: true })">{{ t('author.articleMedia.attach.image') }}</ElButton>
        </div>
        <ElButton v-if="more" native-type="button" text :disabled="pending" @click="loadMore">{{ t('author.articleMedia.load.more.images') }}</ElButton>
        <p><RouterLink to="/admin/assets">{{ t('author.articleMedia.open.asset.library') }}</RouterLink></p>
        <div v-if="preview" class="attachment-preview">
          <ElButton native-type="button" text @click="closePreview">{{ t('author.articleMedia.close.image.preview') }}</ElButton>
          <img :src="preview.path" :alt="label(preview.id)" @error="error = t('author.articleMedia.preview.expired.again')" />
          <MarkdownExportControl :article="articleId" :revision="revision" :selected="revision" format="html"
            :attachment="preview.id" :disabled="pending || !credential" />
          <ElButton v-if="documentTasks" native-type="button" :disabled="pending || !credential || queued('html', preview.id)" @click="queueDocument('html', preview.id)">
            {{ queued('html', preview.id) ? t('author.articleMedia.html.task.added') : t('author.articleMedia.queue.html.with.this.image') }}
          </ElButton>
          <MarkdownExportControl :article="articleId" :revision="revision" :selected="revision" format="epub"
            :attachment="preview.id" :disabled="pending || !credential" />
          <MarkdownExportControl v-if="preview.type === 'image/png' || preview.type === 'image/jpeg'"
            :article="articleId" :revision="revision" :selected="revision" format="docx"
            :attachment="preview.id" :disabled="pending || !credential" />
        </div>
      </template>
    </template>
  </ElSettingsSection>
</template>

<style scoped>
.attachment-list { padding: 0; list-style: none; }
.attachment-list li, .attachment-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; overflow-wrap: anywhere; }
.attachment-list :deep(.el-checkbox) { max-inline-size: 100%; height: auto; }
.attachment-list :deep(.el-checkbox__label) { white-space: normal; overflow-wrap: anywhere; }
.attachment-actions > *:first-child { min-width: min(14rem, 100%); }
.attachment-preview { display: grid; justify-items: start; gap: .5rem; }
.attachment-preview img { max-width: 100%; max-height: 45vh; object-fit: contain; }
.publication-actions { margin-block: .75rem; }
.publication-confirmation { overflow-wrap: anywhere; }
.publication-confirmation .attachment-actions > * { min-width: 0; margin: 0; }
</style>
