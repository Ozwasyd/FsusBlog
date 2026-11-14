<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import type { PropertyMatches, PropertyQuery } from '../../../Contracts/property-query'
import { changeSavedView, listSavedViews, placeSavedView, runSavedView, savedViewPlacement,
  type PlacementAction, type PlacementChange, type SavedView, type SavedViewCatalog, type SavedViewChange, type SavedViewPlacement } from '../../../Contracts/saved-views'
import { currentSession, identityEpoch, invalidateSession } from '../session'
import { savedViewLink } from './savedViewLink'

const props = defineProps<{ query?: PropertyQuery }>()
const route = useRoute()
const deepLink = computed(() => savedViewLink(route.query))
const open = ref(false)
const linkClosed = ref(false)
const visible = computed(() => deepLink.value === undefined ? open.value : !linkClosed.value)
const page = shallowRef<SavedViewCatalog>()
const placement = shallowRef<SavedViewPlacement>()
const selected = ref('')
const view = computed(() => [placement.value?.requested, placement.value?.defaultView,
  ...(page.value?.views ?? []), ...(placement.value?.pins ?? [])].find(entry => entry?.id === selected.value))
const defaultId = computed(() => placement.value?.defaultView?.id)
const pinIndex = computed(() => placement.value?.pins.findIndex(item => item.id === selected.value) ?? -1)
const pinned = computed(() => pinIndex.value >= 0 || placement.value?.requested?.id === selected.value && placement.value.requestedPinned)
const knowsPin = computed(() => pinned.value || !placement.value?.offset || placement.value.requested?.id === selected.value)
const name = ref('')
const busy = ref(false)
const error = ref('')
const result = shallowRef<PropertyMatches>()
const ran = shallowRef<SavedView>()
const pending = shallowRef<SavedViewChange>()
const pendingPlacement = shallowRef<PlacementChange>()
const saving = computed(() => !!pending.value || !!pendingPlacement.value)
const deleting = ref(false)
const resultHeading = ref<HTMLElement>()
const orderGroup = ref<HTMLElement>()
const alert = ref<HTMLElement>()
let operation: AbortController | undefined

function toggle(event: Event) {
  const details = event.currentTarget as HTMLDetailsElement
  if (deepLink.value === undefined) open.value = details.open
  else linkClosed.value = !details.open
}

function clearResult() {
  result.value = undefined
  ran.value = undefined
}

async function run<T>(use: (session: string, signal: AbortSignal) => Promise<T>, publish: (value: T) => void, fallback: string,
  handled?: (failure: unknown) => boolean) {
  const session = currentSession.value?.siteSessionId
  if (!session || busy.value) return
  const controller = operation = new AbortController()
  const epoch = identityEpoch.value
  const link = deepLink.value
  const ownsOperation = () => !controller.signal.aborted && identityEpoch.value === epoch && deepLink.value === link
  const live = () => ownsOperation() && currentSession.value?.siteSessionId === session
  busy.value = true
  error.value = ''
  try {
    const response = await use(session, controller.signal)
    if (live()) publish(response)
  } catch (failure) {
    if (!live()) return
    if (failure instanceof ApiError && failure.status === 401) { invalidateSession(); return }
    if (handled?.(failure)) return
    if (failure instanceof ApiError && failure.status < 500) {
      pending.value = undefined
      pendingPlacement.value = undefined
    }
    if (failure instanceof ApiError && [400, 404, 409].includes(failure.status)) clearResult()
    error.value = failure instanceof ApiError && [400, 404, 409].includes(failure.status) ? failure.message : fallback
  } finally {
    if (ownsOperation()) busy.value = false
  }
}

