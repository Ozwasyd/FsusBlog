<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import { ElButton, ElDialog, ElInput } from '@ozwasyd/element-plus'
import { listAuthorArticles, type AuthorArticleState } from '../../../Contracts/author-articles'
import { listRecentOpens } from '../../../Contracts/author-recent-opens'
import { ApiError } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import { credentialEpoch, currentSession, identityEpoch } from '../authorSession'
import type { WorkspaceGroup } from './workspaceRegistry'

const props = defineProps<{
  disabled: boolean
  otherGroup?: WorkspaceGroup
  activate: (id: number, revision: bigint, current: () => boolean, targetGroup?: WorkspaceGroup) => Promise<boolean>
  articleHref: (id: number) => string
  hideLauncher?: boolean
  quietLauncher?: boolean
}>()
const emit = defineEmits<{ activated: [id: number] }>()
type Result = Readonly<{ id: number; title: string; revision?: bigint; state?: AuthorArticleState; at: number }>
const labels = { get draft() { return t('author.articleQuickSwitcher.draft') }, get scheduled() { return t('author.articleQuickSwitcher.scheduled') }, get published() { return t('author.articleQuickSwitcher.published') }, get retracted() { return t('author.articleQuickSwitcher.withdrawn') }, get deleted() { return t('author.articleQuickSwitcher.deleted') } }
const clock = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const listId = useId()
const open = ref(false)
const keyword = ref('')
const query = computed(() => keyword.value.trim())
const rows = shallowRef<readonly Result[]>([])
const index = ref(0)
const search = shallowRef<InstanceType<typeof ElInput>>()
const loading = ref(false)
const busy = ref(false)
const message = ref('')
const failure = ref('')
const selected = computed(() => rows.value[index.value])
const optionId = (id: number) => `${listId}-${id}`
const retry = ref(0)
let action: AbortController | undefined
let focusAfterClose: number | undefined

function current(handle: string | undefined, identity: number, credential: number) {
  const session = currentSession.value
  return open.value && !!handle && session?.siteSessionId === handle && session.canAuthor &&
    session.expiresAt > Date.now() && identityEpoch.value === identity && credentialEpoch.value === credential
}

function cancelAction() {
  action?.abort()
  action = undefined
  busy.value = false
}

watch([open, query, retry], ([shown, value], _, cleanup) => {
  cancelAction()
  rows.value = []
  index.value = 0
  loading.value = false
  message.value = ''
  failure.value = ''
  if (!shown) return
  const identity = identityEpoch.value, credential = credentialEpoch.value, handle = currentSession.value?.siteSessionId
  if (!handle || !current(handle, identity, credential)) return
  const controller = new AbortController()
  const valid = () => !controller.signal.aborted && current(handle, identity, credential)
  loading.value = true
  const timer = window.setTimeout(async () => {
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)])
      if (value) {
        const page = await listAuthorArticles({ trash: false, keyword: value }, signal, handle)
        if (!valid()) return
        rows.value = page.items.map(item => ({ id: item.id, title: item.title, revision: item.revision, state: item.state, at: item.modifiedAt }))
        if (!rows.value.length) message.value = t('author.articleQuickSwitcher.no.matching.articles')
        else if (page.nextId) message.value = t('author.articleQuickSwitcher.refine.your.search.to.find.more.articles')
      } else {
        const page = await listRecentOpens(handle, signal)
        if (!valid()) return
        // The title is current but an open record's revision refers to the prior visit.
        rows.value = page.items.map(item => ({ id: item.articleId, title: item.title, at: item.openedAt }))
        if (!rows.value.length) message.value = t('author.articleQuickSwitcher.no.recent.opens.search.by.title')
      }
    } catch (error) {
      if (!valid()) return
      if (!value && error instanceof ApiError && error.status === 404) message.value = t('author.articleQuickSwitcher.recent.opens.are.unavailable.search.by.title')
      else failure.value = t('author.articleQuickSwitcher.could.not.load.articles.try.again')
    } finally {
      if (valid()) loading.value = false
    }
  }, value ? 160 : 0)
  cleanup(() => { window.clearTimeout(timer); controller.abort() })
}, { flush: 'sync' })

