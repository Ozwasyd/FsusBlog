<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElButton } from '@ozwasyd/element-plus'
import type { WorkspaceTab } from './workspaceRegistry'

const props = defineProps<{ tabs: readonly WorkspaceTab[]; disabled?: boolean }>()
const emit = defineEmits<{
  activate: [tab: WorkspaceTab]
  pin: [tab: WorkspaceTab]
  close: [tab: WorkspaceTab]
}>()

const tabLimit = 24
const pageLimit = 12
const compactQuery = '(max-width: 1023px)'
const compact = ref(typeof window !== 'undefined' && window.matchMedia(compactQuery).matches)
const root = ref<HTMLElement>()
const list = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const overflow = ref<HTMLElement>()
const open = ref(false)
const page = ref(0)
const focused = ref<number>()
let requestedFromOverflow: number | undefined
const tabs = computed(() => props.tabs)
const activeIndex = computed(() => tabs.value.findIndex(tab => tab.active))
const selected = computed(() => tabs.value[activeIndex.value])
const pageCount = computed(() => Math.ceil(tabs.value.length / pageLimit))
const visible = computed(() => {
  const start = Math.max(0, Math.min(tabs.value.length - tabLimit, activeIndex.value - Math.floor(tabLimit / 2)))
  return tabs.value.slice(start, start + tabLimit)
})
const overflowTabs = computed(() => tabs.value.slice(page.value * pageLimit, (page.value + 1) * pageLimit))
const focusableTab = computed(() => visible.value.find(tab => tab.sessionId === focused.value) ?? selected.value ?? visible.value[0])
const availability = ['blocked', 'pending', 'saving']

const id = (tab: WorkspaceTab) => `workspace-tab-${tab.sessionId}`
const title = (tab: WorkspaceTab) => tab.title.trim() || 'Untitled article'
const status = (tab: WorkspaceTab): string => {
  switch (tab.risk) {
    case 'dirty': return 'Unsaved'
    case 'saving': return 'Saving'
    case 'conflict': return 'Conflict'
    case 'recovery': return 'Recovery needed'
    case 'pending': return 'Pending'
    case 'blocked': return 'Unavailable'
    case 'clean': return tab.mode === 'pinned' ? 'Pinned' : 'Preview'
  }
}
const tabLabel = (tab: WorkspaceTab) => `${title(tab)} · ${status(tab)}`
const cannotActivate = (tab: WorkspaceTab) => props.disabled || availability.includes(tab.risk)
const cannotPin = (tab: WorkspaceTab) => props.disabled || tab.risk === 'blocked' ||
  (tab.mode === 'pinned' && (tab.articleId === 0 || tab.risk !== 'clean'))
const pinLabel = (tab: WorkspaceTab) => `${tab.mode === 'pinned' ? 'Unpin' : 'Pin'} ${title(tab)}`

function tabButton(tab: WorkspaceTab) {
  return list.value?.querySelector<HTMLButtonElement>(`#${id(tab)}`)
}

function ensureVisible(tab: WorkspaceTab) {
  const parent = list.value
  const button = tabButton(tab)
  if (!parent || !button) return
  const bounds = parent.getBoundingClientRect()
  const current = button.getBoundingClientRect()
  if (current.left < bounds.left) parent.scrollLeft += current.left - bounds.left
  else if (current.right > bounds.right) parent.scrollLeft += current.right - bounds.right
}

function focusActive() {
  if (compact.value) trigger.value?.focus()
  else {
    const current = selected.value ?? visible.value[0]
    if (current) {
      tabButton(current)?.focus({ preventScroll: true })
      ensureVisible(current)
    } else {
      trigger.value?.focus()
    }
  }
}
defineExpose({ focusActive })

watch(() => selected.value?.sessionId, async sessionId => {
  focused.value = sessionId
  const returnToTab = sessionId !== undefined && sessionId === requestedFromOverflow && document.activeElement === trigger.value
  requestedFromOverflow = undefined
  await nextTick()
  const current = selected.value
  if (current && current.sessionId === sessionId) {
    if (returnToTab && !compact.value && document.activeElement === trigger.value) focusActive()
    else ensureVisible(current)
  }
}, { immediate: true })

