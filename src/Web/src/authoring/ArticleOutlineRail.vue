<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch, type ComponentPublicInstance } from 'vue'
import { ElButton, type MarkdownEditorOutlineItem } from '@ozwasyd/element-plus'
import OutlineShell from './OutlineShell.vue'
import { focusInspectorOpener } from './inspectorFocus'

const props = defineProps<{
  headings: readonly MarkdownEditorOutlineItem[]
  active: string | null
  state: 'loading' | 'ready' | 'unavailable'
  disabled: boolean
  foreground: boolean
  reveal: (heading: MarkdownEditorOutlineItem) => boolean
  launcherTarget?: HTMLElement
  dockTarget?: HTMLElement
  fallbackOpener?: () => HTMLElement | null
}>()
const emit = defineEmits<{ visibility: [open: boolean] }>()

type Selection = { heading: MarkdownEditorOutlineItem; reveal: typeof props.reveal }
type Presentation = {
  key: number
  compact: boolean
  restoreFocus: boolean
  selection?: Selection
  events: { close: () => void; closed: () => void; opened: () => void }
}

const pageSize = 50
const headingId = useId()
const contentId = `${headingId}-content`
const headingButtonId = (nodeId: string) => `${contentId}-${nodeId}`
const panelName = computed(() => t('author.articleOutlineRail.article.outline'))
const compact = ref(false)
const expanded = ref(false)
const launcherBtn = ref<ComponentPublicInstance & { ref?: HTMLButtonElement }>()
const content = ref<HTMLElement>()
const surface = shallowRef<Presentation>()
const focusedId = ref<string | null>(null)
const page = ref(0)
const headings = computed(() => props.state === 'ready' ? props.headings : [])
const lastPage = computed(() => Math.max(0, Math.ceil(headings.value.length / pageSize) - 1))
const visible = computed(() => headings.value.slice(page.value * pageSize, (page.value + 1) * pageSize))
const tabStop = computed(() => visible.value.find(heading => heading.nodeId === focusedId.value)
  ?? visible.value.find(heading => heading.nodeId === props.active) ?? visible.value[0])

function launcherElement(): HTMLElement | null {
  if (launcherBtn.value?.ref instanceof HTMLElement) return launcherBtn.value.ref
  if (launcherBtn.value?.$el instanceof HTMLElement) return launcherBtn.value.$el
  return null
}

let media: MediaQueryList | undefined
let generation = 0
let frame: number | undefined
let projecting = false
let positioned = false

function broadcast(open: boolean) {
  if (projecting === open) return
  projecting = open
  emit('visibility', open)
}

function advance() {
  if (frame !== undefined) window.cancelAnimationFrame(frame)
  frame = undefined
  return ++generation
}

function afterRender(key: number, action: () => void) {
  void nextTick(() => {
    if (key !== generation) return
    frame = window.requestAnimationFrame(() => {
      frame = undefined
      if (key === generation) action()
    })
  })
}

function focusHeading(id?: string) {
  const root = content.value
  if (!props.foreground || props.disabled || !root) return
  const button = id ? root.ownerDocument.getElementById(headingButtonId(id)) : null
  const target = button && root.contains(button) ? button : root
  target.focus()
}

function enter(owner: Presentation) {
  if (!props.foreground || surface.value !== owner || !expanded.value) return
  afterRender(owner.key, () => {
    if (!expanded.value || surface.value !== owner) return
    focusHeading(tabStop.value?.nodeId)
  })
}

function open() {
  if (!props.foreground || props.disabled || expanded.value) return
  compact.value = media?.matches ?? compact.value
  const owner: Presentation = {
    key: advance(), compact: compact.value, restoreFocus: true,
    events: {
      close: () => close(owner),
      closed: () => finish(owner),
      opened: () => enter(owner),
    },
  }
  page.value = 0
  focusedId.value = null
  positioned = false
  surface.value = owner
  expanded.value = true
  broadcast(true)
  if (!owner.compact) enter(owner)
}

function close(owner: Presentation | undefined, heading?: MarkdownEditorOutlineItem, restoreFocus = true) {
  if (!owner || surface.value !== owner || !expanded.value) return
  owner.restoreFocus = restoreFocus
  if (heading) owner.selection = { heading, reveal: props.reveal }
  expanded.value = false
  if (!owner.compact) finish(owner)
}

