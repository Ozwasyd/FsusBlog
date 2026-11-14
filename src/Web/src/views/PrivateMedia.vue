<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElEmptyState, ElMessageBox, ElSettingsSection, ElSkeleton, ElTaskPageHeader } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { listMedia, mediaDate, privateMediaHref, removeMedia, uploadMedia, type PrivateMediaItem } from '../../../Contracts/private-media'
import { currentSession, identityEpoch, invalidateSession } from '../session'

const entries = shallowRef<readonly PrivateMediaItem[]>([])
const selected = shallowRef<{ file: File; key: string }>()
const preview = shallowRef<PrivateMediaItem>()
const error = ref('')
const feedback = ref('')
const available = ref(true)
const hasMore = ref(false)
const working = ref(false)
const loading = ref(false)
const heading = ref<HTMLElement>()
const previewHeading = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
let scope = new AbortController()
let previewOpener: HTMLElement | null

function current(signal: AbortSignal) {
  return scope.signal === signal && !signal.aborted && currentSession.value?.canAuthor && currentSession.value.expiresAt > Date.now()
}

function failure(reason: unknown, signal: AbortSignal, message: string) {
  if (!current(signal)) return
  if (reason instanceof ApiError && reason.status === 401) invalidateSession()
  else if (reason instanceof ApiError && reason.status === 404 && message === '无法加载资产。') available.value = false
  else error.value = message
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
  } catch (reason) { failure(reason, signal, '无法加载资产。') }
  finally { if (current(signal)) loading.value = false }
}

function choose(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return
  const file = event.target.files?.[0]
  selected.value = file ? { file, key: crypto.randomUUID() } : undefined
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
    const item = await uploadMedia(input.file, input.key, signal)
    if (!current(signal)) return
    entries.value = [item, ...entries.value.filter(previous => previous.id !== item.id)]
    selected.value = undefined
    if (fileInput.value) fileInput.value.value = ''
    feedback.value = '图片已保存。'
  } catch (reason) { failure(reason, signal, '上传失败。请确认图片是 PNG 或 JPEG，且不超过 20 MiB。') }
  finally { if (current(signal)) working.value = false }
}

async function remove(item: PrivateMediaItem) {
  const signal = scope.signal
  if (!current(signal) || working.value || loading.value) return
  working.value = true
  try {
    const confirmed = await ElMessageBox.confirm(`永久删除「${item.name}」？`, '删除私有图片', {
      type: 'warning', confirmButtonText: '删除图片', cancelButtonText: '取消', closeOnClickModal: false,
    })
    if (!confirmed.ok || !current(signal)) return
    await removeMedia(item.id, signal)
    if (!current(signal)) return
    entries.value = entries.value.filter(value => value.id !== item.id)
    if (preview.value?.id === item.id) preview.value = undefined
    feedback.value = '图片已删除。'
    await nextTick()
    if (current(signal)) heading.value?.focus()
  } catch (reason) { failure(reason, signal, '删除失败。请重试。') }
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

watch(identityEpoch, () => {
  scope.abort()
  scope = new AbortController()
  preview.value = undefined
  selected.value = undefined
  entries.value = []
  hasMore.value = false
  working.value = false
  loading.value = false
  feedback.value = ''
  error.value = ''
  if (fileInput.value) fileInput.value.value = ''
  if (currentSession.value?.canAuthor) void load()
}, { immediate: true, flush: 'sync' })

onBeforeUnmount(() => scope.abort())
</script>

<template>
  <main class="media-page">
    <ElTaskPageHeader title="资产库" />
    <ElEmptyState v-if="!currentSession?.canAuthor" title="请使用作者账号登录">
      <RouterLink v-if="!currentSession" to="/login">登录</RouterLink>
    </ElEmptyState>
    <template v-else>
      <ElAlert v-if="!available" type="info" title="此站点未启用私有资产库" :closable="false" />
      <template v-else>
        <ElSettingsSection title="上传私有图片" description="PNG 或 JPEG，不超过 20 MiB。图片仅对上传者可见。">
          <form class="media-upload" @submit.prevent="upload">
            <label for="private-media-file">选择图片</label>
            <input id="private-media-file" ref="fileInput" type="file" accept="image/png,image/jpeg"
              :disabled="working" @change="choose" />
            <ElButton native-type="submit" type="primary" :disabled="!selected || loading" :loading="working">上传图片</ElButton>
          </form>
        </ElSettingsSection>
        <ElAlert v-if="error" type="error" :title="error" :closable="false" show-icon />
        <p v-if="feedback" role="status">{{ feedback }}</p>
        <section aria-labelledby="media-list" :aria-busy="loading">
          <header class="media-head">
            <h2 id="media-list" ref="heading" tabindex="-1">资产列表</h2>
            <ElButton text :disabled="working" :loading="loading" @click="load()">刷新</ElButton>
          </header>
          <ElSkeleton v-if="loading && !entries.length" :rows="4" animated />
          <ElEmptyState v-else-if="!entries.length && !error" title="还没有图片" />
          <ul v-else-if="entries.length" class="media-items">
            <li v-for="item in entries" :key="item.id" class="media-row">
              <div class="media-name">
                <strong>{{ item.name }}</strong>
                <p>{{ item.width }} × {{ item.height }} · {{ Math.ceil(item.length / 1024) }} KiB · {{ date.format(mediaDate(item.ticks)) }}</p>
              </div>
              <div class="media-actions">
                <ElButton text @click="openPreview(item)">查看<span class="media-label"> {{ item.name }}</span></ElButton>
                <ElButton text type="danger" :disabled="working || loading" @click="remove(item)">删除<span class="media-label"> {{ item.name }}</span></ElButton>
              </div>
            </li>
          </ul>
          <ElButton v-if="hasMore" text :loading="loading" :disabled="working" @click="load(true)">继续加载</ElButton>
        </section>
        <section v-if="preview" class="media-preview" aria-labelledby="media-preview">
          <header class="media-head">
            <h2 id="media-preview" ref="previewHeading" tabindex="-1">{{ preview.name }}</h2>
            <ElButton text @click="closePreview">关闭预览</ElButton>
          </header>
          <img :src="privateMediaHref(preview.id)" :alt="preview.name" @error="error = '暂时无法读取图片。'" />
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
.media-head, .media-row { justify-content: space-between; }
.media-head h2 { font-size: var(--el-font-size-large); overflow-wrap: anywhere; }
.media-items { margin: 0; padding: 0; list-style: none; }
.media-row { padding-block: var(--fsus-space-3); border-bottom: 1px solid var(--el-border-color-lighter); }
.media-name { min-width: 0; overflow-wrap: anywhere; }
.media-name p { margin-block: var(--fsus-space-1) 0; color: var(--el-text-color-secondary); }
.media-preview img { max-width: 100%; max-height: 50vh; object-fit: contain; }
.media-label { position: absolute; inline-size: 1px; block-size: 1px; clip-path: inset(50%); overflow: hidden; white-space: nowrap; }
</style>
