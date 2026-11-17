<script setup lang="ts">
import { t } from '../siteLocale'
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
import {
  authorTextHeadingSearch, authorTextPropertyFacetSearch, authorTextPropertySortSearch,
  authorTextPropertyTextMixedSearch, authorTextPropertyTextQualifiedSearch, authorTextPropertyTextSearch,
  authorTextSummarySearch,
} from '../../../Contracts/author-text-ranked-client'
import type {
  AuthorTextFacetedPage, AuthorTextPropertyFacet, AuthorTextPropertySortQuery, AuthorTextQualifiedQuery, AuthorTextSearchRow,
} from '../../../Contracts/author-text-search'
import { ProtocolError } from '../../../Contracts/aeds'
import { ApiError } from '../../../Contracts/client'
import type { FilterField, PropertyCondition, PropertyQuery } from '../../../Contracts/property-query'
import { propertyApi } from '../../../Contracts/property-values'
import { WireLimits } from '../../../Contracts/wire.generated'
import { credentialEpoch, currentSession, invalidateSession } from '../session'
import AuthorPropertyFilter from './AuthorPropertyFilter.vue'
import {
  cancelEditorSourceHandoff, editorSourceHandoffKey, offerHistoricalSearchEditorHandoff, offerPropertySearchEditorHandoff, offerSearchEditorHandoff,
} from './canvasEditorHandoff'
import { canRebaseSavedBodyRevision, rebaseSavedBodyHit } from './savedBodyInsertion'
import { verifySourceMatch } from './sourceCoordinates'

const props = defineProps<{ expanded?: boolean }>()

type PropertySelection = { schema: bigint; field: FilterField }
type SortSelection = PropertySelection & { direction: AuthorTextPropertySortQuery['direction'] }
type SearchInput = Omit<AuthorTextQualifiedQuery, 'cursor'> & {
  includeHeading: boolean; mixedSources: boolean; facet?: PropertySelection; sort?: SortSelection; textSource?: PropertySelection
}
type SearchReply = AuthorTextFacetedPage & { propertyFacet?: AuthorTextPropertyFacet }
type SearchPage = SearchReply & { input: SearchInput; cursor: string; previous: readonly string[] }
type FacetBucket = { key: string; label: string; count: number; condition?: PropertyCondition }
const PreviousPageLimit = 500
const fieldLabels = { get title() { return t('author.authorTextSearch.title') }, get body() { return t('author.authorTextSearch.body') }, get summary() { return t('author.authorTextSearch.summary') }, get heading() { return t('author.authorTextSearch.heading') }, get 'property-text'() { return t('author.authorTextSearch.text.property') } } as const
const states = [
  { value: 'draft', get label() { return t('author.authorTextSearch.draft') } }, { value: 'scheduled', get label() { return t('author.authorTextSearch.scheduled') } },
  { value: 'published', get label() { return t('author.authorTextSearch.published') } }, { value: 'retracted', get label() { return t('author.authorTextSearch.withdrawn') } },
] as const

type Opening = {
  request: AbortController
  row: AuthorTextSearchRow
  token?: string
  transferred: boolean
}
type HistoricalMatch = { saved: AuthorTextSearchRow; latest: AuthorTextSearchRow; page: SearchPage }

const router = useRouter()
const details = ref<HTMLDetailsElement>()
const form = ref<HTMLFormElement>()
const queryInput = ref<InstanceType<typeof ElInput>>()
const propertyControls = ref<InstanceType<typeof AuthorPropertyFilter>>()
const query = ref('')
const updatedFrom = ref('')
const updatedUntil = ref('')
const properties = shallowRef<Pick<PropertyQuery, 'schema' | 'conditions'>>()
const facet = shallowRef<PropertySelection>()
const sort = shallowRef<SortSelection>()
const textSource = shallowRef<PropertySelection>()
const mixedSources = ref(false)
const pending = shallowRef<AbortController>()
const opening = shallowRef<Opening>()
const result = shallowRef<SearchPage>()
const historicalMatch = shallowRef<HistoricalMatch>()
const stalePage = ref(false)
const error = ref('')
const locationNotice = ref('')

