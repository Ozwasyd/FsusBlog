<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElButton, ElCheckbox, ElOption, ElSelect, ElSettingsSection } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { articleMedia, privateArticlePreview, type ArticleAttachment, type AttachmentEdit } from '../../../Contracts/article-media'
import type { PublishImagesSelection } from '../../../Contracts/published-media'
import { credentialEpoch } from '../session'
import { listMedia, type PrivateMediaItem } from '../../../Contracts/private-media'
import MarkdownExportControl from './MarkdownExportControl.vue'

const props = defineProps<{ articleId: number; revision: bigint; credential?: string; canChange: boolean; canPublish: boolean }>()
const emit = defineEmits<{ save: [edit: AttachmentEdit]; publishImages: [selection: PublishImagesSelection] }>()
const available = ref(true)
const expanded = ref(false)
const pending = ref(false)
const error = ref('')
const attached = shallowRef<readonly ArticleAttachment[]>([])
const library = shallowRef<readonly PrivateMediaItem[]>([])
const more = ref(false)
const selected = ref<string>()
const publishEnabled = ref(false)
const publicationSelection = shallowRef<readonly string[]>([])
const confirmation = shallowRef<PublishImagesSelection>()
const confirmationHeading = ref<HTMLElement>()
const reviewButton = ref<InstanceType<typeof ElButton>>()
const preview = shallowRef<{ id: string; path: string }>()
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
    publishEnabled.value = existing.publishImages
    error.value = ''
  } catch { if (current(signal)) error.value = 'Private attachments could not be loaded.' }
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
  } catch { if (current(signal)) error.value = 'The next page of private images could not be loaded.' }
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
    preview.value = { id, path: URL.createObjectURL(bytes) }
    error.value = ''
  } catch { if (current(signal)) error.value = 'Private preview expired. Try again from the current draft.' }
  finally { if (current(signal)) pending.value = false }
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
  selected.value = undefined
  publicationSelection.value = []
  confirmation.value = undefined
  publishEnabled.value = false
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
  <ElSettingsSection title="Private attachments">
    <ElButton native-type="button" :disabled="pending" @click="expanded = !expanded">
      {{ expanded ? 'Hide private attachments' : 'Manage private attachments' }}
    </ElButton>
    <template v-if="expanded">
      <p v-if="!available">The private media library is disabled.</p>
      <template v-else>
        <p v-if="error" role="alert">{{ error }}</p>
        <ul v-if="attached.length" class="attachment-list">
          <li v-for="asset in attached" :key="asset.id">
            <span>{{ label(asset.id) }}</span>
            <ElButton native-type="button" text :disabled="pending" @click="openPreview(asset.id)">Preview {{ label(asset.id) }}</ElButton>
            <ElButton native-type="button" text :disabled="pending || !canChange" @click="emit('save', { assetId: asset.id, attach: false })">Detach {{ label(asset.id) }}</ElButton>
            <ElCheckbox v-if="publishEnabled" :model-value="publicationSelection.includes(asset.id)"
              :disabled="pending || !canPublish || !!confirmation"
              @update:model-value="value => togglePublication(asset.id, value === true)">Publish {{ label(asset.id) }}</ElCheckbox>
          </li>
        </ul>
        <p v-else-if="!pending">No images are attached to this revision.</p>
        <div v-if="publishEnabled && attached.length" class="publication-actions">
          <ElButton v-if="!confirmation" ref="reviewButton" native-type="button"
            :disabled="pending || !canPublish || !publicationSelection.length" @click="reviewPublication">Review image publication</ElButton>
          <section v-else aria-label="Confirm image publication" class="publication-confirmation">
            <h3 ref="confirmationHeading" tabindex="-1">Publish selected images?</h3>
            <p>Anyone can download these images after publication. Withdrawing stops new downloads. Recipients may keep copies they received.</p>
            <ul><li v-for="asset in confirmation.assets" :key="asset">{{ label(asset) }}</li></ul>
            <div class="attachment-actions">
              <ElButton native-type="button" :disabled="pending || !canPublish" @click="publishSelection">Publish article with selected images</ElButton>
              <ElButton native-type="button" @click="cancelPublication">Cancel image publication</ElButton>
            </div>
          </section>
        </div>
        <div v-if="options.length" class="attachment-actions">
          <ElSelect v-model="selected" ariaLabel="Choose a private image" :disabled="pending || !canChange" placeholder="Choose a private image">
            <ElOption v-for="option in options" :key="option.id" :value="option.id" :label="option.name" />
          </ElSelect>
          <ElButton v-if="selected" native-type="button" :disabled="pending || !canChange" @click="emit('save', { assetId: selected, attach: true })">Attach image</ElButton>
        </div>
        <ElButton v-if="more" native-type="button" text :disabled="pending" @click="loadMore">Load more images</ElButton>
        <p><RouterLink to="/user/manage/assets">Open asset library</RouterLink></p>
        <div v-if="preview" class="attachment-preview">
          <ElButton native-type="button" text @click="closePreview">Close image preview</ElButton>
          <img :src="preview.path" :alt="label(preview.id)" @error="error = 'Private preview expired. Try opening it again.'" />
          <MarkdownExportControl :article="articleId" :revision="revision" :selected="revision" format="html"
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
