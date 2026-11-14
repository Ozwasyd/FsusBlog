<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import {
  propertyFilterCatalog, queryPropertyArticles, setPropertyFilterable,
  type FilterCatalog, type PropertyMatches, type PropertyQuery,
} from '../../../Contracts/property-query'
import { normalizePropertyDecimal, type PropertyValue } from '../../../Contracts/property-values'
import { identityEpoch, invalidateSession } from '../session'

const open = ref(false)
const retry = ref(0)
const catalog = shallowRef<FilterCatalog>()
const selection = ref('')
const mode = ref<'value' | 'missing' | 'null'>('value')
const text = ref('')
const choice = ref('')
const multiple = ref<string[]>([])
const flag = ref(false)
const busy = ref(false)
const error = ref('')
const submitted = shallowRef<PropertyQuery>()
const result = shallowRef<PropertyMatches>()
const field = computed(() => catalog.value?.fields.find(item => item.id === selection.value))
const pendingChange = shallowRef<Parameters<typeof setPropertyFilterable>[0]>()
const pendingField = ref('')
let operation: AbortController | undefined

function reset() {
  operation?.abort()
  operation = undefined
  busy.value = false
  error.value = ''
  pendingChange.value = undefined
  submitted.value = undefined
  result.value = undefined
}

watch([open, identityEpoch, retry], async ([show], _, cleanup) => {
  reset()
  catalog.value = undefined
  selection.value = ''
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
  mode.value = 'value'
  text.value = ''
  choice.value = ''
  multiple.value = []
  flag.value = false
})

watch([selection, mode, text, choice, multiple, flag], clearResults, { flush: 'sync' })

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
  if (mode.value !== 'value') return { kind: mode.value }
  switch (field.value?.kind) {
    case 'text': return { kind: 'text', value: text.value }
    case 'number': return { kind: 'number', value: normalizePropertyDecimal(text.value.trim()) }
    case 'date': return { kind: 'date', value: text.value.trim() }
    case 'url': return { kind: 'url', value: text.value.trim() }
    case 'boolean': return { kind: 'boolean', value: flag.value }
    case 'single-select': return { kind: 'single-select', value: choice.value }
    case 'multi-select': return { kind: 'multi-select', value: [...multiple.value] }
    case 'article-reference': {
      if (!/^[1-9]\d{0,9}$/.test(text.value)) return
      return { kind: 'article-reference', value: [Number(text.value)] }
    }
  }
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
  if (busy.value || pendingChange.value || !catalog.value || !field.value?.enabled) return
  let filter: PropertyQuery | undefined
  if (more) {
    if (submitted.value && result.value?.nextCursor) filter = { ...submitted.value, cursor: result.value.nextCursor }
  } else {
    try {
      const value = operand()
      if (value) filter = { schema: catalog.value.revision, field: field.value, value, cursor: '' }
    } catch {
      error.value = '请输入有效的属性值。'
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
            <ElOption value="value" label="精确匹配" />
            <ElOption value="missing" label="尚未设置" />
            <ElOption value="null" label="显式空值" />
          </ElSelect>
          <template v-if="mode === 'value'">
            <label for="property-filter-value">属性值</label>
            <ElSelect v-if="field.kind === 'boolean'" id="property-filter-value" v-model="flag" ariaLabel="属性值" :disabled="busy">
              <ElOption :value="false" label="False" /><ElOption :value="true" label="True" />
            </ElSelect>
            <ElSelect v-else-if="field.kind === 'single-select'" id="property-filter-value" v-model="choice"
              ariaLabel="属性值" :disabled="busy">
              <ElOption v-for="option in field.options" :key="option.id" :value="option.id" :label="option.label" />
            </ElSelect>
            <ElSelect v-else-if="field.kind === 'multi-select'" id="property-filter-value" v-model="multiple"
              ariaLabel="属性值" :disabled="busy" multiple>
              <ElOption v-for="option in field.options" :key="option.id" :value="option.id" :label="option.label" />
            </ElSelect>
            <ElInput v-else id="property-filter-value" v-model="text" :disabled="busy"
              :placeholder="field.kind === 'date' ? '2026-01-01T00:00:00.000Z' : field.kind === 'article-reference' ? '文章 ID' : undefined" />
          </template>
          <ElButton type="primary" :disabled="busy || !!pendingChange" @click="search()">筛选属性</ElButton>
        </template>
      </template>
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
