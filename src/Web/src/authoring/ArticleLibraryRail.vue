<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch, type ComponentPublicInstance } from 'vue'
import { ElButton, ElDrawer } from '@ozwasyd/element-plus'
import ArticleLibraryResults from './ArticleLibraryResults.vue'
import ArticleLibraryRecent from './ArticleLibraryRecent.vue'
import ArticleLibrarySaved from './ArticleLibrarySaved.vue'
import { identityEpoch } from '../authorSession'

const props = defineProps<{
  articleId?: number
  articleRevision?: bigint
  recentOpensVersion: number
  disabled: boolean
  activate: (id: number) => Promise<boolean>
  dockTarget?: HTMLElement
  fallbackOpener?: () => HTMLElement | null
}>()
const emit = defineEmits<{ visibility: [open: boolean] }>()

const visible = ref(false)
const recentAvailable = ref(false)
const pinnedAvailable = ref(false)
const mode = ref<'all' | 'recent' | 'pinned'>('all')
const compact = ref(false)
const launcherBtn = ref<ComponentPublicInstance & { ref?: HTMLButtonElement }>()
const results = ref<InstanceType<typeof ArticleLibraryResults>>()
const desktop = ref<HTMLElement>()
const drawer = ref<HTMLElement>()
const parking = ref<HTMLElement>()
const target = computed(() => (compact.value ? drawer.value : desktop.value) ?? parking.value)
const paneId = computed(() => visible.value && target.value !== parking.value ? sectionId : undefined)
const title = computed(() => t('author.articleLibraryRail.article.library'))
const sectionId = useId()
let media: MediaQueryList | undefined
let generation = 0
let shouldRefocus = true

function launcherElement(): HTMLElement | null {
  if (launcherBtn.value?.ref instanceof HTMLElement) return launcherBtn.value.ref
  if (launcherBtn.value?.$el instanceof HTMLElement) return launcherBtn.value.$el
  return null
}

function viewport() {
  const next = media?.matches ?? false
  if (next === compact.value) return
  compact.value = next
  const intent = ++generation
  if (visible.value && !next) void nextTick(() => { if (visible.value && generation === intent && mode.value === 'all') results.value?.focus() })
}

onMounted(() => {
  media = window.matchMedia('(max-width: 1023px)')
  viewport()
  media.addEventListener('change', viewport)
})
onBeforeUnmount(() => {
  media?.removeEventListener('change', viewport)
  ++generation
})
watch(identityEpoch, () => {
  ++generation
  visible.value = false
}, { flush: 'sync' })
watch(visible, open => {
  recentAvailable.value = false
  pinnedAvailable.value = false
  mode.value = 'all'
  emit('visibility', open)
}, { flush: 'sync' })

function recentSupport(supported: boolean) {
  recentAvailable.value = supported
  if (!supported && mode.value === 'recent') mode.value = 'all'
}

function pinnedSupport(supported: boolean) {
  pinnedAvailable.value = supported
  if (!supported && mode.value === 'pinned') {
    mode.value = 'all'
    const intent = generation
    void nextTick(() => { if (visible.value && generation === intent && mode.value === 'all') results.value?.focus() })
  }
}

async function open() {
  if (visible.value) return
  const intent = ++generation
  visible.value = true
  if (!compact.value) {
    await nextTick()
    if (visible.value && generation === intent) results.value?.focus()
  }
}

async function toggle() {
  if (visible.value) return close()
  await open()
}

let closing = 0
function refocus(intent = closing) {
  if (!visible.value && generation === intent && shouldRefocus) {
    ;(launcherElement() ?? props.fallbackOpener?.())?.focus({ preventScroll: true })
  }
}

function close(restoreFocus = true) {
  if (!visible.value) return
  shouldRefocus = restoreFocus
  visible.value = false
  const intent = closing = ++generation
  if (!compact.value && restoreFocus) void nextTick(() => refocus(intent))
}

async function activate(id: number, separate: boolean) {
  if (props.disabled || !visible.value) return
  if (separate) {
    window.open(`/admin/articles/edit/${id}`, '_blank', 'noopener')
    return
  }
  const intent = ++generation
  if (await props.activate(id) && generation === intent && compact.value) close()
}

defineExpose({ open, close, toggle, visible })
</script>

