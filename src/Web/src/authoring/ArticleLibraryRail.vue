<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { ElButton, ElDrawer } from '@ozwasyd/element-plus'
import ArticleLibraryResults from './ArticleLibraryResults.vue'
import ArticleLibraryRecent from './ArticleLibraryRecent.vue'
import { identityEpoch } from '../session'

const props = defineProps<{ articleId?: number; articleRevision?: bigint; recentOpensVersion: number; disabled: boolean;
  activate: (id: number) => Promise<boolean> }>()
const visible = ref(false)
const recentAvailable = ref(false)
const recent = ref(false)
const compact = ref(false)
const launcher = ref<HTMLButtonElement>()
const results = ref<InstanceType<typeof ArticleLibraryResults>>()
const desktop = ref<HTMLElement>()
const drawer = ref<HTMLElement>()
const parking = ref<HTMLElement>()
const target = computed(() => (compact.value ? drawer.value : desktop.value) ?? parking.value)
const paneId = computed(() => visible.value && target.value !== parking.value ? sectionId : undefined)
const title = 'Article library'
const sectionId = useId()
let media: MediaQueryList | undefined
let generation = 0

function viewport() {
  const next = media?.matches ?? false
  if (next === compact.value) return
  compact.value = next
  const intent = ++generation
  if (visible.value && !next) void nextTick(() => { if (visible.value && generation === intent) results.value?.focus() })
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
watch(visible, () => {
  recentAvailable.value = false
  recent.value = false
}, { flush: 'sync' })

function recentSupport(supported: boolean) {
  recentAvailable.value = supported
  if (!supported) recent.value = false
}

async function toggle() {
  if (visible.value) return close()
  const intent = ++generation
  visible.value = true
  if (!compact.value) {
    await nextTick()
    if (visible.value && generation === intent) results.value?.focus()
  }
}

let closing = 0
function refocus(intent = closing) {
  if (!visible.value && generation === intent) launcher.value?.focus({ preventScroll: true })
}

function close() {
  if (!visible.value) return
  visible.value = false
  const intent = closing = ++generation
  if (!compact.value) void nextTick(() => refocus(intent))
}

async function activate(id: number, separate: boolean) {
  if (props.disabled || !visible.value) return
  if (separate) {
    window.open(`/user/manage/article/edit/${id}`, '_blank', 'noopener')
    return
  }
  const intent = ++generation
  if (await props.activate(id) && generation === intent && compact.value) close()
}
</script>

<template>
  <div class="library-rail">
    <button ref="launcher" type="button" class="library-launcher" :aria-expanded="visible" :aria-controls="paneId"
      :aria-haspopup="compact ? 'dialog' : undefined" @click="toggle">{{ title }}</button>
    <aside v-if="!compact" v-show="visible" :id="sectionId" class="library-pane" :aria-label="title" @keydown.esc.stop.prevent="close">
      <header>
        <h2>{{ title }}</h2>
        <ElButton text native-type="button" @click="close">Close library</ElButton>
      </header>
      <div ref="desktop" />
    </aside>
    <ElDrawer v-if="compact" :model-value="visible" :title="title" direction="ltr" size="min(25rem, 100%)" append-to-body
      @close="close" @closed="refocus()" @open-auto-focus="results?.focus()">
      <div :id="sectionId" ref="drawer" />
    </ElDrawer>
    <div ref="parking" hidden />
    <Teleport v-if="target" :to="target">
      <template v-if="visible">
        <div v-if="recentAvailable" class="library-modes" role="group" aria-label="Article library views">
          <button type="button" :aria-pressed="!recent" @click="recent = false">All articles</button>
          <button type="button" :aria-pressed="recent" @click="recent = true">Recent opens</button>
        </div>
        <div v-show="!recent">
          <ArticleLibraryResults ref="results" :article-id="articleId" :article-revision="articleRevision"
            :disabled="disabled" @open="activate" />
        </div>
        <ArticleLibraryRecent :active="recent" :version="recentOpensVersion" :article-id="articleId" :disabled="disabled"
          @supported="recentSupport" @open="activate" />
      </template>
    </Teleport>
  </div>
</template>

<style scoped>
.library-rail { position: relative; }
.library-launcher {
  min-block-size: var(--fsus-control-height-action);
  padding-inline: var(--fsus-space-3);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-control);
  background: var(--fsus-paper);
  color: var(--fsus-ink);
  font: inherit;
  cursor: pointer;
}
.library-pane {
  position: absolute;
  z-index: 15;
  inset-block-start: calc(100% + var(--fsus-space-2));
  inset-inline-start: 0;
  inline-size: min(23rem, calc(100vw - 4rem));
  max-block-size: min(38rem, 62dvh);
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--fsus-space-3);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsus-paper);
}
.library-pane header { display: flex; align-items: center; justify-content: space-between; }
.library-pane h2 { font-size: var(--fsus-typography-heading-sm-size); margin: 0; }
.library-modes { display: flex; flex-wrap: wrap; gap: .35rem; margin-block: 0 var(--fsus-space-2); }
.library-modes button { min-block-size: var(--fsus-control-height-action); padding-inline: var(--fsus-space-2);
  border: 1px solid var(--fsus-border); border-radius: var(--fsus-radius-control); background: var(--fsus-paper);
  color: var(--fsus-ink); font: inherit; cursor: pointer; }
.library-modes button[aria-pressed='true'] { box-shadow: inset 0 -2px var(--fsus-ink); }
</style>
