<script setup lang="ts">
import { t, siteLocale, type MessageKey } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton, ElEmptyState, ElMessageBox, ElProgress, ElSettingsSection, ElSkeleton, ElTaskPageHeader } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { cancelMediaUpload, finalizeMediaUpload, listMedia, mediaDate, mediaDigest, privateMediaHref, removeMedia,
  sendMediaPart, startMediaUpload, uploadMedia, type MediaUploadState, type PrivateMediaItem } from '../../../Contracts/private-media'
import { forgetMediaRecovery, mediaRecovery } from '../mediaUploadRecovery'
import { currentSession, identityEpoch, invalidateSession, refreshSession } from '../authorSession'
import { consumeAuthoringSessionPreload, readInitialPrivateMediaPage } from '../workspacePreload'

const route = useRoute()
const entries = shallowRef<readonly PrivateMediaItem[]>([])
const selected = shallowRef<{ file: File; key: string; digest?: string; coordinate?: string }>()
const uploadState = shallowRef<MediaUploadState>()
const preview = shallowRef<PrivateMediaItem>()
const error = ref('')
const feedback = ref('')
const available = ref(true)
const resumable = ref(false)
const webp = ref(false)
const hasMore = ref(false)
const working = ref(false)
const loading = ref(false)
const heading = ref<HTMLElement>()
const previewHeading = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const date = computed(() => new Intl.DateTimeFormat(siteLocale.value, { dateStyle: 'medium', timeStyle: 'short' }))
let scope = new AbortController()
let previewOpener: HTMLElement | null

function clearSelection() {
  uploadState.value = undefined
  selected.value = undefined
  if (fileInput.value) fileInput.value.value = ''
}

function current(signal: AbortSignal) {
  return scope.signal === signal && !signal.aborted && currentSession.value?.canAuthor && currentSession.value.expiresAt > Date.now()
}

function failure(reason: unknown, signal: AbortSignal, message: MessageKey) {
  if (!current(signal)) return
  if (reason instanceof ApiError && reason.status === 401) invalidateSession()
  else if (reason instanceof ApiError && reason.status === 404 && message === 'account.message109') available.value = false
  else error.value = t(message)
}

async function load(more = false) {
  const signal = scope.signal
  if (!current(signal) || loading.value || (more && !hasMore.value)) return
  loading.value = true
  error.value = ''
  try {
    const page = await listMedia(more ? entries.value.at(-1) : undefined, signal)
    if (!current(signal)) return
    const prior = more ? entries.value : []
    const existing = new Set(prior.map(item => item.id))
    entries.value = [...prior, ...page.items.filter(item => !existing.has(item.id))]
    hasMore.value = page.hasMore
    available.value = true
    resumable.value = page.resumable && Boolean(currentSession.value?.siteSessionId)
    webp.value = page.webp
  } catch (reason) { failure(reason, signal, 'account.message109') }
  finally { if (current(signal)) loading.value = false }
}

function choose(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return
  const file = event.target.files?.[0]
  selected.value = file ? { file, key: crypto.randomUUID() } : undefined
  uploadState.value = undefined
  error.value = ''
  feedback.value = ''
}

async function upload() {
  const signal = scope.signal
  const input = selected.value
  if (!input || !current(signal) || working.value || loading.value) return
  working.value = true
  error.value = ''
  feedback.value = ''
  try {
    const currentId = currentSession.value?.siteSessionId
    const item = resumable.value && currentId
      ? await uploadResumable(input, currentId, signal)
      : await uploadMedia(input.file, input.key, signal)
    if (!current(signal)) return
    entries.value = [item, ...entries.value.filter(previous => previous.id !== item.id)]
    if (input.coordinate) forgetMediaRecovery(input.coordinate)
    clearSelection()
    feedback.value = t('account.message98')
  } catch (reason) {
    const state = uploadState.value
    const invalidImage = reason instanceof ApiError && reason.status === 400 && state &&
      state.received.length === Math.ceil(state.length / state.partSize)
    failure(reason, signal, state && !invalidImage
      ? 'account.message99'
      : webp.value ? 'account.message100'
        : 'account.message101')
  }
  finally { if (current(signal)) working.value = false }
}

