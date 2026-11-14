<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElButton, ElOption, ElSelect, ElSettingsSection } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { articleMedia, privateArticlePreview, type ArticleAttachment, type AttachmentEdit } from '../../../Contracts/article-media'
import { listMedia, type PrivateMediaItem } from '../../../Contracts/private-media'

const props = defineProps<{ articleId: number; revision: bigint; identity: number; canChange: boolean }>()
const emit = defineEmits<{ save: [edit: AttachmentEdit] }>()
const available = ref(true)
const expanded = ref(false)
const pending = ref(false)
const error = ref('')
const attached = shallowRef<readonly ArticleAttachment[]>([])
const library = shallowRef<readonly PrivateMediaItem[]>([])
const more = ref(false)
const selected = ref<string>()
const preview = shallowRef<{ id: string; path: string }>()
const options = computed(() => library.value.filter(asset => !attached.value.some(entry => entry.id === asset.id)))
let task = new AbortController()

function current(signal: AbortSignal) { return task.signal === signal && !signal.aborted }
function label(id: string) { return library.value.find(asset => asset.id === id)?.name ?? id }

async function load() {
  const signal = task.signal
  pending.value = true
  try {
    // A single disabled library response distinguishes configuration from draft concurrency errors.
    const page = await listMedia(undefined, signal).catch(error => {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    })
    if (!current(signal)) return
    if (!page) { available.value = false; return }
    const existing = await articleMedia(props.articleId, props.revision, signal)
    if (!current(signal)) return
    library.value = page.items
    more.value = page.hasMore
    attached.value = existing
    error.value = ''
  } catch { if (current(signal)) error.value = 'Private attachments could not be loaded.' }
  finally { if (current(signal)) pending.value = false }
}

async function loadMore() {
  const signal = task.signal
  if (!more.value || pending.value) return
  pending.value = true
  try {
    const page = await listMedia(library.value.at(-1), signal)
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
  if (pending.value) return
  pending.value = true
  try {
    const pair = (await articleMedia(props.articleId, props.revision, signal)).find(entry => entry.id === id)
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

function closePreview() {
  if (preview.value) URL.revokeObjectURL(preview.value.path)
  preview.value = undefined
}

watch([() => props.articleId, () => props.revision, () => props.identity, expanded], () => {
  task.abort()
  task = new AbortController()
  attached.value = []
  selected.value = undefined
  closePreview()
  library.value = []
  pending.value = false
  error.value = ''
  available.value = true
  if (expanded.value) void load()
}, { flush: 'sync' })
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
          </li>
        </ul>
        <p v-else-if="!pending">No images are attached to this revision.</p>
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
        </div>
      </template>
    </template>
  </ElSettingsSection>
</template>

<style scoped>
.attachment-list { padding: 0; list-style: none; }
.attachment-list li, .attachment-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; overflow-wrap: anywhere; }
.attachment-actions > *:first-child { min-width: min(14rem, 100%); }
.attachment-preview { display: grid; justify-items: start; gap: .5rem; }
.attachment-preview img { max-width: 100%; max-height: 45vh; object-fit: contain; }
</style>
