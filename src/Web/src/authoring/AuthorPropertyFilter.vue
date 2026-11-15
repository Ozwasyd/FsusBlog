<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import type { AuthorTextPropertySortQuery } from '../../../Contracts/author-text-search'
import { ApiError } from '../../../Contracts/client'
import {
  propertyFilterCatalog, queryPropertyArticles, setPropertyFilterable,
  type FilterCatalog, type FilterField, type PropertyComparison, type PropertyCondition, type PropertyMatches, type PropertyQuery,
} from '../../../Contracts/property-query'
import { normalizePropertyDecimal, type PropertyValue } from '../../../Contracts/property-values'
import { WireLimits } from '../../../Contracts/wire.generated'
import SavedViewPanel from './SavedViewPanel.vue'
import { credentialEpoch, currentSession, identityEpoch, invalidateSession } from '../session'

const props = defineProps<{ keyword?: string; embedded?: boolean }>()
const emit = defineEmits<{
  'facet-change': [value: { schema: bigint; field: FilterField } | undefined]
  'text-source-change': [value: { schema: bigint; field: FilterField } | undefined]
  'sort-change': [value: { schema: bigint; field: FilterField; direction: AuthorTextPropertySortQuery['direction'] } | undefined]
  'conditions-change': [value: Pick<PropertyQuery, 'schema' | 'conditions'> | undefined]
  edit: []
}>()
const fieldId = useId(), operatorId = useId(), valueId = useId(), facetId = useId()
const sortId = useId(), sortDirectionId = useId(), textSourceId = useId()
const embeddedCredential = computed(() => props.embedded ? credentialEpoch.value : 0)
const open = ref(false)
const retry = ref(0)
const catalog = shallowRef<FilterCatalog>()
const selection = ref('')
const facetSelection = ref('')
const textSourceSelection = ref('')
const sortSelection = ref('')
const sortDirection = ref<AuthorTextPropertySortQuery['direction']>('ascending')
const mode = ref<PropertyComparison | 'missing' | 'null'>('equal')
const comparisons = {
  'equal': '精确匹配', 'less-than': '小于', 'at-most': '小于或等于',
  'greater-than': '大于', 'at-least': '大于或等于',
} as const satisfies Record<Exclude<PropertyComparison, 'is-present' | 'multi-select-any-of' | 'single-select-any-of' | 'reference-any-of'>, string>
const dateComparisons = {
  ...comparisons,
  'less-than': '早于', 'at-most': '早于或等于', 'greater-than': '晚于', 'at-least': '晚于或等于',
}
const conditions = shallowRef<readonly PropertyCondition[]>([])
const canAdd = computed(() => conditions.value.length < WireLimits.PropertyQueryConditionCount - (props.embedded ? 0 : 1))
const text = ref('')
const choice = ref('')
const multiple = ref<string[]>([])
const flag = ref(false)
const operationBusy = ref(false)
const queryRequest = shallowRef<AbortController>()
const busy = computed(() => operationBusy.value || !!queryRequest.value)
const operationError = ref('')
const queryError = ref('')
const error = computed(() => operationError.value || queryError.value)
const submitted = shallowRef<PropertyQuery>()
const savable = computed(() => submitted.value ? { ...submitted.value, cursor: '' } : undefined)
const result = shallowRef<PropertyMatches>()
const selectableFields = computed(() => (catalog.value?.fields ?? []).filter(item => !props.embedded || item.enabled))
const field = computed(() => selectableFields.value.find(item => item.id === selection.value))
const facetFields = computed(() => selectableFields.value.filter(item => item.enabled &&
  (item.kind === 'boolean' || item.kind === 'single-select' || item.kind === 'multi-select')))
const facetField = computed(() => facetFields.value.find(item => item.id === facetSelection.value))
const textSources = computed(() => (catalog.value?.fields ?? []).filter(item => item.kind === 'text' && item.searchEligible && !item.deprecated))
const textSource = computed(() => textSources.value.find(item => item.id === textSourceSelection.value))
const sortFields = computed(() => (catalog.value?.fields ?? []).filter(item => item.sortable && !item.deprecated))
const sortField = computed(() => sortFields.value.find(item => item.id === sortSelection.value))
const rangeComparisons = computed(() => {
  const labels = field.value?.kind === 'date' ? dateComparisons : field.value?.kind === 'number' ? comparisons : undefined
  return labels ? Object.entries(labels).filter(([comparison]) => comparison !== 'equal') : []
})
const pendingChange = shallowRef<Parameters<typeof setPropertyFilterable>[0]>()
const pendingField = ref('')
let operation: AbortController | undefined
onBeforeUnmount(() => {
  operation?.abort()
  queryRequest.value?.abort()
})

