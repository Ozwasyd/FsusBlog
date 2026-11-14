<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch, type ComponentPublicInstance } from 'vue'
import { ElButton, ElDrawer } from '@ozwasyd/element-plus'
import {
  createInspectorFocus, focusInspectorOpener, type InspectorHost, type InspectorPresentation,
} from './inspectorFocus'

const props = withDefaults(defineProps<{ title?: string; triggerLabel?: string; nestedModalActive?: boolean; opened?: boolean }>(), {
  title: 'Article inspector',
  triggerLabel: 'Inspector',
  opened: undefined,
})
const emit = defineEmits<{ 'update:opened': [value: boolean] }>()

const compactQuery = '(max-width: 1023px)'
const host = ref<InspectorHost>('pane')
const expanded = ref(false)
const inspectorId = useId()
const titleId = `${inspectorId}-title`
const launcher = ref<HTMLButtonElement>()
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
    },
  }
}

const drawer = shallowRef<ReturnType<typeof drawerPresentation>>()
const contentTarget = computed(() =>
  (host.value === 'drawer' ? drawer.value?.target.value : pane.value) ?? parking.value)

const focus = createInspectorFocus<HTMLElement>({
  externalLauncher: () => launcher.value ?? null,
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
  drawer.value = host.value === 'drawer' && current
    ? drawerPresentation(current, ++drawerKey)
    : undefined
}

function open(requested = false) {
  if (expanded.value) return
  current = focus.open(host.value, requested ? launcher.value : null)
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
  <button
    :key="host" ref="launcher" v-show="host === 'pane' || !expanded"
    class="inspector-launcher" type="button" :aria-expanded="expanded"
    :aria-controls="host === 'pane' || drawer?.target.value ? inspectorId : undefined"
    :aria-haspopup="host === 'drawer' ? 'dialog' : undefined"
    @click="expanded ? close(current) : open(true)"
  >{{ triggerLabel }}</button>
  <aside
    v-if="host === 'pane'" v-show="expanded" :id="inspectorId"
    class="inspector-pane" :aria-labelledby="titleId"
  >
    <header class="inspector-heading">
      <h2 :id="titleId">{{ title }}</h2>
      <ElButton native-type="button" text @click="close(current)">Close</ElButton>
    </header>
    <div ref="pane" class="inspector-pane-content" />
  </aside>
  <ElDrawer
    v-else-if="drawer" :key="drawer.key" :model-value="expanded"
    :title="title" direction="rtl" size="100%" append-to-body
    v-on="drawer.events"
  >
    <div :id="inspectorId" :ref="drawer.mount" />
  </ElDrawer>
  <div ref="parking" hidden />
  <!-- A single slot tree moves into the live host when that host's body mounts. -->
  <Teleport v-if="contentTarget" :to="contentTarget">
    <div class="inspector-content"><slot /></div>
  </Teleport>
</template>

<style scoped>
.inspector-launcher {
  grid-area: launcher;
  justify-self: start;
  min-block-size: var(--fsus-control-height-action);
  padding-inline: var(--fsus-space-4);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-control);
  background: var(--fsus-paper);
  color: var(--fsus-ink);
  font: inherit;
  cursor: pointer;
}
.inspector-launcher:hover {
  color: var(--fsus-color-action-primary);
}
.inspector-launcher:focus-visible {
  outline: 2px solid var(--fsus-color-action-primary);
  outline-offset: 2px;
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
}
.inspector-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fsus-space-2);
  border-block-end: 1px solid var(--fsus-border);
  padding: var(--fsus-space-2) var(--fsus-space-4);
}
.inspector-heading h2 {
  margin: 0;
  font-size: var(--fsus-typography-heading-sm-size);
}
.inspector-pane-content {
  min-block-size: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding-inline: var(--fsus-space-4);
}
.inspector-content {
  min-inline-size: 0;
}
</style>