function toggle() {
  if (expanded.value) close(surface.value)
  else open()
}

function finish(owner: Presentation) {
  if (surface.value !== owner || expanded.value) return
  surface.value = undefined
  const key = advance()
  afterRender(key, () => {
    const selection = owner.selection
    // Wait until the compact Drawer has released its focus trap.
    const revealed = props.foreground && selection !== undefined && !props.disabled && props.state === 'ready'
      && selection.reveal === props.reveal && props.headings.includes(selection.heading)
      && selection.reveal(selection.heading)
    if (key !== generation) return
    broadcast(false)
    if (!revealed && owner.restoreFocus && props.foreground) {
      const opener = launcherElement() ?? props.fallbackOpener?.()
      if (opener) focusInspectorOpener(opener, null)
    }
  })
}

function choose(heading: MarkdownEditorOutlineItem) {
  if (props.disabled || props.state !== 'ready' || !headings.value.includes(heading)) return
  close(surface.value, heading)
}

function goTo(index: number) {
  const heading = headings.value[index]
  const owner = surface.value
  if (!heading || !owner || !expanded.value) return
  page.value = Math.floor(index / pageSize)
  focusedId.value = heading.nodeId
  void nextTick(() => {
    if (surface.value === owner && expanded.value) focusHeading(heading.nodeId)
  })
}

function navigate(event: KeyboardEvent, index: number) {
  if (event.defaultPrevented || event.isComposing) return
  const position = page.value * pageSize + index
  let next: number
  switch (event.key) {
    case 'ArrowUp': next = Math.max(0, position - 1); break
    case 'ArrowDown': next = Math.min(headings.value.length - 1, position + 1); break
    case 'Home': next = 0; break
    case 'End': next = headings.value.length - 1; break
    default: return
  }
  event.preventDefault()
  goTo(next)
}

function escapePane(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || compact.value || !expanded.value) return
  event.preventDefault()
  close(surface.value)
}

function reset() {
  const key = advance()
  const returnFocus = surface.value !== undefined || projecting
  surface.value = undefined
  expanded.value = false
  broadcast(false)
  if (returnFocus) afterRender(key, () => {
    if (props.foreground) {
      const opener = launcherElement() ?? props.fallbackOpener?.()
      if (opener) focusInspectorOpener(opener, null)
    }
  })
}

function resize() {
  const next = media?.matches ?? false
  if (compact.value === next) return
  compact.value = next
  reset()
}

const diagnosticText: Readonly<Record<string, string | undefined>> = {
  get 'duplicate-h1'() { return t('author.articleOutlineRail.repeated.level.1.heading') },
  get 'heading-layer-jump'() { return t('author.articleOutlineRail.heading.level.skipped') },
}
function diagnostics(heading: MarkdownEditorOutlineItem) {
  return [...new Set(heading.diagnostics.flatMap(({ code }) =>
    Object.hasOwn(diagnosticText, code) ? diagnosticText[code] ?? [] : []))]
}

watch([expanded, headings, () => props.active], () => {
  if (!expanded.value || !headings.value.length) return
  if (!positioned) {
    const index = headings.value.findIndex(heading => heading.nodeId === props.active)
    if (index >= 0) page.value = Math.floor(index / pageSize)
    positioned = true
  }
  page.value = Math.min(page.value, lastPage.value)
  if (content.value && document.activeElement === content.value) {
    const owner = surface.value
    if (owner) enter(owner)
  }
})
watch(() => props.disabled, disabled => { if (disabled) reset() })
watch(() => props.foreground, foreground => {
  // The compact Drawer is teleported outside the hidden pane.
  if (!foreground && surface.value?.compact) reset()
})
onMounted(() => {
  media = window.matchMedia('(max-width: 1023px)')
  resize()
  media.addEventListener('change', resize)
})
onBeforeUnmount(() => {
  advance()
  media?.removeEventListener('change', resize)
  broadcast(false)
})

defineExpose({
  open,
  close: (restoreFocus = true) => close(surface.value, undefined, restoreFocus),
  toggle,
  expanded,
})
</script>