async function uploadResumable(input: NonNullable<typeof selected.value>, currentId: string, signal: AbortSignal) {
  const file = input.file
  input.digest ??= await mediaDigest(file, signal)
  if (!input.coordinate) {
    const saved = await mediaRecovery(file, input.digest, currentId, input.key, signal)
    input.coordinate = saved.coordinate
    input.key = saved.key
  }
  let state = await startMediaUpload({ file, key: input.key, digest: input.digest }, currentId, signal)
  signal.throwIfAborted()
  uploadState.value = state
  if (!state.reserved) {
    const count = Math.ceil(file.size / state.partSize)
    for (let part = 0; part < count; part++) {
      if (state.received.includes(part)) continue
      const offset = part * state.partSize
      const bytes = file.slice(offset, Math.min(file.size, offset + state.partSize), 'application/octet-stream')
      const digest = await mediaDigest(bytes, signal)
      state = await sendMediaPart(file, state, part, bytes, digest, currentId, signal)
      signal.throwIfAborted()
      uploadState.value = state
    }
  }
  return finalizeMediaUpload(file, state, currentId, signal)
}

async function cancelUpload() {
  const state = uploadState.value
  const identity = currentSession.value?.siteSessionId
  const signal = scope.signal
  if (!state || state.asset || !identity || !current(signal) || working.value) return
  working.value = true
  try {
    await cancelMediaUpload(state, identity, signal)
    if (!current(signal)) return
    if (selected.value?.coordinate) forgetMediaRecovery(selected.value.coordinate)
    clearSelection()
    error.value = ''
    feedback.value = t('account.message102')
  } catch (reason) { failure(reason, signal, 'account.message103') }
  finally { if (current(signal)) working.value = false }
}

async function remove(item: PrivateMediaItem) {
  const signal = scope.signal
  if (!current(signal) || working.value || loading.value) return
  working.value = true
  try {
    const confirmed = await ElMessageBox.confirm(t('account.deleteImageConfirm', { name: item.name }), t('account.message104'), {
      type: 'warning', confirmButtonText: t('account.message105'), cancelButtonText: t('nav.cancel'), closeOnClickModal: false,
    })
    if (!confirmed.ok || !current(signal)) return
    await removeMedia(item.id, signal)
    if (!current(signal)) return
    entries.value = entries.value.filter(value => value.id !== item.id)
    if (preview.value?.id === item.id) preview.value = undefined
    feedback.value = t('account.message107')
    await nextTick()
    if (current(signal)) heading.value?.focus()
  } catch (reason) { failure(reason, signal, 'account.message108') }
  finally { if (current(signal)) working.value = false }
}

function openPreview(item: PrivateMediaItem) {
  previewOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  preview.value = item
  void nextTick(() => previewHeading.value?.focus())
}

function closePreview() {
  preview.value = undefined
  void nextTick(() => (previewOpener?.isConnected ? previewOpener : heading.value)?.focus())
}

const preloadedAuth = consumeAuthoringSessionPreload()
const initialMedia = readInitialPrivateMediaPage()
let usedInitialMedia = false
watch(identityEpoch, () => {
  scope.abort()
  scope = new AbortController()
  preview.value = undefined
  clearSelection()
  working.value = false
  loading.value = false
  feedback.value = ''
  error.value = ''
  if (!usedInitialMedia && initialMedia && currentSession.value?.canAuthor) {
    usedInitialMedia = true
    entries.value = [...initialMedia.items]
    hasMore.value = initialMedia.hasMore
    available.value = true
    resumable.value = initialMedia.resumable && Boolean(currentSession.value?.siteSessionId)
    webp.value = initialMedia.webp
    return
  }
  entries.value = []
  hasMore.value = false
  resumable.value = false
  webp.value = false
  if (currentSession.value?.canAuthor) void load()
}, { immediate: true, flush: 'sync' })

onMounted(() => {
  if (!preloadedAuth) void refreshSession(scope.signal).catch(() => {})
})
onBeforeUnmount(() => scope.abort())
</script>

