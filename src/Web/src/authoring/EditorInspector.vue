<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch, type ComponentPublicInstance } from 'vue'
import { ElButton, ElDrawer } from '@ozwasyd/element-plus'
import {
  createInspectorFocus, focusInspectorOpener, type InspectorHost, type InspectorPresentation,
} from './inspectorFocus'

const props = withDefaults(defineProps<{
  title?: string
  triggerLabel?: string
  nestedModalActive?: boolean
  opened?: boolean
  paneTarget?: HTMLElement
}>(), {
  opened: undefined,
})
const title = computed(() => props.title ?? t('author.editorInspector.article.inspector'))
const triggerLabel = computed(() => props.triggerLabel ?? t('author.editorInspector.inspector'))
const emit = defineEmits<{ 'update:opened': [value: boolean] }>()

const compactQuery = '(max-width: 1023px)'
const host = ref<InspectorHost>('pane')
const expanded = ref(false)
const drawerOpened = ref(false)
const inspectorId = useId()
const titleId = `${inspectorId}-title`
const launcherButton = ref<ComponentPublicInstance>()
const launcherElement = () =>
  launcherButton.value?.$el instanceof HTMLButtonElement ? launcherButton.value.$el : null
const pane = ref<HTMLElement>()
const parking = ref<HTMLElement>()

function drawerPresentation(owner: InspectorPresentation, key: number) {
  const target = ref<HTMLElement>()
  return {
    key,
    target,
    mount(element: Element | ComponentPublicInstance | null) {
      target.value = element instanceof HTMLElement ? element : undefined
    },
    events: {
      close: () => close(owner),
      closed: () => { void owner.closed() },
      opened: () => { if (drawer.value?.key === key && expanded.value) drawerOpened.value = true },
    },
  }
}

const drawer = shallowRef<ReturnType<typeof drawerPresentation>>()
const contentTarget = computed(() =>
  (host.value === 'drawer' ? drawer.value?.target.value : pane.value) ?? parking.value)

const focus = createInspectorFocus<HTMLElement>({
  externalLauncher: launcherElement,
  restore: element => focusInspectorOpener(element, contentTarget.value ?? null),
  afterRender(restore) {
    let cancelled = false
    let frame: number | undefined
    void nextTick(() => {
      if (!cancelled) frame = window.requestAnimationFrame(restore)
    })
    return () => {
      cancelled = true
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  },
})

let current: InspectorPresentation | null = null
let drawerKey = 0
let media: MediaQueryList | undefined

function renderHost() {
  drawerOpened.value = false
  drawer.value = host.value === 'drawer' && current
    ? drawerPresentation(current, ++drawerKey)
    : undefined
}

function open(requested = false) {
  if (expanded.value) return
  current = focus.open(host.value, requested ? launcherElement() : null)
  expanded.value = true
  renderHost()
  if (requested) emit('update:opened', true)
}

function close(owner: InspectorPresentation | null, requested = true) {
  if (!owner?.close()) return
  expanded.value = false
  if (host.value === 'pane') void owner.closed()
  if (requested) emit('update:opened', false)
}

function rehost() {
  // FsusUI gives the newest focus trap ownership, independent of overlay z-index.
  if (props.nestedModalActive) return
  const next = media?.matches ? 'drawer' : 'pane'
  if (next === host.value) return
  host.value = next
  current = focus.rehost(next)
  renderHost()
}

function onDesktopEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing
      || host.value !== 'pane' || !expanded.value || props.nestedModalActive
      || event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return
  event.preventDefault()
  close(current)
}

watch(() => props.nestedModalActive, active => {
  if (!active) rehost()
})
watch(() => props.opened, opened => {
  if (opened === true) open()
  if (opened === false && expanded.value) close(current, false)
})

onMounted(() => {
  media = window.matchMedia(compactQuery)
  rehost()
  if (props.opened) open()
  media.addEventListener('change', rehost)
  window.addEventListener('keydown', onDesktopEscape)
})
onBeforeUnmount(() => {
  focus.dispose()
  current = null
  media?.removeEventListener('change', rehost)
  window.removeEventListener('keydown', onDesktopEscape)
})
</script>