function show() {
  if (props.disabled || open.value || !currentSession.value?.canAuthor || currentSession.value.expiresAt <= Date.now()) return false
  focusAfterClose = undefined
  keyword.value = ''
  open.value = true
  return true
}

function close() { open.value = false }
function beforeClose(done: () => void) { close(); done() }

function shortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey ||
      event.ctrlKey === event.metaKey || event.key.toLowerCase() !== 'o' || props.disabled ||
      event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return
  if (show()) event.preventDefault()
}

function onKeys(event: Event) {
  if (!(event instanceof KeyboardEvent)) return
  if (event.isComposing || event.keyCode === 229) {
    if (event.key === 'Escape') event.stopPropagation()
    return
  }
  if (event.key === 'Enter' && !event.altKey && !event.shiftKey) {
    event.preventDefault()
    if (!event.repeat && selected.value) void choose(selected.value, event.metaKey || event.ctrlKey ? 'browser' : 'workspace')
    return
  }
  if (!rows.value.length || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
  const last = rows.value.length - 1
  const offsets: Record<string, number> = {
    ArrowDown: index.value + 1, ArrowUp: index.value - 1, Home: 0, End: last,
    PageDown: index.value + 5, PageUp: index.value - 5,
  }
  if (!Object.hasOwn(offsets, event.key)) return
  event.preventDefault()
  index.value = Math.min(last, Math.max(0, offsets[event.key]))
  if (selected.value) document.getElementById(optionId(selected.value.id))?.scrollIntoView({ block: 'nearest' })
}

async function choose(row: Result, destination: 'workspace' | 'browser' | 'other-group') {
  const targetGroup = destination === 'other-group' ? props.otherGroup : undefined
  if (busy.value || props.disabled || destination === 'other-group' && !targetGroup) return
  const identity = identityEpoch.value, credential = credentialEpoch.value, handle = currentSession.value?.siteSessionId
  if (!handle || !current(handle, identity, credential)) return

  // Reserve a browser tab inside the native gesture, before the async ownership check.
  const separate = destination === 'browser'
  const child = separate ? window.open('about:blank', '_blank') : null
  if (child) child.opener = null
  if (separate && !child) {
    failure.value = t('author.articleQuickSwitcher.the.browser.did.not.open.a.new.tab')
    return
  }

  const controller = new AbortController()
  action = controller
  busy.value = true
  failure.value = ''
  let opened = false
  const valid = () => !controller.signal.aborted && current(handle, identity, credential) && !props.disabled
  const closeChild = () => { if (!opened) child?.close() }
  controller.signal.addEventListener('abort', closeChild, { once: true })
  try {
    const page = await listAuthorArticles({ trash: false, articleId: row.id },
      AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]), handle)
    if (!valid()) return
    const confirmed = page.items[0]
    if (!confirmed || row.revision !== undefined && row.revision !== confirmed.revision) {
      failure.value = confirmed ? t('author.articleQuickSwitcher.this.article.changed.search.again.to.continue') : t('author.articleQuickSwitcher.this.article.is.no.longer.available')
      return
    }
    if (child) {
      if (child.closed) return
      child.location.replace(new URL(props.articleHref(row.id), location.origin).href)
    } else {
      if (!await props.activate(row.id, confirmed.revision, valid, targetGroup)) {
        if (valid()) failure.value = t('author.articleQuickSwitcher.could.not.open.this.article.search.again.to.continue')
        return
      }
      if (!valid()) return
      focusAfterClose = row.id
    }
    opened = true
    close()
  } catch {
    if (valid()) failure.value = t('author.articleQuickSwitcher.could.not.confirm.this.article.try.again')
  } finally {
    controller.signal.removeEventListener('abort', closeChild)
    if (!opened) closeChild()
    if (action === controller) cancelAction()
  }
}