function reset() {
  pending.value?.abort()
  const operation = opening.value
  operation?.request.abort()
  if (operation?.token && !operation.transferred) cancelEditorSourceHandoff(operation.token)
  pending.value = undefined
  opening.value = undefined
  result.value = undefined
  historicalMatch.value = undefined
  stalePage.value = false
  error.value = ''
  locationNotice.value = ''
}

watch([query, updatedFrom, updatedUntil, properties, facet, sort, textSource, mixedSources], reset, { flush: 'sync' })
watch(textSource, value => { if (!value) mixedSources.value = false }, { flush: 'sync' })
watch(credentialEpoch, () => {
  query.value = ''
  updatedFrom.value = ''
  updatedUntil.value = ''
  properties.value = undefined
  facet.value = undefined
  sort.value = undefined
  textSource.value = undefined
  reset()
}, { flush: 'sync' })
onBeforeUnmount(reset)

function toggle(event: Event) {
  if (!(event.currentTarget as HTMLDetailsElement).open) reset()
}

function utcMidnight(day: string): bigint | null {
  if (!day) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0000')) throw new Error('Invalid UTC day')
  const iso = `${day}T00:00:00.000Z`
  const milliseconds = Date.parse(iso)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== iso) throw new Error('Invalid UTC day')
  return BigInt(milliseconds)
}

function usesHeadingQualifier(text: string): boolean {
  const query = text.toLowerCase()
  let quoted = false
  let clauseStart = true
  for (let index = 0; index < query.length; index++) {
    const character = query[index]
    if (quoted) {
      if (character === '\\') index++
      else if (character === '"') quoted = false
    } else if (character === '"') {
      quoted = true
      clauseStart = false
    } else if (/\p{White_Space}/u.test(character)) {
      clauseStart = true
    } else {
      if (clauseStart && query.startsWith('field.heading:', index)) return true
      clauseStart = false
    }
  }
  return false
}

function search() {
  if (pending.value || opening.value) return
  let from: bigint | null, until: bigint | null
  try {
    from = utcMidnight(updatedFrom.value)
    until = utcMidnight(updatedUntil.value)
    if (from !== null && until !== null && from >= until) throw new Error('Invalid UTC interval')
  } catch {
    error.value = t('author.authorTextSearch.enter.valid.utc.dates.the.start.date.must.precede')
    return
  }
  const text = query.value.trim()
  const includeHeading = usesHeadingQualifier(text)
  if (textSource.value && !mixedSources.value && includeHeading) {
    error.value = t('author.authorTextSearch.switch.to.article.full.text.search.to.use.heading')
    return
  }
  return loadPage({
    query: text, includeHeading, mixedSources: mixedSources.value, updatedFromUnixMs: from, updatedUntilUnixMs: until,
    schema: properties.value?.schema ?? 0n, conditions: properties.value?.conditions ?? [],
    facet: facet.value, sort: sort.value, textSource: textSource.value,
  }, '', [], false)
}