function reset() {
  operation?.abort()
  operation = undefined
  operationBusy.value = false
  operationError.value = ''
  pendingChange.value = undefined
  if (conditions.value.length) conditions.value = []
  clearResults()
}

watch([open, identityEpoch, retry, embeddedCredential], async ([show, epoch, attempt, credential], [, previousEpoch, previousAttempt, previousCredential], cleanup) => {
  if (props.embedded && epoch === previousEpoch && attempt === previousAttempt && credential === previousCredential) {
    if (!show) {
      operation?.abort()
      operationBusy.value = false
      return
    }
    if (catalog.value) return
  }
  reset()
  catalog.value = undefined
  selection.value = ''
  facetSelection.value = ''
  textSourceSelection.value = ''
  sortSelection.value = ''
  sortDirection.value = 'ascending'
  if (!show || epoch !== previousEpoch) pendingField.value = ''
  const handle = props.embedded ? currentSession.value?.siteSessionId : undefined
  if (!show || props.embedded && !handle) return
  const load = new AbortController()
  cleanup(() => load.abort())
  operationBusy.value = true
  try {
    const page = await propertyFilterCatalog(load.signal, undefined, handle, props.embedded)
    if (!load.signal.aborted) {
      catalog.value = page
      selection.value = page.fields.some(item => item.id === pendingField.value) ? pendingField.value : ''
      pendingField.value = ''
    }
  } catch (failure) {
    if (!load.signal.aborted) report(failure, '暂时无法读取属性定义。')
  } finally {
    if (!load.signal.aborted) operationBusy.value = false
  }
}, { flush: 'sync' })

watch(selection, () => {
  mode.value = 'equal'
  text.value = ''
  choice.value = ''
  multiple.value = []
  flag.value = false
}, { flush: 'sync' })

watch([selection, mode, text, choice, multiple, flag, conditions, () => props.keyword, credentialEpoch], () => {
  clearResults()
  if (props.embedded) emit('edit')
}, { flush: 'sync' })
watch(conditions, value => {
  if (props.embedded) emit('conditions-change', value.length && catalog.value ? { schema: catalog.value.revision, conditions: value } : undefined)
}, { flush: 'sync' })
watch([facetField, () => catalog.value?.revision], ([field, schema]) => {
  if (props.embedded) emit('facet-change', field && schema ? { field, schema } : undefined)
}, { flush: 'sync' })
watch([textSource, () => catalog.value?.revision], ([field, schema]) => {
  if (props.embedded) emit('text-source-change', field && schema ? { field, schema } : undefined)
}, { flush: 'sync' })
watch([sortField, sortDirection, () => catalog.value?.revision], ([field, direction, schema]) => {
  if (props.embedded) emit('sort-change', field && schema ? { field, direction, schema } : undefined)
}, { flush: 'sync' })

function clearResults() {
  queryRequest.value?.abort()
  queryRequest.value = undefined
  queryError.value = ''
  submitted.value = undefined
  result.value = undefined
}

function toggle(event: Event) {
  open.value = (event.currentTarget as HTMLDetailsElement).open
}

function report(failure: unknown, fallback: string, message = operationError) {
  if (failure instanceof ApiError && failure.status === 401) { invalidateSession(); return }
  message.value = failure instanceof ApiError && [404, 409].includes(failure.status)
    ? '筛选字段、引用或修订已不可用。请重新加载属性定义。' : fallback
}

function operand(): PropertyValue | undefined {
  if (mode.value === 'is-present') return { kind: 'missing' }
  if (mode.value === 'null' || mode.value === 'missing') return { kind: mode.value }
  if (mode.value === 'single-select-any-of')
    return multiple.value.length ? { kind: 'multi-select', value: [...multiple.value] } : undefined
  switch (field.value?.kind) {
    case 'text': return { kind: 'text', value: text.value }
    case 'number': return { kind: 'number', value: normalizePropertyDecimal(text.value.trim()) }
    case 'date': return { kind: 'date', value: text.value.trim() }
    case 'url': return { kind: 'url', value: text.value.trim() }
    case 'boolean': return { kind: 'boolean', value: flag.value }
    case 'single-select': return { kind: 'single-select', value: choice.value }
    case 'multi-select': return { kind: 'multi-select', value: [...multiple.value] }
    case 'article-reference': {
      const alternatives = mode.value === 'reference-any-of'
      const input = alternatives ? text.value.trim() : text.value
      if (alternatives && !input) return { kind: 'article-reference', value: [] }
      const values = alternatives ? input.split(',', WireLimits.PropertyOptionCount + 1).map(item => item.trim()) : [input]
      if (values.length > WireLimits.PropertyOptionCount || !values.every(id => /^[1-9]\d{0,9}$/.test(id))) return
      const ids = values.map(Number)
      if (new Set(ids).size !== ids.length || ids.some(id => id > 2147483647)) return
      return { kind: 'article-reference', value: ids }
    }
  }
}