watch(pageCount, count => {
  page.value = Math.max(0, Math.min(page.value, count - 1))
  if (count === 0) open.value = false
})

function changeViewport(query: MediaQueryListEvent) {
  const returnFocus = root.value?.contains(document.activeElement)
  compact.value = query.matches
  open.value = false
  if (returnFocus) void nextTick(focusActive)
}

function activate(tab: WorkspaceTab) {
  if (!cannotActivate(tab)) emit('activate', tab)
}

function pin(tab: WorkspaceTab) {
  if (!cannotPin(tab)) emit('pin', tab)
}

function close(tab: WorkspaceTab) {
  if (!props.disabled) emit('close', tab)
}

function middleClick(event: MouseEvent, tab: WorkspaceTab) {
  if (event.button !== 1) return
  event.preventDefault()
  close(tab)
}

function tabKeys(event: KeyboardEvent, tab: WorkspaceTab) {
  if (props.disabled || event.altKey || event.ctrlKey || event.metaKey) return
  if (event.key === 'Delete') {
    event.preventDefault()
    close(tab)
    return
  }
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const current = visible.value.findIndex(item => item.sessionId === tab.sessionId)
  const total = visible.value.length
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? total - 1
    : (current + (event.key === 'ArrowRight' ? 1 : total - 1)) % total
  const target = visible.value[next]
  if (!target) return
  event.preventDefault()
  focused.value = target.sessionId
  tabButton(target)?.focus({ preventScroll: true })
  ensureVisible(target)
}

function activeOverflowButton() {
  return overflow.value?.querySelector<HTMLButtonElement>('button.workspace-tabs__choice[aria-current="true"]')
    ?? overflow.value?.querySelector<HTMLButtonElement>('button.workspace-tabs__choice')
}

function outsideOverflow(event: PointerEvent) {
  if (open.value && event.target instanceof Node && !root.value?.contains(event.target)) open.value = false
}

let media: MediaQueryList | undefined
onMounted(() => {
  media = window.matchMedia(compactQuery)
  compact.value = media.matches
  media.addEventListener('change', changeViewport)
  document.addEventListener('pointerdown', outsideOverflow)
})
onUnmounted(() => {
  media?.removeEventListener('change', changeViewport)
  document.removeEventListener('pointerdown', outsideOverflow)
})

async function toggleOverflow() {
  if (open.value) {
    closeOverflow()
    return
  }
  page.value = Math.floor(Math.max(0, activeIndex.value) / pageLimit)
  open.value = true
  await nextTick()
  if (open.value) activeOverflowButton()?.focus()
}

function closeOverflow() {
  open.value = false
  trigger.value?.focus()
}

function leaveOverflow(event: FocusEvent) {
  const target = event.relatedTarget
  if (target instanceof Node && !root.value?.contains(target)) open.value = false
}

function overflowKeys(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeOverflow()
    return
  }
  const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End']
  if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
  const buttons = Array.from(overflow.value?.querySelectorAll<HTMLButtonElement>('button.workspace-tabs__choice') ?? [])
  const index = buttons.findIndex(button => button === document.activeElement)
  if (index < 0 || buttons.length === 0) return
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
  event.preventDefault()
  buttons[next]?.focus()
}

function activateFromOverflow(tab: WorkspaceTab) {
  if (cannotActivate(tab)) return
  if (!compact.value && !tab.active) requestedFromOverflow = tab.sessionId
  closeOverflow()
  activate(tab)
}

async function advancePage(index: number) {
  if (index < 0 || index >= pageCount.value) return
  page.value = index
  await nextTick()
  if (open.value) activeOverflowButton()?.focus()
}
</script>