async function readPage({ includeHeading, mixedSources, facet, sort, textSource, ...input }: SearchInput, cursor: string, session: string,
  signal: AbortSignal): Promise<SearchReply> {
  const selectedProperty = textSource ?? sort ?? facet
  if (!selectedProperty) {
    const read = includeHeading ? authorTextHeadingSearch : authorTextSummarySearch
    return read({ ...input, cursor }, session, signal)
  }
  const { schema } = selectedProperty
  if ((input.schema && input.schema !== schema) || (facet && facet.schema !== schema) || (sort && sort.schema !== schema))
    throw new ProtocolError('Inconsistent property catalog revision')
  const search = { ...input, schema, cursor }
  const selection = { definitionId: selectedProperty.field.id, definitionRevision: selectedProperty.field.revision }
  const facetSelection = facet ? { definitionId: facet.field.id, definitionRevision: facet.field.revision } : null
  let page
  if (textSource) {
    if (!mixedSources && !facet && !sort) return authorTextPropertyTextSearch({ search, ...selection }, session, signal)
    const selectedQuery = { search, ...selection, facet: facetSelection,
      sort: sort ? { definitionId: sort.field.id, definitionRevision: sort.field.revision, direction: sort.direction } : null }
    page = mixedSources ? await authorTextPropertyTextMixedSearch({ ...selectedQuery, includeHeading }, session, signal)
      : await authorTextPropertyTextQualifiedSearch(selectedQuery, session, signal)
  } else if (sort) {
    page = await authorTextPropertySortSearch({ search, includeHeading, ...selection, direction: sort.direction,
      facet: facetSelection }, session, signal)
  } else {
    page = await authorTextPropertyFacetSearch({ search, includeHeading, ...selection }, session, signal)
  }
  if (!facet || !page.search.ready) return page.search
  const { field } = facet
  const matched = page.facet
  if (!matched || matched.definitionId !== field.id || matched.definitionRevision !== field.revision || matched.kind !== field.kind)
    throw new ProtocolError('Unexpected property facet coordinates')
  if (matched.kind !== 'boolean') {
    const optionIds = new Set(field.options.map(option => option.id))
    if (matched.buckets.length !== optionIds.size ||
      !matched.buckets.every(bucket => bucket.value.kind === 'single-select' && optionIds.delete(bucket.value.value)))
      throw new ProtocolError('Unexpected property facet options')
  }
  return { ...page.search, propertyFacet: matched }
}

function facetBuckets(page: SearchPage): FacetBucket[] {
  const counts = page.propertyFacet
  const field = page.input.facet?.field
  if (!counts || !field) return []
  const buckets: FacetBucket[] = [
    { key: 'missing', label: t('author.authorTextSearch.not.set'), count: counts.missing,
      condition: { field, comparison: 'equal', value: { kind: 'missing' } } },
    { key: 'null', label: t('author.authorTextSearch.explicit.null'), count: counts.null,
      condition: { field, comparison: 'equal', value: { kind: 'null' } } },
  ]
  // The catalog does not expose whether whole-set equality normalizes an empty set to null.
  if (counts.kind === 'multi-select') buckets.push({ key: 'empty', label: t('author.authorTextSearch.empty.option.set'), count: counts.empty })
  for (const { value, count } of counts.buckets) {
    if (value.kind === 'boolean') {
      buckets.push({ key: String(value.value), label: value.value ? t('author.authorTextSearch.yes') : t('author.authorTextSearch.no'), count,
        condition: { field, comparison: 'equal', value } })
    } else {
      const option = field.options.find(item => item.id === value.value)
      if (!option) continue
      const condition: PropertyCondition = counts.kind === 'multi-select'
        ? { field, comparison: 'multi-select-any-of', value: { kind: 'multi-select', value: [value.value] } }
        : { field, comparison: 'equal', value }
      buckets.push({ key: option.id, label: option.label, count, condition })
    }
  }
  return buckets
}

function canUseBucket(page: SearchPage, bucket: FacetBucket): boolean {
  return !!page.input.facet && !!bucket.condition && bucket.count > 0 &&
    !!propertyControls.value?.canAddFacetCondition(page.input.facet.schema, bucket.condition)
}

function applyBucket(page: SearchPage, bucket: FacetBucket) {
  if (result.value !== page || pending.value || opening.value || !canUseBucket(page, bucket) ||
    !page.input.facet || !bucket.condition || !propertyControls.value?.addFacetCondition(page.input.facet.schema, bucket.condition)) return
  void queryInput.value?.focus()
  void search()
}