function currentCondition(): PropertyCondition {
  const value = operand(), active = field.value
  if (!active?.enabled || !value) throw Error('Incomplete property condition')
  const comparison = mode.value === 'missing' || mode.value === 'null' ? 'equal' : mode.value
  if (conditionAlreadyAdded(active, comparison))
    throw Error('Repeated property condition')
  return { field: active, comparison, value }
}

function conditionAlreadyAdded(field: FilterField, comparison: PropertyComparison): boolean {
  return conditions.value.some(item => item.field.id === field.id && item.comparison === comparison)
}

function canAddFacetCondition(schema: bigint, candidate: PropertyCondition): boolean {
  return !!props.embedded && !busy.value && !!catalog.value && catalog.value.revision === schema &&
    facetField.value === candidate.field && canAdd.value && !conditionAlreadyAdded(candidate.field, candidate.comparison)
}

function addFacetCondition(schema: bigint, candidate: PropertyCondition): boolean {
  if (!canAddFacetCondition(schema, candidate)) return false
  conditions.value = [...conditions.value, candidate]
  return true
}

defineExpose({ canAddFacetCondition, addFacetCondition })

function add() {
  if (!canAdd.value) return
  try {
    conditions.value = [...conditions.value, currentCondition()]
    selection.value = ''
    operationError.value = ''
  } catch {
    queryError.value = '请输入有效的属性值，每个字段的匹配方式不能重复。'
  }
}

function conditionText(condition: PropertyCondition) {
  const { field, comparison, value } = condition
  if (comparison === 'is-present') return `${field.label} · 值存在`
  if (value.kind === 'missing') return `${field.label} · 尚未设置`
  if (value.kind === 'null') return `${field.label} · 显式空值`
  const names = new Map(field.options.map(option => [option.id, option.label]))
  const description = value.kind === 'multi-select' ? value.value.map(id => names.get(id)).join('、') || '空选项集合'
    : value.kind === 'single-select' ? names.get(value.value)
    : value.kind === 'article-reference' ? value.value.join('、') || '空引用集合' : String(value.value)
  if (comparison === 'multi-select-any-of' || comparison === 'single-select-any-of' || comparison === 'reference-any-of')
    return `${field.label} · 任一匹配 ${description}`
  const labels = field.kind === 'date' ? dateComparisons : comparisons
  return `${field.label} · ${labels[comparison]} ${description}`
}

async function later() {
  const current = catalog.value
  const handle = props.embedded ? currentSession.value?.siteSessionId : undefined
  if (!current?.nextKey || busy.value || pendingChange.value || props.embedded && !handle) return
  const request = operation = new AbortController()
  operationBusy.value = true
  operationError.value = ''
  queryError.value = ''
  try {
    const next = await propertyFilterCatalog(request.signal, { key: current.nextKey, schema: current.revision }, handle, props.embedded)
    if (!request.signal.aborted) catalog.value = { ...next, fields: [...current.fields, ...next.fields] }
  } catch (failure) {
    if (!request.signal.aborted) report(failure, '暂时无法读取更多属性。')
  } finally {
    if (!request.signal.aborted) operationBusy.value = false
  }
}

async function changeFilterability() {
  const current = field.value
  if (!current || current.deprecated || !catalog.value || busy.value) return
  const input = pendingChange.value ??= {
    definitionId: current.id, definitionRevision: current.revision,
    schemaRevision: catalog.value.revision, requestId: crypto.randomUUID(), enabled: !current.enabled,
  }
  clearResults()
  pendingField.value = input.definitionId
  const request = operation = new AbortController()
  operationBusy.value = true
  operationError.value = ''
  try {
    await setPropertyFilterable(input, request.signal)
    if (!request.signal.aborted) retry.value++
  } catch (failure) {
    if (request.signal.aborted) return
    if (failure instanceof ApiError && failure.status < 500) pendingChange.value = undefined
    report(failure, '无法确认属性设置。请重试原操作。')
  } finally {
    if (!request.signal.aborted) operationBusy.value = false
  }
}

