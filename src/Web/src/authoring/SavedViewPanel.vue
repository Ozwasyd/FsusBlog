<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import type { PropertyMatches, PropertyQuery } from '../../../Contracts/property-query'
import { changeSavedView, listSavedViews, placeSavedView, runSavedView, savedViewPlacement,
  type PlacementAction, type PlacementChange, type SavedView, type SavedViewCatalog, type SavedViewChange, type SavedViewPlacement } from '../../../Contracts/saved-views'
import { currentSession, identityEpoch, invalidateSession } from '../authorSession'
import { savedViewLink, savedViewRoute } from './savedViewLink'

const props = defineProps<{ query?: PropertyQuery; readOnly?: boolean }>()
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
    if (link === 'invalid') { error.value = t('author.savedViewPanel.invalid.saved.view.link'); return }
    const target = keep ?? link?.id
    let resolved = false
    await run((session, signal) => savedViewPlacement(session, target ? { id: target } : undefined, signal), positions => {
      placement.value = positions
      resolved = true
      if (target) selected.value = target
      if (positions.requested && positions.requested.id === selected.value) name.value = positions.requested.name
      else if (launch && !link && positions.defaultView) selected.value = positions.defaultView.id
      if (launch) start = target ? positions.requested : !link ? positions.defaultView : undefined
    }, t('author.savedViewPanel.could.not.read.saved.views'), failure => {
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
        error.value = t('author.savedViewPanel.saved.views.changed.reload.them')
        start = undefined
        return
      }
      page.value = current ? { ...listing, views: [...current.views, ...listing.views] } : listing
      if (keep && !placement.value && listing.views.some(item => item.id === keep)) selected.value = keep
    }, t('author.savedViewPanel.saved.views.are.temporarily.unavailable'))
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
    }, t('author.savedViewPanel.could.not.open.the.saved.view')).then(() => {
      if (!more && deepLink.value && ran.value?.id === chosen.id) resultHeading.value?.focus()
    })
}