async function load(more = false, keep?: string, launch = false) {
  const current = more ? page.value : undefined
  if (more && !current?.nextId) return
  let start: SavedView | undefined
  if (!more) {
    page.value = undefined
    placement.value = undefined
    const link = deepLink.value
    if (link === 'invalid') { error.value = '保存视图链接无效。'; return }
    const target = keep ?? link?.id
    let resolved = false
    await run((session, signal) => savedViewPlacement(session, target ? { id: target } : undefined, signal), positions => {
      placement.value = positions
      resolved = true
      if (target) selected.value = target
      if (positions.requested && positions.requested.id === selected.value) name.value = positions.requested.name
      else if (launch && !link && positions.defaultView) selected.value = positions.defaultView.id
      if (launch) start = target ? positions.requested : !link ? positions.defaultView : undefined
    }, '无法读取保存视图。', failure => {
      if (link || !(failure instanceof ApiError) || failure.status !== 404 ||
          failure.message !== 'Saved view placement storage is unavailable.') return false
      placement.value = undefined
      resolved = true
      return true
    })
    if (!resolved) return
  }
  await run((session, signal) => listSavedViews(session, current ? { id: current.nextId, revision: current.revision } : undefined, signal),
    listing => {
      if (placement.value && placement.value.revision !== listing.revision) {
        error.value = '保存视图已变更，请重新加载。'
        start = undefined
        return
      }
      page.value = current ? { ...listing, views: [...current.views, ...listing.views] } : listing
      if (keep && !placement.value && listing.views.some(item => item.id === keep)) selected.value = keep
    }, '暂时无法读取保存视图。')
  if (start && page.value?.revision === placement.value?.revision && !error.value) openView()
}

watch(deepLink, () => { linkClosed.value = false })
watch(identityEpoch, () => { operation?.abort(); clearResult() }, { flush: 'sync' })
watch([visible, identityEpoch, deepLink], ([show]) => {
  operation?.abort()
  page.value = undefined
  placement.value = undefined
  selected.value = ''
  name.value = ''
  error.value = ''
  busy.value = false
  pending.value = undefined
  pendingPlacement.value = undefined
  deleting.value = false
  clearResult()
  if (show) void load(false, undefined, true)
}, { immediate: true })

watch(selected, () => {
  clearResult()
  deleting.value = false
  name.value = view.value?.name ?? ''
}, { flush: 'sync' })

onBeforeUnmount(() => operation?.abort())
watch(error, () => { if (error.value && deepLink.value) alert.value?.focus() }, { flush: 'post' })

function openView(more = false) {
  const chosen = more ? ran.value : view.value
  if (!chosen || saving.value) return
  const previous = more ? result.value : undefined
  if (!more) clearResult()
  void run((session, signal) => runSavedView(session, chosen, previous?.nextCursor ?? '', signal),
    matches => {
      ran.value = chosen
      result.value = { ...matches, rows: [...(previous?.rows ?? []), ...matches.rows] }
    }, '无法打开保存视图。').then(() => {
      if (!more && deepLink.value && ran.value?.id === chosen.id) resultHeading.value?.focus()
    })
}