async function search(more = false) {
  const session = currentSession.value
  if (busy.value || pendingChange.value || !catalog.value || !session?.canAuthor ||
    !session.siteSessionId || session.expiresAt <= Date.now()) return
  const handle = session.siteSessionId
  const epoch = credentialEpoch.value
  const keyword = props.keyword
  let filter: PropertyQuery | undefined
  if (more) {
    if (submitted.value && result.value?.nextCursor) filter = { ...submitted.value, cursor: result.value.nextCursor }
  } else {
    try {
      const active = field.value ? [...conditions.value, currentCondition()] : conditions.value
      if (active.length) filter = { schema: catalog.value.revision, conditions: active, cursor: '', keyword }
    } catch {
      queryError.value = '请输入有效的属性值，每个字段的匹配方式不能重复。'
      return
    }
  }
  if (!filter) { queryError.value = '请输入有效的属性值。'; return }
  const request = new AbortController()
  queryRequest.value = request
  const current = () => queryRequest.value === request && !request.signal.aborted && credentialEpoch.value === epoch &&
    currentSession.value?.siteSessionId === handle && (currentSession.value?.expiresAt ?? 0) > Date.now() && props.keyword === keyword
  operationError.value = ''
  queryError.value = ''
  if (!more) result.value = undefined
  try {
    const page = await queryPropertyArticles(filter, request.signal, handle)
    if (current()) {
      submitted.value = filter
      result.value = { ...page, rows: more ? [...(result.value?.rows ?? []), ...page.rows] : page.rows }
    }
  } catch (failure) {
    if (!current()) return
    result.value = undefined
    report(failure, '无法执行筛选。请检查属性值后重试。', queryError)
  } finally {
    if (queryRequest.value === request) queryRequest.value = undefined
  }
}
</script>