async function save(action: SavedViewChange['action']) {
  if (busy.value || pendingPlacement.value || !page.value || action !== 'save' && !view.value) return
  const base = { id: view.value?.id ?? crypto.randomUUID(), revision: view.value?.revision ?? 0n,
    collectionRevision: page.value.revision, requestId: crypto.randomUUID() }
  const label = name.value.trim().normalize('NFC')
  if (!pending.value && action !== 'retire' && (!label || label.length > 128 || /\p{Cc}/u.test(label))) {
    error.value = t('author.savedViewPanel.enter.a.valid.name.of.up.to.128.characters')
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
  }, t('author.savedViewPanel.could.not.confirm.the.save.retry.the.original.operation'))
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
  }, t('author.savedViewPanel.could.not.confirm.view.settings.retry.the.original.operation'))
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
    t('author.savedViewPanel.could.not.read.more.pinned.views'))
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
    <summary>{{ t('author.savedViewPanel.saved.views') }}</summary>
    <div v-if="error" ref="alert" tabindex="-1"><ElAlert :title="error" type="error" :closable="false" /></div>
    <p v-if="busy" role="status">{{ t('author.savedViewPanel.loading.saved.views') }}</p>
    <ElButton v-if="error && !busy && !saving && !deepLink" text @click="reload">{{ t('author.savedViewPanel.reload.saved.views') }}</ElButton>
    <RouterLink v-if="deepLink" :to="{ name: savedViewRoute }">{{ t('author.savedViewPanel.back.to.all.views') }}</RouterLink>
    <template v-if="page">
      <nav v-if="placement?.pins.length" :aria-label="t('author.savedViewPanel.pinned.views')">
        <ul>
          <li v-for="pin in placement.pins" :key="pin.id">
            <RouterLink :to="{ name: savedViewRoute, query: { view: pin.id, viewSchema: '1' } }">
              {{ pin.name }}{{ pin.id === defaultId ? t('author.savedViewPanel.default') : '' }}
            </RouterLink>
          </li>
        </ul>
        <ElButton v-if="placement.offset" text :disabled="busy || saving" @click="morePins">{{ t('author.savedViewPanel.more.pinned.views') }}</ElButton>
      </nav>
      <label for="saved-view-select">{{ t('author.savedViewPanel.select.saved.view') }}</label>
      <ElSelect id="saved-view-select" v-model="selected" :ariaLabel="t('author.savedViewPanel.select.saved.view')" :disabled="busy || saving">
        <ElOption v-if="!props.readOnly" value="" :label="t('author.savedViewPanel.create.saved.view')" />
        <ElOption v-if="view && !page.views.some(entry => entry.id === view?.id)" :label="view.name" :value="view.id" />
        <ElOption v-for="item in page.views" :key="item.id" :label="item.name" :value="item.id" />
      </ElSelect>
      <ElButton v-if="page.nextId" text :disabled="busy || saving" @click="load(true)">{{ t('author.savedViewPanel.more.saved.views') }}</ElButton>
      <template v-if="view">
        <ElButton :disabled="busy || saving" @click="openView()">{{ t('author.savedViewPanel.open.saved.view') }}</ElButton>
        <RouterLink v-if="placement" :to="{ name: savedViewRoute, query: { view: view.id, viewSchema: '1' } }">{{ t('author.savedViewPanel.saved.view.link') }}</RouterLink>
        <template v-if="!props.readOnly">
          <ElButton v-if="placement && knowsPin" text :disabled="busy || saving" @click="place(pinned ? 'unpin' : 'pin')">
            {{ pinned ? t('author.savedViewPanel.unpin.view') : t('author.savedViewPanel.pin.view') }}
          </ElButton>
          <span v-if="pinIndex >= 0" ref="orderGroup">
            <ElButton v-if="pinIndex > 0" text :disabled="busy || saving" @click="move(-1)">{{ t('author.savedViewPanel.move.pinned.view.up') }}</ElButton>
            <ElButton v-if="(placement?.pins.length ?? 0) - pinIndex > (placement?.offset ? 2 : 1)"
              text :disabled="busy || saving" @click="move(1)">{{ t('author.savedViewPanel.move.pinned.view.down') }}</ElButton>
          </span>
          <ElButton v-if="placement" text :disabled="busy || saving" @click="place(view.id === defaultId ? 'clear-default' : 'default')">
            {{ view.id === defaultId ? t('author.savedViewPanel.clear.default.view') : t('author.savedViewPanel.set.as.default.view') }}
          </ElButton>
          <ElButton text :disabled="busy || saving || view.id === defaultId" @click="deleting = true">{{ t('author.savedViewPanel.remove.saved.view') }}</ElButton>
          <div v-if="deleting">
            <ElButton :disabled="busy" @click="save('retire')">{{ t('author.savedViewPanel.confirm.view.removal') }}</ElButton>
            <ElButton text @click="deleting = false">{{ t('nav.cancel') }}</ElButton>
          </div>
        </template>
      </template>
      <template v-if="!props.readOnly">
        <label for="saved-view-name">{{ t('author.savedViewPanel.saved.view.name') }}</label>
        <ElInput id="saved-view-name" v-model="name" :disabled="busy || saving" />
        <ElButton v-if="pendingPlacement" :disabled="busy" @click="place(pendingPlacement.action)">{{ t('author.savedViewPanel.retry.view.settings') }}</ElButton>
        <ElButton v-if="pending" :disabled="busy" @click="save(pending.action)">{{ t('author.savedViewPanel.retry.saved.view.operation') }}</ElButton>
        <template v-if="!saving">
          <ElButton v-if="view" :disabled="busy || !name.trim()" @click="save('rename')">{{ t('author.savedViewPanel.rename.saved.view') }}</ElButton>
          <ElButton v-if="props.query" :disabled="busy || !name.trim()" @click="save('save')">
            {{ view ? t('author.savedViewPanel.update.view.with.current.conditions') : t('author.savedViewPanel.save.current.filters') }}
          </ElButton>
          <p v-else-if="!view">{{ t('author.savedViewPanel.run.a.property.filter.to.save.its.conditions') }}</p>
        </template>
      </template>
      <section v-if="result" :aria-label="t('author.savedViewPanel.saved.view.results')">
        <h2 ref="resultHeading" tabindex="-1">{{ ran?.name }}</h2>
        <p v-if="!result.rows.length" role="status">{{ t('author.savedViewPanel.no.matching.articles') }}</p>
        <ul v-else>
          <li v-for="item in result.rows" :key="item.id">
            <RouterLink :to="{ name: 'edit', params: { id: item.id } }">{{ item.title }}</RouterLink>
          </li>
        </ul>
        <ElButton v-if="result.nextCursor" :disabled="busy" @click="openView(true)">{{ t('author.savedViewPanel.more.matching.articles') }}</ElButton>
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