function queryAvailabilityError(input: SearchInput, failure: unknown): string | undefined {
  if (!(failure instanceof ApiError)) return
  if (input.includeHeading && failure.status === 422) return t('author.authorTextSearch.some.articles.exceed.the.heading.parsing.limit.you.can')
  if (input.textSource && (failure.status === 404 || failure.status === 409))
    return input.facet || input.sort ? t('author.authorTextSearch.the.text.property.source.sort.or.facet.is.no')
      : t('author.authorTextSearch.the.text.property.source.is.no.longer.valid.reload')
  if (input.sort && (failure.status === 404 || failure.status === 409))
    return input.facet ? t('author.authorTextSearch.the.property.sort.or.facet.is.no.longer.valid') : t('author.authorTextSearch.the.property.sort.is.no.longer.valid.reload.property')
  if (input.facet && (failure.status === 404 || failure.status === 409))
    return t('author.authorTextSearch.the.property.facet.is.no.longer.valid.reload.property')
  if (input.conditions.length > 0 && (failure.status === 404 || failure.status === 409))
    return t('author.authorTextSearch.property.conditions.are.no.longer.valid.reload.property.definitions')
}

function showNextPage() {
  const page = result.value
  if (!page?.ready || !page.nextCursor) return
  return loadPage(page.input, page.nextCursor, [...page.previous.slice(1 - PreviousPageLimit), page.cursor], true)
}

function showPreviousPage() {
  const page = result.value
  const cursor = page?.previous.at(-1)
  if (!page?.ready || cursor === undefined) return
  return loadPage(page.input, cursor, page.previous.slice(0, -1), true)
}

function expirePage() {
  result.value = undefined
  historicalMatch.value = undefined
  error.value = ''
  locationNotice.value = ''
  stalePage.value = true
  void nextTick(() => {
    if (stalePage.value && details.value?.open) form.value?.querySelector<HTMLButtonElement>('button[type=submit]')?.focus()
  })
}

async function loadPage(input: SearchInput, cursor: string, previous: readonly string[], paging: boolean) {
  const session = currentSession.value
  const text = input.query
  if (!text || pending.value || opening.value || !details.value?.open || !session?.canAuthor ||
    !session.siteSessionId || session.expiresAt <= Date.now()) return
  const handle = session.siteSessionId
  const epoch = credentialEpoch.value
  const request = new AbortController()
  pending.value = request
  if (!paging) result.value = undefined
  historicalMatch.value = undefined
  stalePage.value = false
  error.value = ''
  locationNotice.value = ''
  const current = () => {
    const live = currentSession.value
    return pending.value === request && !request.signal.aborted && details.value?.open &&
      query.value.trim() === text && credentialEpoch.value === epoch && live?.canAuthor &&
      live.siteSessionId === handle && live.expiresAt > Date.now()
  }

  try {
    const response = await readPage(input, cursor, handle, request.signal)
    if (!current()) return
    if (cursor && !response.ready) { expirePage(); return }
    result.value = { ...response, input, cursor, previous }
  } catch (failure) {
    if (!current()) return
    if (failure instanceof ApiError && failure.status === 401) { invalidateSession(); return }
    if (cursor && failure instanceof ApiError && failure.status === 409) { expirePage(); return }
    const availabilityError = queryAvailabilityError(input, failure)
    if (availabilityError) {
      result.value = undefined
      error.value = availabilityError
      return
    }
    error.value = failure instanceof ApiError && failure.status === 400
      ? t('author.authorTextSearch.invalid.search.syntax.check.keywords.quotes.and.filters') : t('author.authorTextSearch.could.not.complete.full.text.search.try.again')
  } finally {
    if (pending.value === request) pending.value = undefined
  }
}

function sameMatch(previous: AuthorTextSearchRow, fresh: AuthorTextSearchRow): boolean {
  return previous.id === fresh.id && previous.revision === fresh.revision &&
    previous.field === fresh.field && previous.title === fresh.title && previous.snippet === fresh.snippet &&
    previous.highlightStart === fresh.highlightStart && previous.highlightEnd === fresh.highlightEnd &&
    previous.sourceStart === fresh.sourceStart && previous.sourceEnd === fresh.sourceEnd &&
    previous.sourceByteStart === fresh.sourceByteStart && previous.sourceByteEnd === fresh.sourceByteEnd &&
    previous.sourceDigest.length === fresh.sourceDigest.length &&
    previous.sourceDigest.every((byte, offset) => byte === fresh.sourceDigest[offset])
}