<template>
  <details class="property-filter" @toggle="toggle">
    <summary>{{ embedded ? '全文搜索属性条件' : '按文章属性筛选' }}</summary>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="busy" role="status">正在读取文章属性…</p>
    <ElButton v-if="(error || embedded && catalog) && !busy && !pendingChange" text @click="retry++">重新加载属性定义</ElButton>
    <p v-if="catalog && !catalog.fields.length">请先在文章编辑器中创建属性定义。</p>
    <p v-else-if="embedded && selectableFields.length">添加的条件会用于下一次全文搜索。</p>
    <template v-if="catalog?.fields.length">
      <template v-if="embedded && textSources.length">
        <label :for="textSourceId">搜索来源</label>
        <ElSelect :id="textSourceId" v-model="textSourceSelection" ariaLabel="搜索来源" :disabled="busy">
          <ElOption value="" label="文章全文" />
          <ElOption v-for="item in textSources" :key="item.id" :value="item.id"
            :label="`${item.label} · ${item.machineKey}`" />
        </ElSelect>
      </template>
      <template v-if="embedded && facetFields.length">
        <label :for="facetId">属性分面字段</label>
        <ElSelect :id="facetId" v-model="facetSelection" ariaLabel="属性分面字段" :disabled="busy">
          <ElOption value="" label="不显示属性分面" />
          <ElOption v-for="item in facetFields" :key="item.id" :value="item.id"
            :label="`${item.label} · ${item.machineKey}`" />
        </ElSelect>
      </template>
      <template v-if="embedded && sortFields.length">
        <label :for="sortId">属性排序字段</label>
        <ElSelect :id="sortId" v-model="sortSelection" ariaLabel="属性排序字段" :disabled="busy">
          <ElOption value="" label="默认搜索顺序" />
          <ElOption v-for="item in sortFields" :key="item.id" :value="item.id"
            :label="`${item.label} · ${item.machineKey}`" />
        </ElSelect>
        <template v-if="sortField">
          <label :for="sortDirectionId">属性排序方向</label>
          <ElSelect :id="sortDirectionId" v-model="sortDirection" ariaLabel="属性排序方向" :disabled="busy">
            <ElOption value="ascending" label="升序" />
            <ElOption value="descending" label="降序" />
          </ElSelect>
        </template>
      </template>
      <p v-if="keyword">属性结果同时匹配已应用的标题或摘要：{{ keyword }}</p>
      <ul v-if="conditions.length" aria-label="已有筛选条件">
        <li v-for="(condition, position) in conditions" :key="`${condition.field.id}:${condition.comparison}`">
          <span>{{ conditionText(condition) }}</span>
          <ElButton text :disabled="busy || !!pendingChange" v-bind="{ 'aria-label': `移除第 ${position + 1} 个筛选条件` }"
            @click="conditions = conditions.filter((_, index) => index !== position)">移除</ElButton>
        </li>
      </ul>
      <template v-if="selectableFields.length">
        <label :for="fieldId">属性字段</label>
        <ElSelect :id="fieldId" v-model="selection" ariaLabel="属性字段" :disabled="busy || !!pendingChange">
          <ElOption v-for="item in selectableFields" :key="item.id" :value="item.id"
            :label="`${item.label} · ${item.machineKey}`" />
        </ElSelect>
      </template>
      <p v-else>这里没有已启用筛选的属性。</p>
      <ElButton v-if="catalog.nextKey" text :disabled="busy || !!pendingChange" @click="later">更多属性</ElButton>
      <template v-if="field">
        <p v-if="field.deprecated">该属性已停用。</p>
        <ElButton v-else-if="!embedded" text :disabled="busy" @click="changeFilterability">
          {{ pendingChange ? '重试筛选设置' : field.enabled ? '停用此字段的筛选' : '启用此字段的筛选' }}
        </ElButton>
        <template v-if="field.enabled">
          <label :for="operatorId">匹配方式</label>
          <ElSelect :id="operatorId" v-model="mode" ariaLabel="匹配方式" :disabled="busy">
            <ElOption value="equal" label="精确匹配" />
            <ElOption v-for="[comparison, label] in rangeComparisons" :key="comparison" :value="comparison" :label="label" />
            <ElOption v-if="field.kind === 'single-select'" value="single-select-any-of" label="任一匹配" />
            <ElOption v-if="field.kind === 'multi-select'" value="multi-select-any-of" label="任一匹配" />
            <ElOption v-if="field.kind === 'article-reference'" value="reference-any-of" label="任一匹配" />
            <ElOption value="is-present" label="值存在" />
            <ElOption value="missing" label="尚未设置" />
            <ElOption value="null" label="显式空值" />
          </ElSelect>
          <template v-if="mode !== 'is-present' && mode !== 'missing' && mode !== 'null'">
            <label :for="valueId">属性值</label>
            <ElSelect v-if="field.kind === 'boolean'" :id="valueId" v-model="flag" ariaLabel="属性值" :disabled="busy">
              <ElOption :value="false" label="False" /><ElOption :value="true" label="True" />
            </ElSelect>
            <ElSelect v-else-if="field.kind === 'single-select' && mode !== 'single-select-any-of'" :id="valueId" v-model="choice"
              ariaLabel="属性值" :disabled="busy">
              <ElOption v-for="option in field.options" :key="option.id" :value="option.id" :label="option.label" />
            </ElSelect>
            <ElSelect v-else-if="field.kind === 'multi-select' || mode === 'single-select-any-of'" :id="valueId" v-model="multiple"
              ariaLabel="属性值" :disabled="busy" multiple>
              <ElOption v-for="option in field.options" :key="option.id" :value="option.id" :label="option.label" />
            </ElSelect>
            <ElInput v-else :id="valueId" v-model="text" :disabled="busy"
              :placeholder="mode === 'reference-any-of' ? '文章 ID，用逗号分隔' : field.kind === 'date' ? '2026-01-01T00:00:00.000Z' : field.kind === 'article-reference' ? '文章 ID' : undefined" />
          </template>
          <ElButton v-if="canAdd" text
            :disabled="busy || !!pendingChange" @click="add">添加条件</ElButton>
        </template>
      </template>
      <ElButton v-if="!embedded && (field?.enabled || !field && conditions.length)" type="primary"
        :disabled="busy || !!pendingChange" @click="search()">{{ conditions.length ? '匹配全部条件' : '筛选属性' }}</ElButton>
      <section v-if="!embedded && result" aria-label="属性筛选结果">
        <p v-if="!result.rows.length" role="status">没有匹配的文章。</p>
        <ul v-else>
          <li v-for="item in result.rows" :key="item.id">
            <RouterLink :to="{ name: 'edit', params: { id: item.id } }">{{ item.title }}</RouterLink>
          </li>
        </ul>
        <ElButton v-if="result.nextCursor" :disabled="busy" @click="search(true)">更多匹配文章</ElButton>
      </section>
    </template>
  </details>
  <SavedViewPanel v-if="!embedded" :query="savable" />
</template>

<style scoped>
.property-filter {
  display: grid;
  gap: var(--fsus-space-2);
  max-inline-size: 34rem;
}
.property-filter[open] > :not(summary) { margin-block-start: var(--fsus-space-2); }
.property-filter label { display: block; }
.property-filter summary { cursor: pointer; }
</style>