<template>
  <ElButton
    :key="host"
    ref="launcherButton"
    v-show="host === 'pane' || !expanded"
    class="inspector-launcher"
    :size="paneTarget ? 'small' : undefined"
    :text="Boolean(paneTarget)"
    :bg="Boolean(paneTarget && expanded)"
    :type="paneTarget && expanded ? 'primary' : 'default'"
    native-type="button"
    v-bind="{
      'aria-expanded': expanded,
      'aria-controls': host === 'pane' || drawer?.target.value ? inspectorId : undefined,
      'aria-haspopup': host === 'drawer' ? 'dialog' : undefined,
    }"
    @click="expanded ? close(current) : open(true)"
  >{{ triggerLabel }}</ElButton>
  <Teleport v-if="host === 'pane'" :to="paneTarget ?? 'body'" :disabled="!paneTarget">
    <aside
      v-show="expanded"
      :id="inspectorId"
      class="inspector-pane"
      :class="{ 'inspector-pane--docked': Boolean(paneTarget) }"
      :aria-labelledby="titleId"
    >
      <header class="inspector-heading">
        <h2 :id="titleId">{{ title }}</h2>
        <ElButton native-type="button" text size="small" @click="close(current)">{{ t('author.editorInspector.close') }}</ElButton>
      </header>
      <div ref="pane" class="inspector-pane-content" />
    </aside>
  </Teleport>
  <ElDrawer
    v-else-if="drawer" :key="drawer.key" :model-value="expanded"
    :title="title" direction="rtl" size="100%" append-to-body
    v-on="drawer.events"
  >
    <div :id="inspectorId" :ref="drawer.mount" class="inspector-drawer-content" />
  </ElDrawer>
  <div ref="parking" hidden />
  <!-- A single slot tree moves into the live host when that host's body mounts. -->
  <Teleport v-if="contentTarget" :to="contentTarget">
    <div class="inspector-content"><slot :ready="expanded && (host === 'pane' || drawerOpened)" /></div>
  </Teleport>
</template>

<style scoped>
.inspector-launcher {
  grid-area: launcher;
  justify-self: start;
}
.inspector-pane {
  grid-area: pane;
  position: sticky;
  inset-block-start: var(--fsus-space-4);
  align-self: start;
  display: grid;
  min-inline-size: 0;
  max-block-size: calc(100dvh - 2 * var(--fsus-space-4));
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsus-paper);
  overflow: hidden;
}
.inspector-pane--docked {
  grid-area: auto;
  position: static;
  inset-block-start: auto;
  align-self: stretch;
  inline-size: clamp(20rem, 26vw, 24rem);
  block-size: 100%;
  max-block-size: none;
  border: 0;
  border-inline-start: 1px solid var(--fsus-border);
  border-radius: 0;
}
.inspector-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fsus-space-2);
  border-block-end: 1px solid var(--fsus-border);
  padding: var(--fsus-space-3) var(--fsus-space-4);
}
.inspector-heading h2 {
  margin: 0;
  font-size: var(--fsus-typography-heading-sm-size);
  font-weight: 600;
  line-height: 1.35;
}
.inspector-pane-content {
  min-block-size: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: var(--fsus-space-4);
}
.inspector-drawer-content {
  padding-block-end: var(--fsus-space-4);
}
.inspector-content {
  display: grid;
  min-inline-size: 0;
}
.inspector-content > :deep(:first-child) {
  border-block-start: 0;
  padding-block-start: 0;
}
.inspector-content :deep(label),
.inspector-pane-content .inspector-content :deep(label) {
  font-size: var(--fsus-font-size-sm, 0.875rem);
  font-weight: 500;
  color: var(--fsus-muted);
}
.inspector-content :deep(details) {
  min-inline-size: 0;
  border-block-start: 1px solid var(--fsus-border);
}
.inspector-content :deep(details > summary) {
  list-style: none;
  display: flex;
  align-items: center;
  gap: var(--fsus-space-2);
  min-block-size: var(--fsus-control-height-action);
  padding-block: var(--fsus-space-2);
  font-size: var(--fsus-font-size-base, 0.9375rem);
  font-weight: 600;
  line-height: 1.4;
  color: var(--fsus-ink);
  cursor: pointer;
  border-radius: var(--fsus-radius-control);
}
.inspector-content :deep(details > summary::-webkit-details-marker) {
  display: none;
}
.inspector-content :deep(details > summary::before) {
  content: '';
  inline-size: 1em;
  block-size: 1em;
  flex-shrink: 0;
  background-color: currentColor;
  opacity: 0.72;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat center / contain;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat center / contain;
  rotate: -90deg;
}
.inspector-content :deep(details > summary:dir(rtl)::before) {
  rotate: 90deg;
}
.inspector-content :deep(details[open] > summary::before) {
  rotate: 0deg;
}
.inspector-content :deep(details > summary:hover) {
  color: var(--fsus-color-action-primary);
}
.inspector-content :deep(details > summary:focus-visible) {
  outline: 2px solid var(--fsus-color-action-primary);
  outline-offset: 2px;
}
.inspector-content :deep(details::details-content) {
  interpolate-size: allow-keywords;
  overflow: clip;
  contain: layout;
}
.inspector-content :deep(details:not([open])::details-content) {
  block-size: 0;
}
.inspector-content :deep(details[open]) {
  padding-block-end: var(--fsus-space-3);
}
@media (prefers-reduced-motion: no-preference) {
  .inspector-content :deep(details > summary::before) {
    transition: rotate 0.2s ease;
  }
  .inspector-content :deep(details::details-content) {
    transition: block-size 0.22s ease, content-visibility 0.22s ease;
    transition-behavior: allow-discrete;
  }
}
</style>