async function openMatch(row: AuthorTextSearchRow, mode: 'current' | 'history' | 'rebase' = 'current') {
  const session = currentSession.value
  const text = query.value.trim()
  const page = result.value
  const origin = router.currentRoute.value
  const now = Date.now()
  const earlier = mode !== 'current' ? historicalMatch.value : undefined
  const expected = earlier?.latest ?? row
  if (!text || pending.value || opening.value || !page?.ready || !page.rows.includes(expected) ||
    mode !== 'current' && (earlier?.saved !== row || earlier.page !== page) ||
    mode === 'rebase' && (row.field !== 'body' || !canRebaseSavedBodyRevision(row.revision, expected.revision)) ||
    !details.value?.open || !session?.canAuthor || !session.siteSessionId || session.expiresAt <= now) return

  const handle = session.siteSessionId
  const epoch = credentialEpoch.value
  const operation: Opening = { request: new AbortController(), row, transferred: false }
  opening.value = operation
  if (!earlier) historicalMatch.value = undefined
  locationNotice.value = ''
  const signal = AbortSignal.any([operation.request.signal, AbortSignal.timeout(Math.min(10_000, session.expiresAt - now))])
  const eligible = () => {
    const live = currentSession.value
    return opening.value === operation && !operation.request.signal.aborted && details.value?.open &&
      result.value === page && query.value.trim() === text &&
      credentialEpoch.value === epoch && live?.canAuthor && live.siteSessionId === handle && live.expiresAt > Date.now()
  }
  const current = () => eligible() && router.currentRoute.value === origin
  const revoke = () => {
    if (operation.token && !operation.transferred) cancelEditorSourceHandoff(operation.token)
  }
  signal.addEventListener('abort', revoke, { once: true })

  try {
    const fresh = await readPage(page.input, page.cursor, handle, signal)
    if (!current()) return
    signal.throwIfAborted()
    const confirmed = fresh.ready ? fresh.rows.find(candidate => sameMatch(expected, candidate)) : undefined
    if (!confirmed) {
      if (page.cursor && !fresh.ready) { expirePage(); return }
      const next = { ...fresh, input: page.input, cursor: page.cursor, previous: page.previous }
      result.value = next
      historicalMatch.value = undefined
      if (fresh.ready) {
        locationNotice.value = t('author.authorTextSearch.the.original.match.changed.or.is.unavailable.results.were')
        const latest = fresh.rows.find(candidate => candidate.id === row.id && candidate.revision > row.revision)
        if (!earlier && latest && row.field !== 'property-text') historicalMatch.value = { saved: row, latest, page: next }
      }
      return
    }

    const match = earlier?.saved ?? confirmed
    const position = {
      articleId: match.id,
      revision: match.revision,
      sourceStart: match.sourceStart,
      sourceEnd: match.sourceEnd,
      sourceByteStart: match.sourceByteStart,
      sourceByteEnd: match.sourceByteEnd,
      sourceDigest: match.sourceDigest.slice(),
      match: match.snippet.slice(match.highlightStart, match.highlightEnd),
    }
    let token: string
    if (match.field === 'property-text') {
      const selected = page.input.textSource
      if (!selected || mode !== 'current') throw new ProtocolError('Missing exact text property selection')
      const source = {
        articleId: match.id, articleRevision: match.revision, schemaRevision: selected.schema,
        definitionId: selected.field.id, definitionRevision: selected.field.revision,
        sourceDigest: position.sourceDigest, valueRevision: 0n,
      }
      const pinned = await propertyApi.textHit(source, handle, signal)
      if (!current()) return
      signal.throwIfAborted()
      const value = pinned.fields[0]?.value
      if (value?.kind !== 'text' || !await verifySourceMatch(value.value, position))
        throw new ProtocolError('Saved text property does not match the search source')
      if (!current()) return
      signal.throwIfAborted()
      token = offerPropertySearchEditorHandoff({ ...position, schemaRevision: source.schemaRevision,
        definitionId: source.definitionId, definitionRevision: source.definitionRevision, valueRevision: pinned.valueRevision }, epoch, handle)
    } else {
      const target = { ...position, field: match.field }
      if (mode === 'rebase') {
        const rebased = await rebaseSavedBodyHit(target, confirmed.revision, handle, signal)
        if (!current()) return
        signal.throwIfAborted()
        if (!rebased) {
          locationNotice.value = t('author.authorTextSearch.this.match.has.no.cross.revision.edit.history.you')
          return
        }
        token = offerSearchEditorHandoff(rebased, epoch, handle)
      } else {
        token = earlier ? offerHistoricalSearchEditorHandoff(target, confirmed.revision, epoch, handle)
          : offerSearchEditorHandoff(target, epoch, handle)
      }
    }
    operation.token = token
    // The router commits history state before running afterEach and before the view unmounts.
    const stop = router.afterEach((to, from, failure) => {
      if (!failure && from === origin && to.name === 'edit' && String(to.params.id) === String(confirmed.id) &&
        history.state?.[editorSourceHandoffKey] === token && !signal.aborted && eligible())
        operation.transferred = true
    })
    try {
      const failure = await router.push({
        name: 'edit', params: { id: confirmed.id }, state: { articleWorkspace: true, [editorSourceHandoffKey]: token },
      })
      if (failure && current()) locationNotice.value = t('author.authorTextSearch.could.not.open.the.editor.select.the.match.again')
    } finally {
      stop()
    }
  } catch (failure) {
    if (!current()) return
    if (operation.token) {
      locationNotice.value = t('author.authorTextSearch.could.not.open.the.editor.select.the.match.again')
      return
    }
    if (page.cursor && failure instanceof ApiError && failure.status === 409) { expirePage(); return }
    result.value = undefined
    historicalMatch.value = undefined
    if (failure instanceof ApiError && failure.status === 401) { invalidateSession(); return }
    locationNotice.value = queryAvailabilityError(page.input, failure) ?? t('author.authorTextSearch.could.not.recheck.this.match.search.again.before.locating')
  } finally {
    signal.removeEventListener('abort', revoke)
    revoke()
    if (opening.value === operation) opening.value = undefined
  }
}
</script>

