<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import { ElButton, ElDrawer, type MarkdownEditorOutlineItem } from '@ozwasyd/element-plus'
import { focusInspectorOpener } from './inspectorFocus'

const props = defineProps<{
  headings: readonly MarkdownEditorOutlineItem[]
  active: string | null
  state: 'loading' | 'ready' | 'unavailable'
  disabled: boolean
  foreground: boolean
  reveal: (heading: MarkdownEditorOutlineItem) => boolean
}>()
const emit = defineEmits<{ visibility: [open: boolean] }>()

type Selection = { heading: MarkdownEditorOutlineItem; reveal: typeof props.reveal }
type Presentation = {
  key: number
  compact: boolean
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
const launcher = ref<HTMLButtonElement>()
const content = ref<HTMLElement>()
const surface = shallowRef<Presentation>()
const focusedId = ref<string | null>(null)
const page = ref(0)
const headings = computed(() => props.state === 'ready' ? props.headings : [])
const lastPage = computed(() => Math.max(0, Math.ceil(headings.value.length / pageSize) - 1))
const visible = computed(() => headings.value.slice(page.value * pageSize, (page.value + 1) * pageSize))
const tabStop = computed(() => visible.value.find(heading => heading.nodeId === focusedId.value)
  ?? visible.value.find(heading => heading.nodeId === props.active) ?? visible.value[0])

const host = computed(() => surface.value?.compact ? ElDrawer : 'aside')
const hostProps = computed(() => surface.value?.compact
  ? { modelValue: expanded.value, title: panelName, direction: 'ltr' as const, size: 'min(86vw, 22rem)', appendToBody: true }
  : { class: 'outline-pane', 'aria-labelledby': headingId })

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
    key: advance(), compact: compact.value,
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

function close(owner: Presentation | undefined, heading?: MarkdownEditorOutlineItem) {
  if (!owner || surface.value !== owner || !expanded.value) return
  if (heading) owner.selection = { heading, reveal: props.reveal }
  expanded.value = false
  if (!owner.compact) finish(owner)
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
    if (!revealed && props.foreground && launcher.value) focusInspectorOpener(launcher.value, null)
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
    if (props.foreground && launcher.value) focusInspectorOpener(launcher.value, null)
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
</script>

<template>
  <div v-show="foreground" class="outline-rail" @keydown="escapePane">
    <button
      ref="launcher" class="outline-launcher" type="button" :aria-expanded="expanded"
      :aria-controls="expanded ? contentId : undefined" :aria-haspopup="compact ? 'dialog' : undefined"
      :disabled="disabled" @click="expanded ? close(surface) : open()"
    >{{ t('author.articleOutlineRail.outline') }}</button>
    <component v-if="surface" :is="host" :key="surface.key" v-bind="hostProps" v-on="surface.events">
      <header v-if="!surface.compact" class="outline-header">
        <h2 :id="headingId">{{ panelName }}</h2>
        <ElButton text native-type="button" @click="close(surface)">{{ t('author.articleOutlineRail.close') }}</ElButton>
      </header>
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
            <ElButton text native-type="button" :disabled="page === 0" @click="goTo((page - 1) * pageSize)">{{ t('author.articleOutlineRail.previous.headings') }}</ElButton>
            <ElButton text native-type="button" :disabled="page === lastPage" @click="goTo((page + 1) * pageSize)">{{ t('author.articleOutlineRail.next.headings') }}</ElButton>
          </div>
        </nav>
      </div>
    </component>
  </div>
</template>

<style scoped>
.outline-rail {
  justify-self: start;
}
.outline-launcher {
  min-block-size: var(--fsus-control-height-action);
  padding-inline: var(--fsus-space-4);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-control);
  background: var(--fsus-paper);
  color: var(--fsus-ink);
  font: inherit;
  cursor: pointer;
}
.outline-launcher:disabled {
  color: var(--fsus-color-text-muted);
  cursor: default;
}
.outline-pane {
  position: fixed;
  z-index: 30;
  inset-block: calc(6rem + var(--fsus-space-4)) auto;
  inset-inline-start: var(--fsus-space-4);
  display: grid;
  max-block-size: calc(100dvh - 6rem - 2 * var(--fsus-space-4));
  inline-size: min(20rem, 30vw);
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsus-paper);
  box-shadow: var(--fsus-shadow-panel);
}
.outline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fsus-space-2);
  padding: var(--fsus-space-2) var(--fsus-space-4);
  border-block-end: 1px solid var(--fsus-border);
}
.outline-header h2 {
  margin: 0;
  font-size: var(--fsus-typography-heading-sm-size);
}
.outline-pane .outline-body {
  min-block-size: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--fsus-space-2);
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
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.outline-heading:hover,
.outline-heading[aria-current] {
  background: var(--fsus-state-selected-bg);
}
.outline-heading[aria-current] {
  font-weight: 700;
}
.outline-body:focus-visible,
.outline-heading:focus-visible,
.outline-launcher:focus-visible {
  outline: 2px solid var(--fsus-color-focus-ring);
  outline-offset: -2px;
}
.outline-diagnostic {
  margin: 0 var(--fsus-space-2) var(--fsus-space-2);
  color: var(--fsus-color-text-muted);
  font-size: .875rem;
}
.outline-pages {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
}
</style>
