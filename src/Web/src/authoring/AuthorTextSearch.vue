<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ElButton, ElInput } from '@ozwasyd/element-plus'
import { authorTextHeadingSearch, authorTextPropertyFacetSearch, authorTextSummarySearch } from '../../../Contracts/author-text-ranked-client'
import type {
  AuthorTextFacetedPage, AuthorTextPropertyFacet, AuthorTextQualifiedQuery, AuthorTextSearchRow,
} from '../../../Contracts/author-text-search'
import { ProtocolError } from '../../../Contracts/aeds'
import { ApiError } from '../../../Contracts/client'
import type { FilterField, PropertyCondition, PropertyQuery } from '../../../Contracts/property-query'
import { WireLimits } from '../../../Contracts/wire.generated'
import { credentialEpoch, currentSession, invalidateSession } from '../session'
import AuthorPropertyFilter from './AuthorPropertyFilter.vue'
import { cancelEditorSourceHandoff, editorSourceHandoffKey, offerHistoricalSearchEditorHandoff, offerSearchEditorHandoff } from './canvasEditorHandoff'

type FacetSelection = { schema: bigint; field: FilterField }
type SearchInput = Omit<AuthorTextQualifiedQuery, 'cursor'> & { includeHeading: boolean; facet?: FacetSelection }
type SearchReply = AuthorTextFacetedPage & { propertyFacet?: AuthorTextPropertyFacet }
type SearchPage = SearchReply & { input: SearchInput; cursor: string; previous: readonly string[] }
type FacetBucket = { key: string; label: string; count: number; condition?: PropertyCondition }
const PreviousPageLimit = 500
const fieldLabels = { title: '标题', body: '正文', summary: '摘要', heading: '章节标题' } as const
const states = [
  { value: 'draft', label: '草稿' }, { value: 'scheduled', label: '已排期' },
  { value: 'published', label: '已发布' }, { value: 'retracted', label: '已撤回' },
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
const facet = shallowRef<FacetSelection>()
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

watch([query, updatedFrom, updatedUntil, properties, facet], reset, { flush: 'sync' })
watch(credentialEpoch, () => {
  query.value = ''
  updatedFrom.value = ''
  updatedUntil.value = ''
  properties.value = undefined
  facet.value = undefined
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
    error.value = '请输入有效的 UTC 日期。起始日期必须早于截止日期。'
    return
  }
  const text = query.value.trim()
  return loadPage({
    query: text, includeHeading: usesHeadingQualifier(text), updatedFromUnixMs: from, updatedUntilUnixMs: until,
    schema: properties.value?.schema ?? 0n, conditions: properties.value?.conditions ?? [], facet: facet.value,
  }, '', [], false)
}

async function readPage({ includeHeading, facet, ...input }: SearchInput, cursor: string, session: string,
  signal: AbortSignal): Promise<SearchReply> {
  if (!facet) {
    const read = includeHeading ? authorTextHeadingSearch : authorTextSummarySearch
    return read({ ...input, cursor }, session, signal)
  }
  const { field, schema } = facet
  if (input.schema && input.schema !== schema) throw new ProtocolError('Inconsistent property catalog revision')
  const page = await authorTextPropertyFacetSearch({ search: { ...input, schema, cursor }, includeHeading,
    definitionId: field.id, definitionRevision: field.revision }, session, signal)
  if (!page.search.ready) return page.search
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
    { key: 'missing', label: '尚未设置', count: counts.missing,
      condition: { field, comparison: 'equal', value: { kind: 'missing' } } },
    { key: 'null', label: '显式空值', count: counts.null,
      condition: { field, comparison: 'equal', value: { kind: 'null' } } },
  ]
  // The catalog does not expose whether whole-set equality normalizes an empty set to null.
  if (counts.kind === 'multi-select') buckets.push({ key: 'empty', label: '空选项集合', count: counts.empty })
  for (const { value, count } of counts.buckets) {
    if (value.kind === 'boolean') {
      buckets.push({ key: String(value.value), label: value.value ? '是' : '否', count,
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
  if (input.includeHeading && failure.status === 422) return '有文章超出章节标题解析上限。仍可按标题、摘要或正文搜索。'
  if (input.facet && (failure.status === 404 || failure.status === 409))
    return '属性分面已失效。请重新加载属性定义。'
  if (input.conditions.length > 0 && (failure.status === 404 || failure.status === 409))
    return '属性条件已失效。请重新加载属性定义并添加条件。'
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
      ? '搜索词格式无效。请检查关键词、引号和筛选条件。' : '无法完成全文搜索，请重试。'
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

async function openMatch(row: AuthorTextSearchRow, historical = false) {
  const session = currentSession.value
  const text = query.value.trim()
  const page = result.value
  const origin = router.currentRoute.value
  const now = Date.now()
  const earlier = historical ? historicalMatch.value : undefined
  const expected = earlier?.latest ?? row
  if (!text || pending.value || opening.value || !page?.ready || !page.rows.includes(expected) ||
    historical && (earlier?.saved !== row || earlier.page !== page) ||
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
        locationNotice.value = '原命中已变化或不可用。搜索结果已更新，请重新选择。'
        const latest = fresh.rows.find(candidate => candidate.id === row.id && candidate.revision > row.revision)
        if (!earlier && latest) historicalMatch.value = { saved: row, latest, page: next }
      }
      return
    }

    const match = earlier?.saved ?? confirmed
    const target = {
      articleId: match.id,
      revision: match.revision,
      field: match.field,
      sourceStart: match.sourceStart,
      sourceEnd: match.sourceEnd,
      sourceByteStart: match.sourceByteStart,
      sourceByteEnd: match.sourceByteEnd,
      sourceDigest: match.sourceDigest.slice(),
      match: match.snippet.slice(match.highlightStart, match.highlightEnd),
    }
    const token = earlier ? offerHistoricalSearchEditorHandoff(target, confirmed.revision, epoch, handle)
      : offerSearchEditorHandoff(target, epoch, handle)
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
      if (failure && current()) locationNotice.value = '未能打开编辑器。请重新选择命中位置。'
    } finally {
      stop()
    }
  } catch (failure) {
    if (!current()) return
    if (operation.token) {
      locationNotice.value = '未能打开编辑器。请重新选择命中位置。'
      return
    }
    if (page.cursor && failure instanceof ApiError && failure.status === 409) { expirePage(); return }
    result.value = undefined
    historicalMatch.value = undefined
    if (failure instanceof ApiError && failure.status === 401) { invalidateSession(); return }
    locationNotice.value = queryAvailabilityError(page.input, failure) ?? '无法复查此命中。请重新搜索后再定位。'
  } finally {
    signal.removeEventListener('abort', revoke)
    revoke()
    if (opening.value === operation) opening.value = undefined
  }
}
</script>

<template>
  <details ref="details" class="author-text-search" @toggle="toggle">
    <summary>作者全文搜索</summary>
    <form ref="form" aria-label="作者全文搜索" @submit.prevent="search">
      <p id="author-text-search-help">
        可组合关键词和英文双引号短语。用 <code>field.title:</code> 限定标题、<code>field.markdown-body:</code> 限定正文，
        <code>field.summary:</code> 限定摘要，<code>field.heading:</code> 限定章节标题。
        可追加 <code>status:draft</code>、<code>category:12</code>、<code>tag:34</code> 筛选。
      </p>
      <ElInput ref="queryInput" v-model="query" label="全文搜索词" clearable
        v-bind="{ maxlength: WireLimits.AuthorTextSearchQueryChars, 'aria-describedby': 'author-text-search-help' }" />
      <fieldset class="author-text-search-dates">
        <legend>更新时间（UTC）</legend>
        <ElInput v-model="updatedFrom" type="date" label="更新起始日期（含）" />
        <ElInput v-model="updatedUntil" type="date" label="更新截止日期（不含）" />
      </fieldset>
      <AuthorPropertyFilter ref="propertyControls" embedded @conditions-change="properties = $event"
        @facet-change="facet = $event" @edit="reset" />
      <ElButton type="primary" native-type="submit" :disabled="!!pending || !!opening || !query.trim()">
        {{ stalePage ? '回到第一页' : result?.ready === false ? '继续搜索' : error && !result ? '重试搜索' : '搜索全文' }}
      </ElButton>
    </form>
    <p v-if="opening" role="status">正在复查{{ fieldLabels[opening.row.field] }}命中位置…</p>
    <p v-else-if="locationNotice" role="status">{{ locationNotice }}</p>
    <ElButton v-if="historicalMatch" text native-type="button" v-bind="{ 'aria-disabled': !!opening }"
      @click="openMatch(historicalMatch.saved, true)">查看原保存修订的命中位置</ElButton>
    <p v-if="pending" role="status">正在搜索全文…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="stalePage" role="status">搜索结果已变化，请从第一页重新搜索。</p>
    <p v-else-if="result?.ready === false" role="status">索引正在更新，选择「继续搜索」处理下一批文章。</p>
    <section v-if="result?.ready" aria-label="全文搜索结果" :aria-busy="!!pending || !!opening">
      <p role="status">共 {{ result.total }} 篇</p>
      <div v-if="result.total" class="author-text-search-facets">
        <dl aria-label="状态分面">
          <div v-for="(state, index) in states" :key="state.value">
            <dt>{{ state.label }} <code>status:{{ state.value }}</code></dt>
            <dd>{{ result.stateCounts[index] }}</dd>
          </div>
        </dl>
        <template v-for="facet in [
          { label: '分类', key: 'category', items: result.categories, more: result.moreCategories },
          { label: '标签', key: 'tag', items: result.tags, more: result.moreTags },
        ]" :key="facet.key">
          <section v-if="facet.items.length" :aria-label="`${facet.label}分面`">
            <h3>{{ facet.label }}</h3>
            <dl>
              <div v-for="item in facet.items" :key="item.id">
                <dt><span dir="auto">{{ item.name }}</span> <code>{{ facet.key }}:{{ item.id }}</code></dt>
                <dd>{{ item.count }}</dd>
              </div>
            </dl>
            <p v-if="facet.more">还有其他{{ facet.label }}。</p>
          </section>
        </template>
      </div>
      <section v-if="result.propertyFacet" class="author-text-search-facets" aria-label="属性分面">
        <h3 dir="auto">{{ result.input.facet?.field.label }}</h3>
        <p v-if="result.propertyFacet.kind === 'multi-select'">一篇文章可计入多个选项。</p>
        <dl>
          <div v-for="bucket in facetBuckets(result)" :key="bucket.key">
            <dt>
              <ElButton v-if="canUseBucket(result, bucket)" text native-type="button" :disabled="!!pending || !!opening"
                v-bind="{ 'aria-label': `按此值筛选：${bucket.label}` }" @click="applyBucket(result, bucket)">
                <span dir="auto">{{ bucket.label }}</span>
              </ElButton>
              <span v-else dir="auto">{{ bucket.label }}</span>
            </dt>
            <dd>{{ bucket.count }}</dd>
          </div>
        </dl>
      </section>
      <p v-if="!result.rows.length" role="status">没有匹配的文章。</p>
      <ul v-else>
        <li v-for="row in result.rows" :key="`${row.id}:${row.field}`">
          <RouterLink :to="{ name: 'edit', params: { id: row.id } }" dir="auto">{{ row.title }}</RouterLink>
          <span class="author-text-search-field">{{ fieldLabels[row.field] }}</span>
          <p class="author-text-search-snippet" dir="auto">{{ row.snippet.slice(0, row.highlightStart) }}<mark>{{ row.snippet.slice(row.highlightStart, row.highlightEnd) }}</mark>{{ row.snippet.slice(row.highlightEnd) }}</p>
          <ElButton text native-type="button" v-bind="{ 'aria-disabled': !!pending || !!opening }" @click="openMatch(row)">
            跳到命中位置
          </ElButton>
        </li>
      </ul>
      <nav v-if="result.previous.length || result.nextCursor" aria-label="全文搜索分页">
        <ElButton native-type="button" text v-bind="{ 'aria-disabled': !!pending || !!opening || !result.previous.length }"
          @click="showPreviousPage">上一页</ElButton>
        <ElButton native-type="button" text v-bind="{ 'aria-disabled': !!pending || !!opening || !result.nextCursor }"
          @click="showNextPage">下一页</ElButton>
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