function closed() {
  if (open.value) return
  const id = focusAfterClose
  focusAfterClose = undefined
  if (id !== undefined) emit('activated', id)
}

function opened() {
  if (open.value) search.value?.focus()
}

watch([identityEpoch, credentialEpoch, () => currentSession.value?.siteSessionId], () => {
  focusAfterClose = undefined
  close()
}, { flush: 'sync' })
onMounted(() => window.addEventListener('keydown', shortcut))
onBeforeUnmount(() => { cancelAction(); window.removeEventListener('keydown', shortcut) })
defineExpose({ show, close })
</script>

<template>
  <ElButton v-if="!hideLauncher" :text="quietLauncher" :size="quietLauncher ? 'small' : undefined"
    native-type="button" :disabled="disabled" v-bind="{ 'aria-keyshortcuts': 'Control+O Meta+O' }" @click="show">
    {{ t('author.articleQuickSwitcher.quick.switch.articles') }}
  </ElButton>
  <ElDialog v-model="open" :title="t('author.articleQuickSwitcher.quick.switch.articles')" append-to-body destroy-on-close width="min(34rem, calc(100vw - 2rem))"
    top="min(12vh, 6rem)" :show-close="false" :close-on-click-modal="false" :before-close="beforeClose"
    @opened="opened" @closed="closed">
    <ElInput ref="search" v-model="keyword" :label="t('author.articleQuickSwitcher.search.draft.titles')" autocomplete="off"
      v-bind="{ role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': rows.length > 0, 'aria-controls': listId,
        'aria-activedescendant': selected ? optionId(selected.id) : undefined, maxlength: WireLimits.AuthorArticleKeywordChars }"
      @keydown="onKeys" />
    <p v-if="loading" role="status">{{ t('author.articleQuickSwitcher.loading.articles') }}</p>
    <p v-else-if="busy" role="status">{{ t('author.articleQuickSwitcher.confirming.article') }}</p>
    <p v-else-if="message" role="status">{{ message }}</p>
    <p v-if="failure" role="alert">{{ failure }}</p>
    <ul :id="listId" v-show="rows.length" class="quick-results" role="listbox" :aria-label="t('author.articleQuickSwitcher.articles')" :aria-busy="busy">
      <li v-for="(row, at) in rows" :id="optionId(row.id)" :key="row.id" role="option" :aria-selected="at === index"
        @mousedown.prevent @click="index = at; void choose(row, 'workspace')">
        <span>{{ row.title }}</span>
        <small>{{ row.state ? labels[row.state] : t('author.articleQuickSwitcher.opened') }} · {{ clock.format(row.at) }}</small>
      </li>
    </ul>
    <template #footer>
      <ElButton v-if="otherGroup" native-type="button" :disabled="!selected || busy || disabled"
        @click="selected && choose(selected, 'other-group')">{{ t('author.articleQuickSwitcher.open.in.other.group') }}</ElButton>
      <ElButton v-if="failure" native-type="button" text @click="retry++; nextTick(() => search?.focus())">{{ t('author.articleQuickSwitcher.refresh.results') }}</ElButton>
      <ElButton native-type="button" @click="close">{{ t('author.articleQuickSwitcher.cancel') }}</ElButton>
    </template>
  </ElDialog>
</template>

<style scoped>
.quick-results {
  display: grid;
  gap: var(--fsus-space-1);
  overflow: auto;
  max-block-size: min(46vh, 20rem);
  margin: var(--fsus-space-2) 0 0;
  padding: 0;
  list-style: none;
}
.quick-results [role="option"] {
  display: grid;
  gap: var(--fsus-space-1);
  padding: var(--fsus-space-2);
  border: 1px solid transparent;
  border-radius: var(--fsus-radius-control);
  cursor: pointer;
  overflow-wrap: anywhere;
}
.quick-results [aria-selected="true"] { border-color: var(--fsus-color-action-primary); }
.quick-results small { color: var(--fsus-color-text-muted); }
</style>