<template>
  <nav v-if="tabs.length" ref="root" class="workspace-tabs" aria-label="Article tabs" @focusout="leaveOverflow">
    <div v-if="!compact" ref="list" class="workspace-tabs__list" role="tablist" aria-label="Open articles" aria-orientation="horizontal">
      <div
        v-for="tab in visible"
        :key="tab.sessionId"
        class="workspace-tabs__item"
        :class="{ selected: tab.active }"
        role="presentation"
      >
        <button
          :id="id(tab)" type="button" role="tab" class="workspace-tabs__tab"
          :aria-label="tabLabel(tab)" :aria-selected="tab.active"
          :aria-controls="tab.active ? 'workspace-editor' : undefined"
          :aria-disabled="cannotActivate(tab) || undefined"
          :tabindex="focusableTab?.sessionId === tab.sessionId ? 0 : -1"
          @focus="focused = tab.sessionId"
          @click="activate(tab)"
          @dblclick="tab.mode === 'preview' && pin(tab)" @auxclick="middleClick($event, tab)" @keydown="tabKeys($event, tab)"
        >
          <span :title="title(tab)" class="workspace-tabs__title">{{ title(tab) }}</span>
          <span class="workspace-tabs__status">{{ status(tab) }}</span>
        </button>
        <button
          v-if="tab.risk !== 'blocked'"
          type="button" class="workspace-tabs__action" :aria-label="pinLabel(tab)"
          :aria-pressed="tab.mode === 'pinned'" :disabled="cannotPin(tab)"
          :tabindex="tab.active ? 0 : -1" @click="pin(tab)"
        >
          {{ tab.mode === 'pinned' ? 'Unpin' : 'Pin' }}
        </button>
        <button
          type="button" class="workspace-tabs__action workspace-tabs__close"
          :aria-label="`Close ${title(tab)}`" :disabled="disabled"
          :tabindex="tab.active ? 0 : -1" @click="close(tab)"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
    <button
      v-if="compact || tabs.length > 1"
      ref="trigger" type="button" class="workspace-tabs__trigger"
      :class="{ 'workspace-tabs__trigger--compact': compact }"
      :id="compact ? 'workspace-mobile-tab' : undefined"
      :aria-label="compact ? 'Switch article tab' : undefined" :aria-expanded="open"
      :aria-describedby="compact ? 'workspace-mobile-current' : undefined"
      :aria-controls="open ? 'workspace-tabs-overflow' : undefined"
      @click="toggleOverflow"
      @keydown.esc.prevent="closeOverflow"
    >
      <template v-if="compact">
        <span id="workspace-mobile-current" class="workspace-tabs__title">{{ selected ? title(selected) : 'Select an open article' }}</span>
        <span v-if="selected" class="workspace-tabs__status">{{ status(selected) }}</span>
      </template>
      <template v-else>More tabs ({{ tabs.length }})</template>
    </button>
    <section
      v-if="open" id="workspace-tabs-overflow" ref="overflow"
      class="workspace-tabs__overflow"
      :class="{ 'workspace-tabs__overflow--compact': compact }"
      aria-label="Article tabs"
      @keydown="overflowKeys"
    >
      <div v-for="tab in overflowTabs" :key="tab.sessionId" class="workspace-tabs__row">
        <button
          type="button" class="workspace-tabs__tab workspace-tabs__choice"
          :aria-label="tabLabel(tab)" :aria-current="tab.active || undefined"
          :aria-disabled="cannotActivate(tab) || undefined"
          @click="activateFromOverflow(tab)"
          @auxclick="middleClick($event, tab)" @keydown.delete.prevent="close(tab)"
        >
          <span :title="title(tab)" class="workspace-tabs__title">{{ title(tab) }}</span>
          <span class="workspace-tabs__status">{{ status(tab) }}</span>
        </button>
        <button
          v-if="tab.risk !== 'blocked'"
          type="button" class="workspace-tabs__action"
          :aria-label="pinLabel(tab)" :aria-pressed="tab.mode === 'pinned'" :disabled="cannotPin(tab)" @click="pin(tab)"
        >
          {{ tab.mode === 'pinned' ? 'Unpin' : 'Pin' }}
        </button>
        <button
          type="button" class="workspace-tabs__action"
          :aria-label="`Close ${title(tab)}`" :disabled="disabled" @click="close(tab)"
        >
          Close
        </button>
      </div>
      <div v-if="pageCount > 1" class="workspace-tabs__pages">
        <ElButton text :disabled="page === 0" @click="advancePage(page - 1)">Previous tabs</ElButton>
        <span aria-live="polite">{{ page + 1 }} / {{ pageCount }}</span>
        <ElButton text :disabled="page + 1 === pageCount" @click="advancePage(page + 1)">Next tabs</ElButton>
      </div>
    </section>
  </nav>