<template>
  <div v-if="!compact" class="library-rail">
    <ElButton
      ref="launcherBtn"
      class="library-launcher"
      text
      size="small"
      :bg="visible"
      :type="visible ? 'primary' : 'default'"
      native-type="button"
      v-bind="{
        'aria-expanded': visible,
        'aria-controls': paneId,
      }"
      @click="toggle"
    >{{ title }}</ElButton>
  </div>
  <Teleport v-if="!compact" :to="dockTarget ?? 'body'" :disabled="!dockTarget">
    <aside
      v-show="visible"
      :id="sectionId"
      class="library-pane"
      :class="{ 'library-pane--docked': Boolean(dockTarget) }"
      :aria-label="title"
      @keydown.esc.stop.prevent="close()"
    >
      <header class="library-pane__header">
        <h2>{{ title }}</h2>
        <ElButton text size="small" native-type="button" @click="close()">{{ t('author.articleLibraryRail.close.library') }}</ElButton>
      </header>
      <div ref="desktop" class="library-pane__body" />
    </aside>
  </Teleport>
  <ElDrawer v-if="compact" :model-value="visible" :title="title" direction="ltr" size="min(25rem, 100%)" append-to-body
    @close="close()" @closed="refocus()" @open-auto-focus="results?.focus()">
    <div :id="sectionId" ref="drawer" />
  </ElDrawer>
  <div ref="parking" hidden />
  <Teleport v-if="target" :to="target">
    <template v-if="visible">
      <div v-if="recentAvailable || pinnedAvailable" class="library-modes" role="group" :aria-label="t('author.articleLibraryRail.article.library.views')">
        <button type="button" :aria-pressed="mode === 'all'" @click="mode = 'all'">{{ t('author.articleLibraryRail.all.articles') }}</button>
        <button v-if="recentAvailable" type="button" :aria-pressed="mode === 'recent'" @click="mode = 'recent'">{{ t('author.articleLibraryRail.recent.opens') }}</button>
        <button v-if="pinnedAvailable" type="button" :aria-pressed="mode === 'pinned'" @click="mode = 'pinned'">{{ t('author.articleLibraryRail.pinned.views') }}</button>
      </div>
      <div v-show="mode === 'all'">
        <ArticleLibraryResults ref="results" :article-id="articleId" :article-revision="articleRevision"
          :disabled="disabled" @open="activate" />
      </div>
      <ArticleLibraryRecent :active="mode === 'recent'" :version="recentOpensVersion" :article-id="articleId" :disabled="disabled"
        @supported="recentSupport" @open="activate" />
      <ArticleLibrarySaved :active="mode === 'pinned'" :disabled="disabled" @available="pinnedSupport" />
    </template>
  </Teleport>
</template>

<style scoped>
.library-rail {
  display: inline-flex;
  align-items: center;
}
.library-pane {
  position: absolute;
  z-index: 15;
  inset-block-start: calc(100% + var(--fsus-space-2));
  inset-inline-start: 0;
  inline-size: min(23rem, calc(100vw - 4rem));
  max-block-size: min(38rem, 62dvh);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsus-paper);
}
.library-pane--docked {
  position: static;
  z-index: auto;
  inset: auto;
  inline-size: 17rem;
  block-size: 100%;
  max-block-size: none;
  border: 0;
  border-inline-end: 1px solid var(--fsus-border);
  border-radius: 0;
}
.library-pane__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fsus-space-2);
  padding: var(--fsus-space-3) var(--fsus-space-4);
  border-block-end: 1px solid var(--fsus-border);
}
.library-pane__header h2 {
  font-size: var(--fsus-typography-heading-sm-size);
  font-weight: 600;
  margin: 0;
}
.library-pane__body {
  min-block-size: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: var(--fsus-space-3);
}
.library-modes {
  display: flex;
  flex-wrap: wrap;
  gap: .25rem;
  margin-block: 0 var(--fsus-space-3);
  padding: .2rem;
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-control);
  background: var(--fsus-page);
}
.library-modes button {
  flex: 1 1 auto;
  min-block-size: 2rem;
  padding-inline: var(--fsus-space-2);
  border: 0;
  border-radius: var(--fsus-radius-control-small);
  background: transparent;
  color: var(--fsus-color-text-muted);
  font: inherit;
  font-size: .8125rem;
  font-weight: 500;
  cursor: pointer;
}
.library-modes button:hover {
  color: var(--fsus-ink);
}
.library-modes button[aria-pressed='true'] {
  background: var(--fsus-paper);
  color: var(--fsus-ink);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
}
.library-modes button:focus-visible {
  outline: 2px solid var(--fsus-color-action-primary);
  outline-offset: -2px;
}
</style>
