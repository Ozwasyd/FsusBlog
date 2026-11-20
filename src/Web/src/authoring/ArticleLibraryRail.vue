<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { ElButton, ElDrawer } from '@ozwasyd/element-plus'
import ArticleLibraryResults from './ArticleLibraryResults.vue'
import ArticleLibraryRecent from './ArticleLibraryRecent.vue'
import ArticleLibrarySaved from './ArticleLibrarySaved.vue'
import { identityEpoch } from '../authorSession'

const props = defineProps<{ articleId?: number; articleRevision?: bigint; recentOpensVersion: number; disabled: boolean;
  activate: (id: number) => Promise<boolean> }>()
const visible = ref(false)
const recentAvailable = ref(false)
const pinnedAvailable = ref(false)
const mode = ref<'all' | 'recent' | 'pinned'>('all')
const compact = ref(false)
const launcher = ref<HTMLButtonElement>()
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
watch(visible, () => {
  recentAvailable.value = false
  pinnedAvailable.value = false
  mode.value = 'all'
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
    window.open(`/admin/articles/edit/${id}`, '_blank', 'noopener')
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
        <ElButton text native-type="button" @click="close">{{ t('author.articleLibraryRail.close.library') }}</ElButton>
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