<template>
  <details ref="details" class="author-text-search" :open="props.expanded" @toggle="toggle">
    <summary>{{ t('author.authorTextSearch.author.full.text.search') }}</summary>
    <form ref="form" :aria-label="t('author.authorTextSearch.author.full.text.search')" @submit.prevent="search">
      <p id="author-text-search-help">
        可组合关键词和英文双引号短语。
        <template v-if="!textSource || mixedSources">
          用 <code>field.title:</code> 限定标题、<code>field.markdown-body:</code> 限定正文，
          <code>field.summary:</code> 限定摘要，<code>field.heading:</code> 限定章节标题。
          <template v-if="mixedSources">添加 <code>field.property:</code> 限定所选文本属性。两类字段各需一个词或短语。</template>
        </template>
        <template v-else>{{ t('author.authorTextSearch.keywords.match.only.the.selected.text.property') }}</template>
        可追加 <code>status:draft</code>、<code>category:12</code>、<code>tag:34</code> 筛选。
      </p>
      <ElInput ref="queryInput" v-model="query" :label="t('author.authorTextSearch.full.text.search.terms')" clearable
        v-bind="{ maxlength: WireLimits.AuthorTextSearchQueryChars, 'aria-describedby': 'author-text-search-help' }" />
      <fieldset class="author-text-search-dates">
        <legend>{{ t('author.authorTextSearch.updated.time.utc') }}</legend>
        <ElInput v-model="updatedFrom" type="date" :label="t('author.authorTextSearch.updated.from.inclusive')" />
        <ElInput v-model="updatedUntil" type="date" :label="t('author.authorTextSearch.updated.before.exclusive')" />
      </fieldset>
      <AuthorPropertyFilter ref="propertyControls" embedded @conditions-change="properties = $event"
        @facet-change="facet = $event" @sort-change="sort = $event" @text-source-change="textSource = $event" @edit="reset" />
      <ElCheckbox v-if="textSource" :model-value="mixedSources" @update:model-value="mixedSources = $event === true">
        {{ t('author.authorTextSearch.also.match.article.fields') }}
      </ElCheckbox>
      <ElButton type="primary" native-type="submit" :disabled="!!pending || !!opening || !query.trim()">
        {{ stalePage ? t('author.authorTextSearch.back.to.first.page') : result?.ready === false ? t('author.authorTextSearch.continue.search') : error && !result ? t('author.authorTextSearch.retry.search') : t('author.authorTextSearch.search.full.text') }}
      </ElButton>
    </form>
    <p v-if="opening" role="status">{{ t('author.authorTextSearch.rechecking.match.locations', { p0: String(fieldLabels[opening.row.field]) }) }}</p>
    <p v-else-if="locationNotice" role="status">{{ locationNotice }}</p>
    <ElButton v-if="historicalMatch" text native-type="button" v-bind="{ 'aria-disabled': !!opening }"
      @click="openMatch(historicalMatch.saved, 'history')">{{ t('author.authorTextSearch.view.matches.in.the.original.saved.revision') }}</ElButton>
    <ElButton v-if="historicalMatch?.saved.field === 'body' && canRebaseSavedBodyRevision(historicalMatch.saved.revision, historicalMatch.latest.revision)"
      text native-type="button" v-bind="{ 'aria-disabled': !!opening }"
      @click="openMatch(historicalMatch.saved, 'rebase')">{{ t('author.authorTextSearch.locate.again.in.the.new.revision') }}</ElButton>
    <p v-if="pending" role="status">{{ t('author.authorTextSearch.searching.full.text') }}</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="stalePage" role="status">{{ t('author.authorTextSearch.search.results.have.changed.search.again.from.the') }}</p>
    <p v-else-if="result?.ready === false" role="status">{{ t('author.authorTextSearch.the.index.is.updating.select.continue.search.to') }}</p>
    <section v-if="result?.ready" :aria-label="t('author.authorTextSearch.full.text.search.results')" :aria-busy="!!pending || !!opening">
      <p role="status">{{ t('author.authorTextSearch.articles', { p0: String(result.total) }) }}</p>
      <p v-if="result.input.sort">
        按 <span dir="auto">{{ result.input.sort.field.label }}</span> {{ result.input.sort.direction === 'ascending' ? t('author.authorTextSearch.ascending') : t('author.authorTextSearch.descending') }}
      </p>
      <div v-if="result.total" class="author-text-search-facets">
        <dl :aria-label="t('author.authorTextSearch.status.facets')">
          <div v-for="(state, index) in states" :key="state.value">
            <dt>{{ state.label }} <code>status:{{ state.value }}</code></dt>
            <dd>{{ result.stateCounts[index] }}</dd>
          </div>
        </dl>
        <template v-for="facet in [
          { label: '分类', key: 'category', items: result.categories, more: result.moreCategories },
          { label: '标签', key: 'tag', items: result.tags, more: result.moreTags },
        ]" :key="facet.key">
          <section v-if="facet.items.length" :aria-label="t('author.authorTextSearch.named.facet', { label: facet.label })">
            <h3>{{ facet.label }}</h3>
            <dl>
              <div v-for="item in facet.items" :key="item.id">
                <dt><span dir="auto">{{ item.name }}</span> <code>{{ facet.key }}:{{ item.id }}</code></dt>
                <dd>{{ item.count }}</dd>
              </div>
            </dl>
            <p v-if="facet.more">{{ t('author.authorTextSearch.there.are.other', { p0: String(facet.label) }) }}</p>
          </section>
        </template>
      </div>
      <section v-if="result.propertyFacet" class="author-text-search-facets" :aria-label="t('author.authorTextSearch.property.facets')">
        <h3 dir="auto">{{ result.input.facet?.field.label }}</h3>
        <p v-if="result.propertyFacet.kind === 'multi-select'">{{ t('author.authorTextSearch.an.article.may.count.toward.multiple.options') }}</p>
        <dl>
          <div v-for="bucket in facetBuckets(result)" :key="bucket.key">
            <dt>
              <ElButton v-if="canUseBucket(result, bucket)" text native-type="button" :disabled="!!pending || !!opening"
                v-bind="{ 'aria-label': t('author.authorTextSearch.filter.value', { label: bucket.label }) }" @click="applyBucket(result, bucket)">
                <span dir="auto">{{ bucket.label }}</span>
              </ElButton>
              <span v-else dir="auto">{{ bucket.label }}</span>
            </dt>
            <dd>{{ bucket.count }}</dd>
          </div>
        </dl>
      </section>
      <p v-if="!result.rows.length" role="status">{{ t('author.authorTextSearch.no.matching.articles') }}</p>
      <ul v-else>
        <li v-for="row in result.rows" :key="`${row.id}:${row.field}`">
          <RouterLink :to="{ name: 'edit', params: { id: row.id } }" dir="auto">{{ row.title }}</RouterLink>
          <span class="author-text-search-field" dir="auto">{{ row.field === 'property-text'
            ? result.input.textSource?.field.label : fieldLabels[row.field] }}</span>
          <p class="author-text-search-snippet" dir="auto">{{ row.snippet.slice(0, row.highlightStart) }}<mark>{{ row.snippet.slice(row.highlightStart, row.highlightEnd) }}</mark>{{ row.snippet.slice(row.highlightEnd) }}</p>
          <ElButton text native-type="button"
            v-bind="{ 'aria-disabled': !!pending || !!opening }" @click="openMatch(row)">
            {{ t('author.authorTextSearch.jump.to.match') }}
          </ElButton>
        </li>
      </ul>
      <nav v-if="result.previous.length || result.nextCursor" :aria-label="t('author.authorTextSearch.full.text.search.pagination')">
        <ElButton native-type="button" text v-bind="{ 'aria-disabled': !!pending || !!opening || !result.previous.length }"
          @click="showPreviousPage">{{ t('author.authorTextSearch.previous') }}</ElButton>
        <ElButton native-type="button" text v-bind="{ 'aria-disabled': !!pending || !!opening || !result.nextCursor }"
          @click="showNextPage">{{ t('author.authorTextSearch.next') }}</ElButton>
      </nav>
    </section>
  </details>
</template>

<style scoped>
.author-text-search { max-inline-size: 34rem; }
.author-text-search summary { cursor: pointer; }
.author-text-search form { display: grid; gap: var(--fsus-space-2); justify-items: start; }
.author-text-search form > p { margin-block-end: 0; }
.author-text-search-dates { display: grid; gap: var(--fsus-space-2); min-inline-size: 0; }
.author-text-search ul { display: grid; gap: var(--fsus-space-3); padding-inline-start: 1.25rem; }
.author-text-search li, .author-text-search-facets dt { overflow-wrap: anywhere; }
.author-text-search-facets dl { display: grid; gap: var(--fsus-space-1); }
.author-text-search-facets dl div { display: flex; justify-content: space-between; gap: var(--fsus-space-2); }
.author-text-search-facets dd { margin: 0; font-variant-numeric: tabular-nums; }
.author-text-search nav { display: flex; flex-wrap: wrap; gap: var(--fsus-space-2); }
.author-text-search nav :deep(.el-button + .el-button) { margin-inline-start: 0; }
.author-text-search-field { margin-inline-start: var(--fsus-space-2); }
.author-text-search-snippet { margin-block: var(--fsus-space-1) 0; white-space: pre-wrap; }
</style>
