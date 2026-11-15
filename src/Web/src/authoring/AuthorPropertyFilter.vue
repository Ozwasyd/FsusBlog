<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import {
  propertyFilterCatalog, queryPropertyArticles, setPropertyFilterable,
  type FilterCatalog, type PropertyComparison, type PropertyCondition, type PropertyMatches, type PropertyQuery,
} from '../../../Contracts/property-query'
import { normalizePropertyDecimal, type PropertyValue } from '../../../Contracts/property-values'
import { WireLimits } from '../../../Contracts/wire.generated'
import SavedViewPanel from './SavedViewPanel.vue'
import { identityEpoch, invalidateSession } from '../session'

const open = ref(false)
const retry = ref(0)
const catalog = shallowRef<FilterCatalog>()
const selection = ref('')
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
const text = ref('')
const choice = ref('')
const multiple = ref<string[]>([])
const flag = ref(false)
const busy = ref(false)
const error = ref('')
const submitted = shallowRef<PropertyQuery>()
const savable = computed(() => submitted.value ? { ...submitted.value, cursor: '' } : undefined)
const result = shallowRef<PropertyMatches>()
const field = computed(() => catalog.value?.fields.find(item => item.id === selection.value))
const rangeComparisons = computed(() => {
  const labels = field.value?.kind === 'date' ? dateComparisons : field.value?.kind === 'number' ? comparisons : undefined
  return labels ? Object.entries(labels).filter(([comparison]) => comparison !== 'equal') : []
})
const pendingChange = shallowRef<Parameters<typeof setPropertyFilterable>[0]>()
const pendingField = ref('')
let operation: AbortController | undefined
onBeforeUnmount(() => operation?.abort())

function reset() {
  operation?.abort()
  operation = undefined
  busy.value = false
  error.value = ''
  pendingChange.value = undefined
  conditions.value = []
  clearResults()
}

watch([open, identityEpoch, retry], async ([show, epoch], [, previousEpoch], cleanup) => {
  reset()
  catalog.value = undefined
  selection.value = ''
  if (!show || epoch !== previousEpoch) pendingField.value = ''
  if (!show) return
  const load = new AbortController()
  cleanup(() => load.abort())
  busy.value = true
  try {
    const page = await propertyFilterCatalog(load.signal)
    if (!load.signal.aborted) {
      catalog.value = page
      selection.value = page.fields.some(item => item.id === pendingField.value) ? pendingField.value : ''
      pendingField.value = ''
    }
  } catch (failure) {
    if (!load.signal.aborted) report(failure, '暂时无法读取属性定义。')
  } finally {
    if (!load.signal.aborted) busy.value = false
  }
}, { flush: 'sync' })

watch(selection, () => {
  mode.value = 'equal'
  text.value = ''
  choice.value = ''
  multiple.value = []
  flag.value = false
}, { flush: 'sync' })

watch([selection, mode, text, choice, multiple, flag, conditions], clearResults, { flush: 'sync' })

function clearResults() {
  submitted.value = undefined
  result.value = undefined
}

function toggle(event: Event) {
  open.value = (event.currentTarget as HTMLDetailsElement).open
}

function report(failure: unknown, fallback: string) {
  if (failure instanceof ApiError && failure.status === 401) invalidateSession()
  error.value = failure instanceof ApiError && [404, 409].includes(failure.status)
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
  if (conditions.value.some(item => item.field.id === active.id && item.comparison === comparison))
    throw Error('Repeated property condition')
  return { field: active, comparison, value }
}