<template>
  <main class="media-page" tabindex="-1">
    <ElTaskPageHeader :title="t('nav.assets')" />
    <ElEmptyState v-if="!currentSession?.canAuthor" :title="t('account.message79')">
      <RouterLink v-if="!currentSession" :to="{ name: 'login', query: { redirect: route.fullPath } }">{{ t('page.login') }}</RouterLink>
    </ElEmptyState>
    <template v-else>
      <ElAlert v-if="!available" type="info" :title="t('account.message81')" :closable="false" />
      <template v-else>
        <ElSettingsSection :title="t('account.message82')" :description="webp
          ? t('account.message83')
          : t('account.message84')">
          <form class="media-upload" @submit.prevent="upload">
            <label for="private-media-file">{{ t('account.message85') }}</label>
            <input id="private-media-file" ref="fileInput" type="file" :accept="webp ? 'image/png,image/jpeg,image/webp' : 'image/png,image/jpeg'"
              :disabled="working" @change="choose" />
            <ElButton native-type="submit" type="primary" :disabled="!selected || loading" :loading="working">{{ t('account.message86') }}</ElButton>
            <ElButton v-if="uploadState && !uploadState.asset && !working" native-type="button" @click="cancelUpload">{{ t('account.message87') }}</ElButton>
          </form>
          <p v-if="resumable" class="media-help">{{ t('account.message88') }}</p>
          <div v-if="uploadState" class="media-progress">
            <span v-if="uploadState.reserved">{{ t('account.message89') }}</span>
            <template v-else>
              <span>{{ t('account.uploadParts', { received: uploadState.received.length, total: Math.ceil(uploadState.length / uploadState.partSize) }) }}</span>
              <ElProgress :percentage="Math.floor(uploadState.received.length * 100 / Math.ceil(uploadState.length / uploadState.partSize))" :show-text="false" />
            </template>
          </div>
        </ElSettingsSection>
        <ElAlert v-if="error" type="error" :title="error" :closable="false" show-icon />
        <p v-if="feedback" role="status">{{ feedback }}</p>
        <section aria-labelledby="media-list" :aria-busy="loading">
          <header class="media-head">
            <h2 id="media-list" ref="heading" tabindex="-1">{{ t('account.message90') }}</h2>
            <ElButton text :disabled="working" :loading="loading" @click="load()">{{ t('account.inboxRefresh') }}</ElButton>
          </header>
          <ElSkeleton v-if="loading && !entries.length" :rows="4" animated />
          <ElEmptyState v-else-if="!entries.length && !error" :title="t('account.message92')" />
          <ul v-else-if="entries.length" class="media-items">
            <li v-for="item in entries" :key="item.id" class="media-row">
              <div class="media-name">
                <strong>{{ item.name }}</strong>
                <p>{{ item.width }} × {{ item.height }} · {{ Math.ceil(item.length / 1024) }} KiB · {{ date.format(mediaDate(item.ticks)) }}</p>
              </div>
              <div class="media-actions">
                <ElButton text @click="openPreview(item)">{{ t('account.message93') }}<span class="media-label"> {{ item.name }}</span></ElButton>
                <ElButton text type="danger" :disabled="working || loading" @click="remove(item)">{{ t('account.message94') }}<span class="media-label"> {{ item.name }}</span></ElButton>
              </div>
            </li>
          </ul>
          <ElButton v-if="hasMore" text :loading="loading" :disabled="working" @click="load(true)">{{ t('account.message95') }}</ElButton>
        </section>
        <section v-if="preview" class="media-preview" aria-labelledby="media-preview">
          <header class="media-head">
            <h2 id="media-preview" ref="previewHeading" tabindex="-1">{{ preview.name }}</h2>
            <ElButton text @click="closePreview">{{ t('account.message96') }}</ElButton>
          </header>
          <img :src="privateMediaHref(preview.id)" :alt="preview.name" @error="error = t('account.message97')" />
        </section>
      </template>
    </template>
  </main>
</template>

<style scoped>
.media-page { width: min(64rem, calc(100% - 2 * var(--fsusblog-page-gutter))); margin: auto; padding-block: var(--fsus-space-6) var(--fsus-space-8); }
.media-page > * + * { margin-block-start: var(--fsus-space-5); }
.media-upload, .media-head, .media-row, .media-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--fsus-space-3); }
.media-upload input { max-width: 100%; }
.media-help, .media-progress { margin-block: var(--fsus-space-3) 0; color: var(--el-text-color-secondary); }
.media-progress { display: grid; gap: var(--fsus-space-2); }
.media-head, .media-row { justify-content: space-between; }
.media-head h2 { font-size: var(--el-font-size-large); overflow-wrap: anywhere; }
.media-items { margin: 0; padding: 0; list-style: none; }
.media-row { padding-block: var(--fsus-space-3); border-bottom: 1px solid var(--el-border-color-lighter); }
.media-name { min-width: 0; overflow-wrap: anywhere; }
.media-name p { margin-block: var(--fsus-space-1) 0; color: var(--el-text-color-secondary); }
.media-preview img { max-width: 100%; max-height: 50vh; object-fit: contain; }
.media-label { position: absolute; inline-size: 1px; block-size: 1px; clip-path: inset(50%); overflow: hidden; white-space: nowrap; }
</style>
