<script setup lang="ts">
import { t, siteLocale } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ElAlert, ElButton, ElDialog, ElEmptyState, ElInput, ElOption, ElSelect, ElSkeleton, ElTag, ElTaskPageHeader } from '@ozwasyd/element-plus'
import { api, ApiError } from '../../../Contracts/client'
import { listAuthorArticles, type AuthorArticlePage, type AuthorArticleQuery, type AuthorArticleRow, type AuthorArticleState } from '../../../Contracts/author-articles'
import { taxonomyList } from '../../../Contracts/taxonomy-client'
import type { TaxonomyListItem } from '../../../Contracts/taxonomy'
import AuthorPropertyFilter from '../authoring/AuthorPropertyFilter.vue'
import AuthorTextSearch from '../authoring/AuthorTextSearch.vue'
import SavedViewPanel from '../authoring/SavedViewPanel.vue'
import { savedViewLink } from '../authoring/savedViewLink'
import { currentSession, identityEpoch, invalidateSession, refreshSession } from '../session'

const route = useRoute()
const trash = computed(() => route.name === 'article-trash')
const searchOnly = computed(() => route.name === 'article-search')
const linkedView = computed(() => {
  const link = savedViewLink(route.query)
  return link && link !== 'invalid' ? { view: link.id, viewSchema: '1' } : undefined
})
const states: Readonly<Record<AuthorArticleState, string>> = {
  get draft() { return t('author.authorArticles.draft') }, get published() { return t('author.authorArticles.published') }, get retracted() { return t('author.authorArticles.withdrawn') }, get scheduled() { return t('author.authorArticles.scheduled') }, get deleted() { return t('author.authorArticles.deleted') },
}
const stateOptions = [
  { value: '', get label() { return t('author.authorArticles.all.states') } },
  { value: 'draft', get label() { return states.draft } },
  { value: 'published', get label() { return states.published } },
  { value: 'retracted', get label() { return states.retracted } },
  { value: 'scheduled', get label() { return states.scheduled } },
] as const
const keyword = ref('')
const categoryId = ref(0)
const tagId = ref(0)
const state = ref<Exclude<AuthorArticleState, 'deleted'> | ''>('')
const filters = shallowRef<AuthorArticleQuery>({ trash: false })
const categories = shallowRef<readonly TaxonomyListItem[]>([])
const tags = shallowRef<readonly TaxonomyListItem[]>([])
const page = shallowRef<AuthorArticlePage>()
const anchors = shallowRef<readonly (number | undefined)[]>([undefined])
const pageNumber = ref(0)
const retry = ref(0)
const pending = ref(false)
const forbidden = ref(false)
const error = ref(false)
const taxonomyError = ref(false)
const checkingSession = ref(!currentSession.value)
const sessionError = ref(false)
const canRead = computed(() => currentSession.value?.canAuthor === true && !forbidden.value)
const heading = ref<HTMLElement>()
const selected = shallowRef<AuthorArticleRow>()
const changing = ref(false)
const actionNotice = shallowRef<{ text: string, type: 'success' | 'error' | 'warning' }>()
const actionLabel = computed(() => trash.value ? t('author.authorArticles.restore.article') : t('author.authorArticles.move.to.trash'))
const dateFormat = { format: (value: number | Date) => new Intl.DateTimeFormat(siteLocale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(value) }
let sessionCheck: AbortController | undefined
let changeRequest: AbortController | undefined

function formatDate(value: number) { return dateFormat.format(value) }
function isoDate(value: number) { return new Date(value).toISOString() }

function firstPage(query: AuthorArticleQuery) {
  page.value = undefined
  anchors.value = [undefined]
  pageNumber.value = 0
  filters.value = query
}

function applyFilters() {
  firstPage({
    trash: trash.value,
    keyword: keyword.value.trim() || undefined,
    match: 'title-summary',
    categoryId: categoryId.value || undefined,
    tagId: tagId.value || undefined,
    state: trash.value ? undefined : state.value || undefined,
  })
}

function resetFilters() {
  keyword.value = ''
  categoryId.value = 0
  tagId.value = 0
  state.value = ''
  applyFilters()
}

function previous() {
  if (!pending.value && page.value && pageNumber.value > 0) pageNumber.value--
}

function next() {
  if (pending.value || !page.value?.nextId) return
  anchors.value = [...anchors.value.slice(0, pageNumber.value + 1), page.value.nextId]
  pageNumber.value++
}

async function checkSession() {
  sessionCheck?.abort()
  const request = new AbortController()
  sessionCheck = request
  checkingSession.value = true
  sessionError.value = false
  try { await refreshSession(request.signal) }
  catch { if (!request.signal.aborted) sessionError.value = true }
  finally { if (!request.signal.aborted) checkingSession.value = false }
}

function selectArticle(entry: AuthorArticleRow) {
  if (!canRead.value || changing.value || selected.value) return
  actionNotice.value = undefined
  selected.value = entry
}

function closeConfirmation(visible: boolean) {
  if (!visible && !changing.value) selected.value = undefined
}

async function confirmArticleChange() {
  const entry = selected.value
  if (!entry || !canRead.value || changing.value) return
  const restore = trash.value
  const request = new AbortController()
  changeRequest = request
  changing.value = true
  try {
    const command = { id: entry.id, expectedRevision: entry.revision, idempotencyKey: crypto.randomUUID(), title: '', body: '' }
    if (restore) await api.restore(command, request.signal)
    else await api.delete(command, request.signal)
    if (request.signal.aborted) return
    actionNotice.value = { type: 'success', text: restore ? t('author.authorArticles.article.restored.continue.editing.from.the.article.list') : t('author.authorArticles.article.moved.to.trash') }
  } catch (reason) {
    if (request.signal.aborted) return
    if (reason instanceof ApiError && reason.status === 401) { invalidateSession(); return }
    if (reason instanceof ApiError && reason.status === 403) { forbidden.value = true; return }
    if (reason instanceof ApiError && (reason.status === 409 || reason.status === 404))
      actionNotice.value = { type: 'warning', text: t('author.authorArticles.the.article.state.changed.check.the.updated.list.before') }
    else actionNotice.value = { type: 'error', text: t('author.authorArticles.could.not.confirm.the.result.check.the.updated.article') }
  } finally {
    if (changeRequest === request) {
      changeRequest = undefined
      changing.value = false
      selected.value = undefined
      if (canRead.value) {
        firstPage({ ...filters.value })
        await nextTick()
        heading.value?.focus()
      }
    }
  }
}

watch([identityEpoch, trash, searchOnly], () => {
  changeRequest?.abort()
  changeRequest = undefined
  changing.value = false
  selected.value = undefined
  actionNotice.value = undefined
  error.value = false
  forbidden.value = false
  resetFilters()
}, { immediate: true, flush: 'sync' })

watch([identityEpoch, canRead, searchOnly], async (_, __, cleanup) => {
  categories.value = []
  tags.value = []
  taxonomyError.value = false
  if (!canRead.value || searchOnly.value) return
  const request = new AbortController()
  const epoch = identityEpoch.value
  cleanup(() => request.abort())
  const results = await Promise.allSettled([taxonomyList('category', request.signal), taxonomyList('tag', request.signal)])
  if (request.signal.aborted || identityEpoch.value !== epoch || !canRead.value) return
  const [categoryResult, tagResult] = results
  if (categoryResult?.status === 'fulfilled') categories.value = categoryResult.value
  if (tagResult?.status === 'fulfilled') tags.value = tagResult.value
  taxonomyError.value = results.some(result => result.status === 'rejected')
}, { immediate: true })

watch([filters, pageNumber, retry, identityEpoch, canRead, searchOnly], async (_, __, cleanup) => {
  page.value = undefined
  pending.value = false
  error.value = false
  if (!canRead.value || searchOnly.value) return
  const request = new AbortController()
  const epoch = identityEpoch.value
  cleanup(() => request.abort())
  const stillCurrent = () => !request.signal.aborted && identityEpoch.value === epoch && canRead.value &&
    (currentSession.value?.expiresAt ?? 0) > Date.now()
  pending.value = true
  try {
    const result = await listAuthorArticles({ ...filters.value, beforeId: anchors.value[pageNumber.value] }, request.signal)
    if (stillCurrent()) page.value = result
  } catch (reason) {
    if (!stillCurrent()) return
    if (reason instanceof ApiError && reason.status === 401) invalidateSession()
    else if (reason instanceof ApiError && reason.status === 403) forbidden.value = true
    else error.value = true
  } finally {
    if (stillCurrent()) pending.value = false
  }
}, { immediate: true })

onMounted(async () => {
  // The app shell also rechecks on visibility changes. Wait for its mount before confirming this entry.
  await nextTick()
  if (!currentSession.value) await checkSession()
  else checkingSession.value = false
})

onBeforeUnmount(() => {
  sessionCheck?.abort()
  changeRequest?.abort()
  changeRequest = undefined
})
</script>

<template>
  <main class="author-articles">
    <ElTaskPageHeader :title="searchOnly ? t('author.authorArticles.author.search') : trash ? t('author.authorArticles.trash') : t('author.authorArticles.article.management')" density="compact" />
    <ElAlert v-if="sessionError" :title="t('author.authorArticles.unable.to.confirm.your.login.status.right.now')" type="error" :closable="false" show-icon>
      <ElButton text @click="checkSession">{{ t('author.authorArticles.retry') }}</ElButton>
    </ElAlert>
    <ElSkeleton v-else-if="checkingSession && !currentSession" :rows="4" animated />
    <ElEmptyState v-else-if="!canRead" :title="currentSession ? t('author.authorArticles.this.account.cannot.manage.articles') : t('author.authorArticles.log.in.with.an.author.account.first')">
      <RouterLink v-if="!currentSession" :to="{ name: 'login' }">{{ t('author.authorArticles.log.in') }}</RouterLink>
    </ElEmptyState>
    <template v-else>
      <nav class="author-collection-nav" :aria-label="t('author.authorArticles.article.management.navigation')">
        <RouterLink :to="{ name: 'article-list', query: searchOnly ? linkedView : undefined }"
          :aria-current="!trash && !searchOnly ? 'page' : undefined">{{ t('author.authorArticles.article.list') }}</RouterLink>
        <RouterLink :to="{ name: 'article-search', query: linkedView }"
          :aria-current="searchOnly ? 'page' : undefined">{{ t('author.authorArticles.author.search') }}</RouterLink>
        <RouterLink :to="{ name: 'article-trash' }" :aria-current="trash ? 'page' : undefined">{{ t('author.authorArticles.trash') }}</RouterLink>
        <RouterLink v-if="!trash" :to="{ name: 'article-workspace' }">{{ t('author.authorArticles.workspace') }}</RouterLink>
        <RouterLink v-if="!trash" :to="{ name: 'write' }">{{ t('author.authorArticles.write.a.new.article') }}</RouterLink>
      </nav>
      <ElAlert v-if="actionNotice" :title="actionNotice.text" :type="actionNotice.type" :closable="false" show-icon />
      <AuthorTextSearch v-if="searchOnly" :expanded="!linkedView" />
      <SavedViewPanel v-if="searchOnly" read-only />
      <form v-else class="author-filter" :aria-label="t('author.authorArticles.filter.articles')" @submit.prevent="applyFilters">
        <div class="author-filter-fields">
          <label class="author-keyword">
            <span>{{ t('author.authorArticles.title.or.summary') }}</span>
            <ElInput v-model="keyword" :label="t('author.authorArticles.title.or.summary')" :placeholder="t('author.authorArticles.search.titles.or.summaries')" clearable />
          </label>
          <label v-if="categories.length">
            <span>{{ t('author.authorArticles.category') }}</span>
            <ElSelect v-model="categoryId" :ariaLabel="t('author.authorArticles.category')" filterable>
              <ElOption :value="0" :label="t('author.authorArticles.all.categories')" />
              <ElOption v-for="item in categories" :key="item.id" :value="item.id" :label="item.name" />
            </ElSelect>
          </label>
          <label v-if="tags.length">
            <span>{{ t('author.authorArticles.tag') }}</span>
            <ElSelect v-model="tagId" :ariaLabel="t('author.authorArticles.tag')" filterable>
              <ElOption :value="0" :label="t('author.authorArticles.all.tags')" />
              <ElOption v-for="item in tags" :key="item.id" :value="item.id" :label="item.name" />
            </ElSelect>
          </label>
          <label v-if="!trash">
            <span>{{ t('author.authorArticles.status') }}</span>
            <ElSelect v-model="state" :ariaLabel="t('author.authorArticles.status')">
              <ElOption v-for="item in stateOptions" :key="item.value" :value="item.value" :label="item.label" />
            </ElSelect>
          </label>
        </div>
        <div class="author-filter-actions">
          <ElButton type="primary" native-type="submit" :disabled="pending">{{ t('author.authorArticles.search') }}</ElButton>
          <ElButton native-type="button" :disabled="pending" @click="resetFilters">{{ t('author.authorArticles.reset') }}</ElButton>
        </div>
        <p v-if="taxonomyError" class="author-articles-note" role="status">{{ t('author.authorArticles.some.categories.or.tags.are.temporarily.unavailable') }}</p>
      </form>
      <AuthorTextSearch v-if="!trash && !searchOnly" />
      <AuthorPropertyFilter v-if="!trash && !searchOnly" :keyword="filters.keyword" />
      <section v-if="!searchOnly" aria-labelledby="author-list-heading" :aria-busy="pending">
        <header class="author-list-heading">
          <h2 id="author-list-heading" ref="heading" tabindex="-1">{{ trash ? t('author.authorArticles.deleted.articles') : t('author.authorArticles.article.list') }}</h2>
          <p v-if="page" role="status">{{ t('author.authorArticles.articles', { p0: String(page.total) }) }}</p>
        </header>
        <ElSkeleton v-if="pending" :rows="5" animated />
        <ElAlert v-else-if="error" :title="t('author.authorArticles.could.not.load.articles.try.again')" type="error" :closable="false" show-icon>
          <ElButton text @click="retry++">{{ t('author.authorArticles.retry') }}</ElButton>
        </ElAlert>
        <ElEmptyState v-else-if="!page?.items.length" :title="trash ? t('author.authorArticles.no.matching.articles.in.trash') : t('author.authorArticles.no.matching.articles')" />
        <ul v-else class="author-article-rows">
          <li v-for="entry in page.items" :key="entry.id" class="author-article-row">
            <div class="author-article-title">
              <h3>{{ entry.title }}</h3>
              <p v-if="entry.category || entry.tags.length" class="author-article-taxonomy">
                <span v-if="entry.category">{{ entry.category.name }}</span>
                <span v-for="tag in entry.tags" :key="tag.id">#{{ tag.name }}</span>
              </p>
            </div>
            <div class="author-article-meta">
              <ElTag class="author-article-state" size="small" effect="plain" disable-transitions
                :type="entry.state === 'published' ? 'success' : entry.state === 'scheduled' ? 'warning' : 'info'">{{ states[entry.state] }}</ElTag>
              <time :datetime="isoDate(entry.modifiedAt)">{{ formatDate(entry.modifiedAt) }}</time>
              <span v-if="entry.scheduledAt !== null">定于 <time :datetime="isoDate(entry.scheduledAt)">{{ formatDate(entry.scheduledAt) }}</time></span>
            </div>
            <div class="author-article-actions">
              <RouterLink v-if="!trash" :to="{ name: 'edit', params: { id: entry.id } }"
                :aria-label="t('author.authorArticles.edit.named', { title: entry.title })" class="author-article-edit">{{ t('author.authorArticles.edit') }}</RouterLink>
              <ElButton native-type="button" :disabled="changing" v-bind="{ 'aria-label': `${actionLabel} ${entry.title}` }"
                @click="selectArticle(entry)">{{ actionLabel }}</ElButton>
            </div>
          </li>
        </ul>
        <nav v-if="page && (pageNumber > 0 || page.nextId)" class="author-page-controls" :aria-label="t('author.authorArticles.article.pagination')">
          <ElButton :disabled="pageNumber === 0 || pending" @click="previous">{{ t('author.authorArticles.previous') }}</ElButton>
          <span aria-live="polite">{{ t('author.authorArticles.page', { p0: String(pageNumber + 1) }) }}</span>
          <ElButton :disabled="!page.nextId || pending" @click="next">{{ t('author.authorArticles.next') }}</ElButton>
        </nav>
      </section>
      <ElDialog :model-value="!!selected" :title="actionLabel" width="min(28rem, calc(100% - 2rem))" append-to-body
        :show-close="false" :close-on-press-escape="!changing" :close-on-click-modal="false" @update:model-value="closeConfirmation">
        <p v-if="selected" class="author-article-confirmation">「{{ selected.title }}」</p>
        <p v-if="trash">{{ t('author.authorArticles.after.restoring.you.can.continue.editing.the.article') }}</p>
        <p v-else>{{ t('author.authorArticles.moving.to.trash.withdraws.published.articles.and.retains') }}</p>
        <template #footer>
          <ElButton :disabled="changing" @click="closeConfirmation(false)">{{ t('author.authorArticles.cancel') }}</ElButton>
          <ElButton :loading="changing" :type="trash ? 'primary' : 'danger'" @click="confirmArticleChange">{{ actionLabel }}</ElButton>
        </template>
      </ElDialog>
    </template>
  </main>
</template>

<style scoped>
.author-articles { width: min(64rem, calc(100% - 2 * var(--fsusblog-page-gutter))); margin: auto; padding-block: var(--fsus-space-6) var(--fsus-space-8); }
.author-articles > * + * { margin-block-start: var(--fsus-space-5); }
.author-collection-nav, .author-filter-actions, .author-list-heading, .author-article-meta, .author-article-taxonomy, .author-page-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--fsus-space-3); }
.author-collection-nav a, .author-article-edit { display: inline-flex; align-items: center; min-height: 2.75rem; }
.author-collection-nav a[aria-current='page'] { font-weight: 700; }
.author-filter-fields { display: grid; grid-template-columns: minmax(0, 2fr) repeat(3, minmax(0, 1fr)); gap: var(--fsus-space-3); }
.author-filter-fields label { min-width: 0; display: grid; align-content: start; gap: var(--fsus-space-2); }
.author-filter-actions { margin-block-start: var(--fsus-space-3); }
.author-list-heading { justify-content: space-between; }
.author-list-heading h2 { font-size: var(--el-font-size-large); }
.author-article-rows { margin: 0; padding: 0; list-style: none; border-block-start: 1px solid var(--el-border-color-lighter); }
.author-article-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, auto) auto; align-items: center; gap: var(--fsus-space-4); padding-block: var(--fsus-space-3); border-block-end: 1px solid var(--el-border-color-lighter); }
.author-article-title, .author-article-meta { min-width: 0; overflow-wrap: anywhere; }
.author-article-title h3 { font-size: var(--el-font-size-base); margin: 0; }
.author-article-taxonomy, .author-article-meta, .author-articles-note, .author-list-heading p { color: var(--el-text-color-secondary); }
.author-article-state { color: var(--fsus-ink); }
.author-article-taxonomy { margin-block: var(--fsus-space-2) 0; }
.author-article-edit { min-width: 2.75rem; justify-content: center; }
.author-article-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: end; gap: var(--fsus-space-2); }
.author-article-confirmation { font-weight: 650; overflow-wrap: anywhere; }
.author-page-controls { justify-content: flex-end; margin-block-start: var(--fsus-space-4); }
@media (max-width: 44rem) {
  .author-filter-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .author-keyword { grid-column: 1 / -1; }
  .author-article-row { grid-template-columns: minmax(0, 1fr) auto; }
  .author-article-title { grid-column: 1 / -1; }
}
</style>