function add() {
  if (conditions.value.length + 1 >= WireLimits.PropertyQueryConditionCount) return
  try {
    conditions.value = [...conditions.value, currentCondition()]
    selection.value = ''
    error.value = ''
  } catch {
    error.value = '请输入有效的属性值，每个字段的匹配方式不能重复。'
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
  if (!current?.nextKey || busy.value || pendingChange.value) return
  const request = operation = new AbortController()
  busy.value = true
  error.value = ''
  try {
    const next = await propertyFilterCatalog(request.signal, { key: current.nextKey, schema: current.revision })
    if (!request.signal.aborted) catalog.value = { ...next, fields: [...current.fields, ...next.fields] }
  } catch (failure) {
    if (!request.signal.aborted) report(failure, '暂时无法读取更多属性。')
  } finally {
    if (!request.signal.aborted) busy.value = false
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
  busy.value = true
  error.value = ''
  try {
    await setPropertyFilterable(input, request.signal)
    if (!request.signal.aborted) retry.value++
  } catch (failure) {
    if (request.signal.aborted) return
    if (failure instanceof ApiError && failure.status < 500) pendingChange.value = undefined
    report(failure, '无法确认属性设置。请重试原操作。')
  } finally {
    if (!request.signal.aborted) busy.value = false
  }
}

async function search(more = false) {
  if (busy.value || pendingChange.value || !catalog.value) return
  let filter: PropertyQuery | undefined
  if (more) {
    if (submitted.value && result.value?.nextCursor) filter = { ...submitted.value, cursor: result.value.nextCursor }
  } else {
    try {
      const active = field.value ? [...conditions.value, currentCondition()] : conditions.value
      if (active.length) filter = { schema: catalog.value.revision, conditions: active, cursor: '' }
    } catch {
      error.value = '请输入有效的属性值，每个字段的匹配方式不能重复。'
      return
    }
  }
  if (!filter) { error.value = '请输入有效的属性值。'; return }
  const request = operation = new AbortController()
  busy.value = true
  error.value = ''
  if (!more) result.value = undefined
  try {
    const page = await queryPropertyArticles(filter, request.signal)
    if (!request.signal.aborted) {
      submitted.value = filter
      result.value = { ...page, rows: more ? [...(result.value?.rows ?? []), ...page.rows] : page.rows }
    }
  } catch (failure) {
    if (request.signal.aborted) return
    result.value = undefined
    report(failure, '无法执行筛选。请检查属性值后重试。')
  } finally {
    if (!request.signal.aborted) busy.value = false
  }
}
</script>

<template>
  <details class="property-filter" @toggle="toggle">
    <summary>按文章属性筛选</summary>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="busy" role="status">正在读取文章属性…</p>
    <ElButton v-if="error && !busy && !pendingChange" text @click="retry++">重新加载属性定义</ElButton>
    <p v-if="catalog && !catalog.fields.length">请先在文章编辑器中创建属性定义。</p>
    <template v-if="catalog?.fields.length">
      <ul v-if="conditions.length" aria-label="已有筛选条件">
        <li v-for="(condition, position) in conditions" :key="`${condition.field.id}:${condition.comparison}`">
          <span>{{ conditionText(condition) }}</span>
          <ElButton text :disabled="busy || !!pendingChange" v-bind="{ 'aria-label': `移除第 ${position + 1} 个筛选条件` }"
            @click="conditions = conditions.filter((_, index) => index !== position)">移除</ElButton>
        </li>
      </ul>
      <label for="property-filter-field">属性字段</label>
      <ElSelect id="property-filter-field" v-model="selection" ariaLabel="属性字段" :disabled="busy || !!pendingChange">
        <ElOption v-for="item in catalog.fields" :key="item.id" :value="item.id"
          :label="`${item.label} · ${item.machineKey}`" />
      </ElSelect>
      <ElButton v-if="catalog.nextKey" text :disabled="busy || !!pendingChange" @click="later">更多属性</ElButton>
      <template v-if="field">
        <p v-if="field.deprecated">该属性已停用。</p>
        <ElButton v-else text :disabled="busy" @click="changeFilterability">
          {{ pendingChange ? '重试筛选设置' : field.enabled ? '停用此字段的筛选' : '启用此字段的筛选' }}
        </ElButton>
        <template v-if="field.enabled">
          <label for="property-filter-operator">匹配方式</label>
          <ElSelect id="property-filter-operator" v-model="mode" ariaLabel="匹配方式" :disabled="busy">
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
            <label for="property-filter-value">属性值</label>
            <ElSelect v-if="field.kind === 'boolean'" id="property-filter-value" v-model="flag" ariaLabel="属性值" :disabled="busy">
              <ElOption :value="false" label="False" /><ElOption :value="true" label="True" />
            </ElSelect>
            <ElSelect v-else-if="field.kind === 'single-select' && mode !== 'single-select-any-of'" id="property-filter-value" v-model="choice"
              ariaLabel="属性值" :disabled="busy">
              <ElOption v-for="option in field.options" :key="option.id" :value="option.id" :label="option.label" />
            </ElSelect>
            <ElSelect v-else-if="field.kind === 'multi-select' || mode === 'single-select-any-of'" id="property-filter-value" v-model="multiple"
              ariaLabel="属性值" :disabled="busy" multiple>
              <ElOption v-for="option in field.options" :key="option.id" :value="option.id" :label="option.label" />
            </ElSelect>
            <ElInput v-else id="property-filter-value" v-model="text" :disabled="busy"
              :placeholder="mode === 'reference-any-of' ? '文章 ID，用逗号分隔' : field.kind === 'date' ? '2026-01-01T00:00:00.000Z' : field.kind === 'article-reference' ? '文章 ID' : undefined" />
          </template>
          <ElButton v-if="conditions.length + 1 < WireLimits.PropertyQueryConditionCount" text
            :disabled="busy || !!pendingChange" @click="add">添加条件</ElButton>
        </template>
      </template>
      <ElButton v-if="field?.enabled || !field && conditions.length" type="primary"
        :disabled="busy || !!pendingChange" @click="search()">{{ conditions.length ? '匹配全部条件' : '筛选属性' }}</ElButton>
      <section v-if="result" aria-label="属性筛选结果">
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
  <SavedViewPanel :query="savable" />
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
