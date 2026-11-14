<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import type { PropertyMatches, PropertyQuery } from '../../../Contracts/property-query'
import { changeSavedView, listSavedViews, runSavedView, type SavedView, type SavedViewCatalog, type SavedViewChange } from '../../../Contracts/saved-views'
import { currentSession, identityEpoch, invalidateSession } from '../session'

const props = defineProps<{ query?: PropertyQuery }>()
const open = ref(false)
const page = shallowRef<SavedViewCatalog>()
const selected = ref('')
const view = computed(() => page.value?.views.find(entry => entry.id === selected.value))
const name = ref('')
const busy = ref(false)
const error = ref('')
const result = shallowRef<PropertyMatches>()
const ran = shallowRef<SavedView>()
const pending = shallowRef<SavedViewChange>()
const deleting = ref(false)
let operation: AbortController | undefined

function toggle(event: Event) { open.value = (event.currentTarget as HTMLDetailsElement).open }

function clearResult() {
  result.value = undefined
  ran.value = undefined
}

async function run<T>(use: (session: string, signal: AbortSignal) => Promise<T>, publish: (value: T) => void, fallback: string) {
  const session = currentSession.value?.siteSessionId
  if (!session || busy.value) return
  const controller = operation = new AbortController()
  const epoch = identityEpoch.value
  const live = () => !controller.signal.aborted && identityEpoch.value === epoch
  busy.value = true
  error.value = ''
  try {
    const response = await use(session, controller.signal)
    if (live()) publish(response)
  } catch (failure) {
    if (!live()) return
    if (failure instanceof ApiError && failure.status === 401) { invalidateSession(); return }
    if (failure instanceof ApiError && failure.status < 500) pending.value = undefined
    if (failure instanceof ApiError && [400, 404, 409].includes(failure.status)) clearResult()
    error.value = failure instanceof ApiError && [400, 404, 409].includes(failure.status) ? failure.message : fallback
  } finally {
    if (live()) busy.value = false
  }
}

function load(more = false, keep = '') {
  const current = more ? page.value : undefined
  if (more && !current?.nextId) return
  return run((session, signal) => listSavedViews(session, current ? { id: current.nextId, revision: current.revision } : undefined, signal),
    listing => {
      page.value = current ? { ...listing, views: [...current.views, ...listing.views] } : listing
      if (keep) selected.value = page.value.views.some(entry => entry.id === keep) ? keep : ''
    }, '暂时无法读取保存视图。')
}

watch([open, identityEpoch], ([visible]) => {
  operation?.abort()
  page.value = undefined
  selected.value = ''
  name.value = ''
  error.value = ''
  busy.value = false
  pending.value = undefined
  deleting.value = false
  clearResult()
  if (visible) void load()
}, { flush: 'sync' })

watch(selected, () => {
  clearResult()
  deleting.value = false
  name.value = view.value?.name ?? ''
}, { flush: 'sync' })

onBeforeUnmount(() => operation?.abort())

function openView(more = false) {
  const chosen = more ? ran.value : view.value
  if (!chosen || pending.value) return
  const previous = more ? result.value : undefined
  if (!more) clearResult()
  void run((session, signal) => runSavedView(session, chosen, previous?.nextCursor ?? '', signal),
    matches => {
      ran.value = chosen
      result.value = { ...matches, rows: [...(previous?.rows ?? []), ...matches.rows] }
    }, '无法打开保存视图。')
}

async function save(action: SavedViewChange['action']) {
  if (busy.value || !page.value || action !== 'save' && !view.value) return
  const base = { id: view.value?.id ?? crypto.randomUUID(), revision: view.value?.revision ?? 0n,
    collectionRevision: page.value.revision, requestId: crypto.randomUUID() }
  const label = name.value.trim().normalize('NFC')
  if (!pending.value && action !== 'retire' && (!label || label.length > 128 || /\p{Cc}/u.test(label))) {
    error.value = '请输入不超过 128 个字符的有效名称。'
    return
  }
  const change = pending.value ?? (action === 'retire' ? { ...base, action }
    : action === 'rename' ? { ...base, action, name: label }
    : props.query ? { ...base, action, name: label, query: props.query } : undefined)
  if (!change) return
  pending.value = change
  deleting.value = false
  clearResult()
  let committed = false
  await run((session, signal) => changeSavedView(session, change, signal), () => {
    pending.value = undefined
    committed = true
  }, '无法确认保存操作。请重试原操作。')
  if (!committed) return
  selected.value = ''
  name.value = ''
  await load(false, change.action === 'retire' ? '' : change.id)
}

function reload() {
  selected.value = ''
  page.value = undefined
  clearResult()
  void load()
}
</script>

<template>
  <details class="saved-views" @toggle="toggle">
    <summary>保存视图</summary>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="busy" role="status">正在读取保存视图…</p>
    <ElButton v-if="error && !busy && !pending" text @click="reload">重新加载保存视图</ElButton>
    <template v-if="page">
      <label for="saved-view-select">选择保存视图</label>
      <ElSelect id="saved-view-select" v-model="selected" ariaLabel="选择保存视图" :disabled="busy || !!pending">
        <ElOption value="" label="新建保存视图" />
        <ElOption v-for="item in page.views" :key="item.id" :label="item.name" :value="item.id" />
      </ElSelect>
      <ElButton v-if="page.nextId" text :disabled="busy || !!pending" @click="load(true)">更多保存视图</ElButton>
      <template v-if="view">
        <ElButton :disabled="busy || !!pending" @click="openView()">打开保存视图</ElButton>
        <ElButton text :disabled="busy || !!pending" @click="deleting = true">移除保存视图</ElButton>
        <div v-if="deleting">
          <ElButton :disabled="busy" @click="save('retire')">确认移除视图</ElButton>
          <ElButton text @click="deleting = false">取消</ElButton>
        </div>
      </template>
      <label for="saved-view-name">保存视图名称</label>
      <ElInput id="saved-view-name" v-model="name" :disabled="busy || !!pending" />
      <ElButton v-if="pending" :disabled="busy" @click="save(pending.action)">重试保存视图操作</ElButton>
      <template v-else>
        <ElButton v-if="view" :disabled="busy || !name.trim()" @click="save('rename')">重命名保存视图</ElButton>
        <ElButton v-if="props.query" :disabled="busy || !name.trim()" @click="save('save')">
          {{ view ? '用当前条件更新视图' : '保存当前筛选' }}
        </ElButton>
        <p v-else-if="!view">运行属性筛选后即可保存条件。</p>
      </template>
      <section v-if="result" aria-label="保存视图结果">
        <p v-if="!result.rows.length" role="status">没有匹配的文章。</p>
        <ul v-else>
          <li v-for="item in result.rows" :key="item.id">
            <RouterLink :to="{ name: 'edit', params: { id: item.id } }">{{ item.title }}</RouterLink>
          </li>
        </ul>
        <ElButton v-if="result.nextCursor" :disabled="busy" @click="openView(true)">更多匹配文章</ElButton>
      </section>
    </template>
  </details>
</template>

<style scoped>
.saved-views { max-inline-size: 34rem; }
.saved-views[open] > :not(summary) { margin-block-start: var(--fsus-space-2); }
.saved-views label { display: block; }
.saved-views summary { cursor: pointer; }
</style>
