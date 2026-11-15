<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue'
import { ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { listAuthorArticles, type AuthorArticlePage, type AuthorArticleRow, type AuthorArticleState } from '../../../Contracts/author-articles'
import { taxonomyList } from '../../../Contracts/taxonomy-client'
import type { TaxonomyKind, TaxonomyListItem } from '../../../Contracts/taxonomy'
import { WireLimits } from '../../../Contracts/wire.generated'
import { currentSession, identityEpoch } from '../session'
import { moveLibraryFocus } from './articleLibraryKeyboard'

type Scope = Exclude<AuthorArticleState, 'deleted'> | ''
const props = defineProps<{ articleId?: number; articleRevision?: bigint; disabled: boolean }>()
const emit = defineEmits<{ open: [articleId: number, separate: boolean] }>()

const states: Record<Exclude<AuthorArticleState, 'deleted'>, string> = {
  draft: 'Draft', scheduled: 'Scheduled', published: 'Published', retracted: 'Withdrawn',
}
const filters = Object.entries(states)
const keyword = ref('')
const scope = ref<Scope>('')
const taxonomyFilters = [['category', 'Category'], ['tag', 'Tag']] as const
const taxonomy = reactive<Record<TaxonomyKind, TaxonomyListItem[]>>({ category: [], tag: [] })
const selectedTaxonomy = reactive({ category: 0, tag: 0 })
const query = shallowRef<{ keyword: string; state: Scope; category: number; tag: number; cursors: readonly (number | undefined)[] }>({
  keyword: '', state: '', category: 0, tag: 0, cursors: [undefined],
})
const page = shallowRef<AuthorArticlePage>()
const currentRow = shallowRef<AuthorArticleRow>()
const loading = ref(false)
const currentLoading = ref(false)
const failed = ref(false)
const moveFocus = ref(false)
const retry = ref(0)
const search = ref<InstanceType<typeof ElInput>>()
const results = ref<HTMLElement>()
const current = computed(() => props.articleId && props.articleId > 0 ? props.articleId : undefined)
const rows = computed(() => {
  const active = currentRow.value
  const items = page.value?.items ?? []
  if (!active) return items
  if (items.some(item => item.id === active.id)) return items.map(item => item.id === active.id ? active : item)
  return [active, ...items]
})
defineExpose({ focus: () => search.value?.focus() })

watch(identityEpoch, (_, __, cleanup) => {
  const controller = new AbortController()
  cleanup(() => controller.abort())
  for (const [kind] of taxonomyFilters) {
    taxonomy[kind] = []
    if (currentSession.value?.canAuthor) void taxonomyList(kind, controller.signal).then(items => {
      if (!controller.signal.aborted) taxonomy[kind] = items
    }, () => {})
  }
}, { immediate: true, flush: 'sync' })

watch([query, identityEpoch, () => currentSession.value?.siteSessionId, retry], async ([scope, epoch, handle], _, cleanup) => {
  page.value = undefined
  failed.value = false
  loading.value = false
  const session = currentSession.value
  if (!handle || !session?.canAuthor || session.expiresAt <= Date.now()) return
  const controller = new AbortController()
  cleanup(() => controller.abort())
  const valid = () => !controller.signal.aborted && identityEpoch.value === epoch && currentSession.value?.siteSessionId === handle
  loading.value = true
  try {
    const response = await listAuthorArticles({ trash: false, keyword: scope.keyword, state: scope.state || undefined,
      categoryId: scope.category || undefined, tagId: scope.tag || undefined, beforeId: scope.cursors.at(-1) }, controller.signal, handle)
    if (valid()) {
      page.value = response
      if (moveFocus.value) {
        moveFocus.value = false
        await nextTick()
        if (valid()) results.value?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
      }
    }
  } catch {
    if (valid()) failed.value = true
  } finally {
    if (valid()) loading.value = false
  }
}, { immediate: true, flush: 'sync' })

watch([current, () => props.articleRevision, identityEpoch, () => currentSession.value?.siteSessionId, retry], async ([id, revision, epoch, handle], _, cleanup) => {
  currentRow.value = undefined
  currentLoading.value = false
  const session = currentSession.value
  if (!id || !handle || !session?.canAuthor || session.expiresAt <= Date.now()) return
  const controller = new AbortController()
  cleanup(() => controller.abort())
  const valid = () => !controller.signal.aborted && identityEpoch.value === epoch && id === current.value &&
    props.articleRevision === revision && currentSession.value?.siteSessionId === handle
  currentLoading.value = true
  try {
    const response = await listAuthorArticles({ trash: false, articleId: id }, controller.signal, handle)
    if (valid()) currentRow.value = response.items[0]
  } catch {
    // The active article can be absent after a permission or lifecycle change.
  } finally {
    if (valid()) currentLoading.value = false
  }
}, { immediate: true, flush: 'sync' })

function applyFilters() {
  const value = keyword.value.trim()
  const { category, tag } = selectedTaxonomy
  if (value === query.value.keyword && scope.value === query.value.state && category === query.value.category &&
      tag === query.value.tag && query.value.cursors.length === 1) return
  query.value = { keyword: value, state: scope.value, category, tag, cursors: [undefined] }
}

async function movePage(next: boolean) {
  const cursor = page.value?.nextId
  const cursors = query.value.cursors
  if (loading.value || (next ? !cursor : cursors.length === 1)) return
  moveFocus.value = true
  query.value = { ...query.value, cursors: next ? [...cursors, cursor ?? undefined] : cursors.slice(0, -1) }
  await nextTick()
  search.value?.focus()
}

function openWithModifier(event: KeyboardEvent, id: number) {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || props.disabled) return
  event.preventDefault()
  emit('open', id, true)
}