<template>
  <Teleport :to="launcherTarget ?? 'body'" :disabled="!launcherTarget">
    <ElButton
      v-if="!compact && foreground"
      ref="launcherBtn"
      class="outline-launcher"
      text
      size="small"
      :bg="expanded"
      :type="expanded ? 'primary' : 'default'"
      native-type="button"
      :disabled="disabled"
      v-bind="{
        'aria-expanded': expanded,
        'aria-controls': expanded ? contentId : undefined,
        onKeydown: escapePane,
      }"
      @click="toggle"
    >{{ t('author.canvas.outline') }}</ElButton>
  </Teleport>
  <OutlineShell
    :surface="surface" :dock-target="dockTarget" :foreground="foreground" :expanded="expanded"
    :heading-id="headingId" :panel-name="panelName" @keydown="escapePane" @dismiss="close(surface)"
  >
    <div :id="contentId" ref="content" class="outline-body" tabindex="-1">
      <p v-if="state === 'loading'" role="status">{{ t('author.articleOutlineRail.loading.the.outline') }}</p>
      <p v-else-if="state === 'unavailable'" role="status">{{ t('author.articleOutlineRail.the.outline.is.unavailable') }}</p>
      <p v-else-if="!headings.length" role="status">{{ t('author.articleOutlineRail.this.article.has.no.headings') }}</p>
      <nav v-else :aria-label="t('author.articleOutlineRail.article.headings')">
        <ol class="outline-headings" role="list" :start="page * pageSize + 1">
          <li v-for="(heading, index) in visible" :key="heading.nodeId">
            <button
              :id="headingButtonId(heading.nodeId)" class="outline-heading" type="button"
              :style="{ '--outline-indent': Math.max(0, Math.min(5, heading.depth - 1)) }"
              :tabindex="tabStop?.nodeId === heading.nodeId ? 0 : -1"
              :aria-current="active === heading.nodeId ? 'location' : undefined"
              @focus="focusedId = heading.nodeId" @keydown="navigate($event, index)" @click="choose(heading)"
            >{{ heading.text || t('author.articleOutlineRail.untitled.heading') }}</button>
            <p v-if="diagnostics(heading).length" class="outline-diagnostic">{{ diagnostics(heading).join(' · ') }}</p>
          </li>
        </ol>
        <div v-if="lastPage > 0" class="outline-pages">
          <ElButton text size="small" native-type="button" :disabled="page === 0" @click="goTo((page - 1) * pageSize)">{{ t('author.articleOutlineRail.previous.headings') }}</ElButton>
          <ElButton text size="small" native-type="button" :disabled="page === lastPage" @click="goTo((page + 1) * pageSize)">{{ t('author.articleOutlineRail.next.headings') }}</ElButton>
        </div>
      </nav>
    </div>
  </OutlineShell>
</template>

<style scoped>
.outline-pane .outline-body {
  min-block-size: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: var(--fsus-space-2) var(--fsus-space-3);
}
.outline-headings {
  margin: 0;
  padding: 0;
  list-style: none;
}
.outline-heading {
  display: block;
  inline-size: 100%;
  min-block-size: var(--fsus-control-height-action);
  border: 0;
  border-radius: var(--fsus-radius-control-small);
  padding: var(--fsus-space-1) var(--fsus-space-2);
  padding-inline-start: calc(var(--fsus-space-2) + var(--outline-indent) * var(--fsus-space-2));
  background: transparent;
  color: var(--fsus-ink);
  font: inherit;
  font-size: .875rem;
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.outline-heading:hover,
.outline-heading[aria-current] {
  background: var(--fsus-state-selected-bg);
}
.outline-heading[aria-current] {
  font-weight: 600;
  color: var(--fsus-color-action-primary);
}
.outline-body:focus-visible,
.outline-heading:focus-visible {
  outline: 2px solid var(--fsus-color-focus-ring, var(--fsus-color-action-primary));
  outline-offset: -2px;
}
.outline-diagnostic {
  margin: 0 var(--fsus-space-2) var(--fsus-space-2);
  color: var(--fsus-color-text-muted);
  font-size: .8125rem;
}
.outline-pages {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  margin-block-start: var(--fsus-space-2);
}
</style>