</template>

<style scoped>
.workspace-tabs {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--fsus-space-2, .5rem);
  margin-block: .5rem;
  border-block-end: 1px solid var(--fsus-border);
}

.workspace-tabs__list {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  align-items: stretch;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scrollbar-width: thin;
}

.workspace-tabs__item,
.workspace-tabs__row {
  display: flex;
  min-width: 0;
  align-items: stretch;
}

.workspace-tabs__item {
  min-width: 10rem;
  max-width: 17rem;
  flex: 0 0 14rem;
  border-block-end: 2px solid transparent;
}

.workspace-tabs__item.selected {
  border-block-end-color: var(--fsus-color-action-primary);
}

.workspace-tabs__tab,
.workspace-tabs__action,
.workspace-tabs__trigger {
  min-block-size: var(--fsus-control-height-compact, 2rem);
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.workspace-tabs__tab,
.workspace-tabs__trigger--compact {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .5rem;
  padding: .35rem .6rem;
  text-align: start;
}

.workspace-tabs__tab { flex: 1 1 auto; }

.workspace-tabs__title {
  min-width: 0;
  overflow: hidden;
  font-size: .875rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-tabs__status,
.workspace-tabs__action,
.workspace-tabs__pages {
  flex: 0 0 auto;
  color: var(--fsus-color-text-muted);
  font-size: .75rem;
  white-space: nowrap;
}

.workspace-tabs__action,
.workspace-tabs__trigger { padding-inline: .5rem; }

.workspace-tabs__close { font-size: 1.125rem; }

.workspace-tabs__trigger {
  flex: 0 0 auto;
  font-size: .875rem;
  white-space: nowrap;
}

.workspace-tabs__trigger--compact {
  inline-size: 100%;
  justify-content: space-between;
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-navigation, .5rem);
}

.workspace-tabs__action:disabled,
.workspace-tabs__tab[aria-disabled='true'] {
  opacity: .65;
  cursor: default;
}

.workspace-tabs button:focus-visible {
  outline: 2px solid var(--fsus-color-focus-ring, var(--fsus-color-action-primary));
  outline-offset: -2px;
}

.workspace-tabs__overflow {
  position: absolute;
  inset-block-start: calc(100% + .25rem);
  inset-inline-end: 0;
  z-index: 2;
  inline-size: min(26rem, 100%);
  max-block-size: min(60dvh, 24rem);
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-popover, .5rem);
  background: var(--fsus-page);
  box-shadow: var(--fsus-shadow-popover, none);
}

.workspace-tabs__row + .workspace-tabs__row { border-block-start: 1px solid var(--fsus-border); }
.workspace-tabs__row .workspace-tabs__tab { justify-content: space-between; }

.workspace-tabs__pages {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-inline: .25rem;
}

@media (width <= 1023px) {
  .workspace-tabs { display: block; border: 0; }

  .workspace-tabs__overflow--compact {
    position: static;
    width: 100%;
    margin-block-start: .25rem;
  }

  .workspace-tabs__trigger,
  .workspace-tabs__row .workspace-tabs__tab,
  .workspace-tabs__row .workspace-tabs__action { min-block-size: 2.75rem; }
}

@media (forced-colors: active) {
  .workspace-tabs__item.selected { border-block-end-color: Highlight; }
  .workspace-tabs button:focus-visible { outline-color: Highlight; }
}
</style>