function stateLabel(item: AuthorArticleRow) {
  return item.state === 'deleted' ? '' : states[item.state]
}
</script>

<template>
  <form class="library-filter" @submit.prevent="applyFilters">
    <ElInput ref="search" v-model="keyword" label="Search article titles" v-bind="{ maxlength: WireLimits.AuthorArticleKeywordChars }" />
    <label for="article-library-state">Status</label>
    <select id="article-library-state" v-model="scope">
      <option value="">All articles</option>
      <option v-for="[value, label] in filters" :key="value" :value="value">{{ label }}</option>
    </select>
    <template v-for="[kind, label] in taxonomyFilters" :key="kind">
      <ElSelect v-if="taxonomy[kind].length" v-model="selectedTaxonomy[kind]" :ariaLabel="label" filterable>
        <ElOption :value="0" :label="kind === 'category' ? 'All categories' : 'All tags'" />
        <ElOption v-for="item in taxonomy[kind]" :key="item.id" :value="item.id" :label="item.name" />
      </ElSelect>
    </template>
    <ElButton native-type="submit">Filter articles</ElButton>
  </form>
  <p v-if="loading || currentLoading" role="status">Loading articles…</p>
  <p v-if="failed" role="alert">Could not load articles.</p>
  <ElButton v-if="failed" text @click="retry++">Retry articles</ElButton>
  <p v-if="!loading && !failed && page?.items.length === 0" role="status">No matching articles.</p>
  <ul v-if="rows.length" ref="results" class="library-results" aria-label="Article results" @keydown="moveLibraryFocus($event, results)">
    <li v-for="row in rows" :key="row.id">
      <button type="button" :disabled="disabled" :aria-current="row.id === current ? 'true' : undefined"
        @click="emit('open', row.id, false)" @keydown="openWithModifier($event, row.id)">
        <span>{{ row.title }}</span><small>{{ stateLabel(row) }}</small>
      </button>
    </li>
  </ul>
  <div v-if="query.cursors.length > 1 || page?.nextId" class="library-pages">
    <ElButton text :disabled="loading || query.cursors.length === 1" @click="movePage(false)">Previous articles</ElButton>
    <ElButton text :disabled="loading || !page?.nextId" @click="movePage(true)">Next articles</ElButton>
  </div>
</template>

<style scoped>
.library-filter { display: grid; gap: var(--fsus-space-2); }
.library-filter select { min-height: var(--fsus-control-height-action); font: inherit; }
.library-results { display: grid; gap: .2rem; list-style: none; padding: 0; }
.library-results button {
  display: grid;
  gap: .2rem;
  width: 100%;
  padding: var(--fsus-space-2);
  border: 1px solid transparent;
  border-radius: var(--fsus-radius-control);
  color: var(--fsus-ink);
  background: transparent;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.library-results button[aria-current="true"] { border-color: var(--fsus-color-action-primary); }
.library-results span { overflow-wrap: anywhere; }
.library-results small { color: var(--fsus-color-text-muted); }
.library-pages { display: flex; flex-wrap: wrap; gap: var(--fsus-space-2); }
</style>