async function save(action: SavedViewChange['action']) {
  if (busy.value || pendingPlacement.value || !page.value || action !== 'save' && !view.value) return
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

async function place(action: PlacementAction, before?: string) {
  if (!view.value || !page.value || busy.value || pending.value) return
  const command = pendingPlacement.value ?? { action, view: view.value, revision: page.value.revision, requestId: crypto.randomUUID(), before }
  pendingPlacement.value = command
  clearResult()
  let committed = false
  await run((session, signal) => placeSavedView(session, command, signal), () => {
    pendingPlacement.value = undefined
    committed = true
  }, '无法确认视图设置。请重试原操作。')
  if (!committed) return
  await load(false, command.view.id)
  if (action === 'move-before') {
    await nextTick()
    orderGroup.value?.querySelector<HTMLButtonElement>('button:enabled')?.focus()
  }
}

function morePins() {
  const current = placement.value
  if (!current?.offset || saving.value) return
  return run((session, signal) => savedViewPlacement(session, { offset: current.offset, revision: current.revision }, signal),
    result => { placement.value = { ...current, offset: result.offset, pins: [...current.pins, ...result.pins] } },
    '无法读取更多固定视图。')
}

function move(direction: -1 | 1) {
  const pins = placement.value?.pins ?? []
  if (pinIndex.value < 0 || !pins[pinIndex.value + direction]) return
  const before = pins[pinIndex.value + (direction > 0 ? 2 : -1)]?.id
  if (!before && placement.value?.offset) return
  void place('move-before', before)
}

function reload() {
  selected.value = ''
  page.value = undefined
  placement.value = undefined
  clearResult()
  void load(false, undefined, true)
}
</script>

<template>
  <details class="saved-views" :open="visible" @toggle="toggle">
    <summary>保存视图</summary>
    <div v-if="error" ref="alert" tabindex="-1"><ElAlert :title="error" type="error" :closable="false" /></div>
    <p v-if="busy" role="status">正在读取保存视图…</p>
    <ElButton v-if="error && !busy && !saving && !deepLink" text @click="reload">重新加载保存视图</ElButton>
    <RouterLink v-if="deepLink" :to="{ name: 'article-list' }">返回全部视图</RouterLink>
    <template v-if="page">
      <nav v-if="placement?.pins.length" aria-label="固定视图">
        <ul>
          <li v-for="pin in placement.pins" :key="pin.id">
            <RouterLink :to="{ name: 'article-list', query: { view: pin.id, viewSchema: '1' } }">
              {{ pin.name }}{{ pin.id === defaultId ? '（默认）' : '' }}
            </RouterLink>
          </li>
        </ul>
        <ElButton v-if="placement.offset" text :disabled="busy || saving" @click="morePins">更多固定视图</ElButton>
      </nav>
      <label for="saved-view-select">选择保存视图</label>
      <ElSelect id="saved-view-select" v-model="selected" ariaLabel="选择保存视图" :disabled="busy || saving">
        <ElOption value="" label="新建保存视图" />
        <ElOption v-if="view && !page.views.some(entry => entry.id === view?.id)" :label="view.name" :value="view.id" />
        <ElOption v-for="item in page.views" :key="item.id" :label="item.name" :value="item.id" />
      </ElSelect>
      <ElButton v-if="page.nextId" text :disabled="busy || saving" @click="load(true)">更多保存视图</ElButton>
      <template v-if="view">
        <ElButton :disabled="busy || saving" @click="openView()">打开保存视图</ElButton>
        <RouterLink v-if="placement" :to="{ name: 'article-list', query: { view: view.id, viewSchema: '1' } }">保存视图链接</RouterLink>
        <ElButton v-if="placement && knowsPin" text :disabled="busy || saving" @click="place(pinned ? 'unpin' : 'pin')">
          {{ pinned ? '取消固定视图' : '固定视图' }}
        </ElButton>
        <span v-if="pinIndex >= 0" ref="orderGroup">
          <ElButton v-if="pinIndex > 0" text :disabled="busy || saving" @click="move(-1)">上移固定视图</ElButton>
          <ElButton v-if="(placement?.pins.length ?? 0) - pinIndex > (placement?.offset ? 2 : 1)"
            text :disabled="busy || saving" @click="move(1)">下移固定视图</ElButton>
        </span>
        <ElButton v-if="placement" text :disabled="busy || saving" @click="place(view.id === defaultId ? 'clear-default' : 'default')">
          {{ view.id === defaultId ? '清除默认视图' : '设为默认视图' }}
        </ElButton>
        <ElButton text :disabled="busy || saving || view.id === defaultId" @click="deleting = true">移除保存视图</ElButton>
        <div v-if="deleting">
          <ElButton :disabled="busy" @click="save('retire')">确认移除视图</ElButton>
          <ElButton text @click="deleting = false">取消</ElButton>
        </div>
      </template>
      <label for="saved-view-name">保存视图名称</label>
      <ElInput id="saved-view-name" v-model="name" :disabled="busy || saving" />
      <ElButton v-if="pendingPlacement" :disabled="busy" @click="place(pendingPlacement.action)">重试视图设置</ElButton>
      <ElButton v-if="pending" :disabled="busy" @click="save(pending.action)">重试保存视图操作</ElButton>
      <template v-if="!saving">
        <ElButton v-if="view" :disabled="busy || !name.trim()" @click="save('rename')">重命名保存视图</ElButton>
        <ElButton v-if="props.query" :disabled="busy || !name.trim()" @click="save('save')">
          {{ view ? '用当前条件更新视图' : '保存当前筛选' }}
        </ElButton>
        <p v-else-if="!view">运行属性筛选后即可保存条件。</p>
      </template>
      <section v-if="result" aria-label="保存视图结果">
        <h2 ref="resultHeading" tabindex="-1">{{ ran?.name }}</h2>
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
