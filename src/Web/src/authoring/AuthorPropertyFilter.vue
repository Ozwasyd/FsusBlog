<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElCheckbox, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import type { AuthorTextPropertySortQuery } from '../../../Contracts/author-text-search'
import { ApiError } from '../../../Contracts/client'
import {
  propertyFilterCatalog, queryPropertyArticles, setPropertyFilterable,
  type FilterCatalog, type FilterField, type PropertyComparison, type PropertyCondition, type PropertyMatches, type PropertyQuery,
} from '../../../Contracts/property-query'
import { normalizePropertyDecimal, type PropertyValue } from '../../../Contracts/property-values'
import { WireLimits } from '../../../Contracts/wire.generated'
import SavedViewPanel from './SavedViewPanel.vue'
import { credentialEpoch, currentSession, identityEpoch, invalidateSession } from '../authorSession'

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
  get 'equal'() { return t('author.authorPropertyFilter.exact.match') }, get 'less-than'() { return t('author.authorPropertyFilter.less.than') }, get 'at-most'() { return t('author.authorPropertyFilter.less.than.or.equal.to') },
  get 'greater-than'() { return t('author.authorPropertyFilter.greater.than') }, get 'at-least'() { return t('author.authorPropertyFilter.greater.than.or.equal.to') },
} as const satisfies Record<Exclude<PropertyComparison, 'is-present' | 'multi-select-any-of' | 'single-select-any-of' | 'reference-any-of'>, string>
const dateComparisons = {
  get equal() { return comparisons.equal },
  get 'less-than'() { return t('author.authorPropertyFilter.before') }, get 'at-most'() { return t('author.authorPropertyFilter.before.or.equal.to') }, get 'greater-than'() { return t('author.authorPropertyFilter.after') }, get 'at-least'() { return t('author.authorPropertyFilter.after.or.equal.to') },
}
const conditions = shallowRef<readonly PropertyCondition[]>([])
const anyOf = ref(false)
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
const sameField = computed(() => conditions.value.filter(item => item.field.id === field.value?.id))
const existingAlternatives = computed(() => sameField.value.some(item => item.anyOf))
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
    if (!load.signal.aborted) report(failure, t('author.authorPropertyFilter.property.definitions.are.temporarily.unavailable'))
  } finally {
    if (!load.signal.aborted) operationBusy.value = false
  }
}, { flush: 'sync' })

watch(selection, () => {
  mode.value = 'equal'
  anyOf.value = existingAlternatives.value
  text.value = ''
  choice.value = ''
  multiple.value = []
  flag.value = false
}, { flush: 'sync' })

watch([selection, mode, anyOf, text, choice, multiple, flag, conditions, () => props.keyword, credentialEpoch], () => {
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
    ? t('author.authorPropertyFilter.filter.fields.references.or.revisions.are.unavailable.reload.property') : fallback
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

function currentConditions(): readonly PropertyCondition[] {
  const value = operand(), active = field.value
  if (!active?.enabled || !value) throw Error('Incomplete property condition')
  const comparison = mode.value === 'missing' || mode.value === 'null' ? 'equal' : mode.value
  const alternate = sameField.value.length > 0 && (existingAlternatives.value || anyOf.value)
  if (sameField.value.some(item => item.comparison === comparison && (!alternate || JSON.stringify(item.value) === JSON.stringify(value))))
    throw Error('Repeated property condition')
  return [...conditions.value.map(item => alternate && item.field.id === active.id ? { ...item, anyOf: true } : item),
    { field: active, comparison, value, anyOf: alternate }]
}

function removeCondition(position: number) {
  const id = conditions.value[position].field.id
  const remaining = conditions.value.filter((_, index) => index !== position)
  conditions.value = remaining.filter(item => item.field.id === id).length === 1
    ? remaining.map(item => item.field.id === id && item.anyOf ? { ...item, anyOf: false } : item) : remaining
}

function canAddFacetCondition(schema: bigint, candidate: PropertyCondition): boolean {
  return !!props.embedded && !busy.value && !!catalog.value && catalog.value.revision === schema &&
    facetField.value === candidate.field && canAdd.value &&
    !conditions.value.some(item => item.field.id === candidate.field.id && (item.anyOf || item.comparison === candidate.comparison))
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
    conditions.value = currentConditions()
    selection.value = ''
    operationError.value = ''
  } catch {
    queryError.value = t('author.authorPropertyFilter.enter.a.valid.property.value.match.modes.cannot.repeat')
  }
}

function conditionText(condition: PropertyCondition) {
  const { field, comparison, value } = condition
  if (comparison === 'is-present') return t('author.authorPropertyFilter.description.value.exists', { label: field.label })
  if (value.kind === 'missing') return t('author.authorPropertyFilter.description.not.set', { label: field.label })
  if (value.kind === 'null') return t('author.authorPropertyFilter.description.explicit.null', { label: field.label })
  const names = new Map(field.options.map(option => [option.id, option.label]))
  const description = value.kind === 'multi-select' ? value.value.map(id => names.get(id)).join('、') || t('author.authorTextSearch.empty.option.set')
    : value.kind === 'single-select' ? names.get(value.value)
    : value.kind === 'article-reference' ? value.value.join('、') || t('author.authorPropertyFilter.empty.reference.set') : String(value.value)
  if (comparison === 'multi-select-any-of' || comparison === 'single-select-any-of' || comparison === 'reference-any-of')
    return t('author.authorPropertyFilter.description.any', { label: field.label, description: String(description) })
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
    if (!request.signal.aborted) report(failure, t('author.authorPropertyFilter.more.properties.are.temporarily.unavailable'))
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
    report(failure, t('author.authorPropertyFilter.could.not.confirm.property.settings.retry.the.original.operation'))
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
      const active = field.value ? currentConditions() : conditions.value
      if (active.length) filter = { schema: catalog.value.revision, conditions: active, cursor: '', keyword }
    } catch {
      queryError.value = t('author.authorPropertyFilter.enter.a.valid.property.value.match.modes.cannot.repeat')
      return
    }
  }
  if (!filter) { queryError.value = t('author.properties.enterAValidPropertyValue'); return }
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
    report(failure, t('author.authorPropertyFilter.could.not.filter.check.the.property.values.and.try'), queryError)
  } finally {
    if (queryRequest.value === request) queryRequest.value = undefined
  }
}
</script>

<template>
  <details class="property-filter" @toggle="toggle">
    <summary>{{ embedded ? t('author.authorPropertyFilter.full.text.search.property.conditions') : t('author.authorPropertyFilter.filter.by.article.properties') }}</summary>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="busy" role="status">{{ t('author.authorPropertyFilter.loading.article.properties') }}</p>
    <ElButton v-if="(error || embedded && catalog) && !busy && !pendingChange" text @click="retry++">{{ t('author.authorPropertyFilter.reload.property.definitions') }}</ElButton>
    <p v-if="catalog && !catalog.fields.length">{{ t('author.authorPropertyFilter.create.property.definitions.in.the.article.editor.first') }}</p>
    <p v-else-if="embedded && selectableFields.length">{{ t('author.authorPropertyFilter.added.conditions.will.apply.to.the.next.full') }}</p>
    <template v-if="catalog?.fields.length">
      <template v-if="embedded && textSources.length">
        <label :for="textSourceId">{{ t('author.authorPropertyFilter.search.source') }}</label>
        <ElSelect :id="textSourceId" v-model="textSourceSelection" :ariaLabel="t('author.authorPropertyFilter.search.source')" :disabled="busy">
          <ElOption value="" :label="t('author.authorPropertyFilter.article.full.text')" />
          <ElOption v-for="item in textSources" :key="item.id" :value="item.id"
            :label="`${item.label} · ${item.machineKey}`" />
        </ElSelect>
      </template>
      <template v-if="embedded && facetFields.length">
        <label :for="facetId">{{ t('author.authorPropertyFilter.property.facet.field') }}</label>
        <ElSelect :id="facetId" v-model="facetSelection" :ariaLabel="t('author.authorPropertyFilter.property.facet.field')" :disabled="busy">
          <ElOption value="" :label="t('author.authorPropertyFilter.do.not.show.property.facets')" />
          <ElOption v-for="item in facetFields" :key="item.id" :value="item.id"
            :label="`${item.label} · ${item.machineKey}`" />
        </ElSelect>
      </template>
      <template v-if="embedded && sortFields.length">
        <label :for="sortId">{{ t('author.authorPropertyFilter.property.sort.field') }}</label>
        <ElSelect :id="sortId" v-model="sortSelection" :ariaLabel="t('author.authorPropertyFilter.property.sort.field')" :disabled="busy">
          <ElOption value="" :label="t('author.authorPropertyFilter.default.search.order')" />
          <ElOption v-for="item in sortFields" :key="item.id" :value="item.id"
            :label="`${item.label} · ${item.machineKey}`" />
        </ElSelect>
        <template v-if="sortField">
          <label :for="sortDirectionId">{{ t('author.authorPropertyFilter.property.sort.direction') }}</label>
          <ElSelect :id="sortDirectionId" v-model="sortDirection" :ariaLabel="t('author.authorPropertyFilter.property.sort.direction')" :disabled="busy">
            <ElOption value="ascending" :label="t('author.authorTextSearch.ascending')" />
            <ElOption value="descending" :label="t('author.authorTextSearch.descending')" />
          </ElSelect>
        </template>
      </template>
      <p v-if="keyword">{{ t('author.authorPropertyFilter.property.results.also.match.the.applied.title.or', { p0: String(keyword) }) }}</p>
      <ul v-if="conditions.length" :aria-label="t('author.authorPropertyFilter.existing.filters')">
        <li v-for="(condition, position) in conditions" :key="`${condition.field.id}:${condition.comparison}:${position}`">
          <span>{{ conditionText(condition) }}{{ condition.anyOf ? t('author.authorPropertyFilter.match.any.within.this.field') : '' }}</span>
          <ElButton text :disabled="busy || !!pendingChange" v-bind="{ 'aria-label': t('author.authorPropertyFilter.remove.position', { position: position + 1 }) }"
            @click="removeCondition(position)">{{ t('author.authorPropertyFilter.remove') }}</ElButton>
        </li>
      </ul>
      <template v-if="selectableFields.length">
        <label :for="fieldId">{{ t('author.authorPropertyFilter.property.field') }}</label>
        <ElSelect :id="fieldId" v-model="selection" :ariaLabel="t('author.authorPropertyFilter.property.field')" :disabled="busy || !!pendingChange">
          <ElOption v-for="item in selectableFields" :key="item.id" :value="item.id"
            :label="`${item.label} · ${item.machineKey}`" />
        </ElSelect>
      </template>
      <p v-else>{{ t('author.authorPropertyFilter.no.properties.have.filtering.enabled.here') }}</p>
      <ElButton v-if="catalog.nextKey" text :disabled="busy || !!pendingChange" @click="later">{{ t('author.properties.moreProperties') }}</ElButton>
      <template v-if="field">
        <p v-if="field.deprecated">{{ t('author.authorPropertyFilter.this.property.is.disabled') }}</p>
        <ElButton v-else-if="!embedded" text :disabled="busy" @click="changeFilterability">
          {{ pendingChange ? t('author.authorPropertyFilter.retry.filter.settings') : field.enabled ? t('author.authorPropertyFilter.disable.filtering.for.this.field') : t('author.authorPropertyFilter.enable.filtering.for.this.field') }}
        </ElButton>
        <template v-if="field.enabled">
          <label :for="operatorId">{{ t('author.authorPropertyFilter.match.mode') }}</label>
          <ElSelect :id="operatorId" v-model="mode" :ariaLabel="t('author.authorPropertyFilter.match.mode')" :disabled="busy">
            <ElOption value="equal" :label="t('author.authorPropertyFilter.exact.match')" />
            <ElOption v-for="[comparison, label] in rangeComparisons" :key="comparison" :value="comparison" :label="label" />
            <ElOption v-if="field.kind === 'single-select'" value="single-select-any-of" :label="t('author.authorPropertyFilter.match.any')" />
            <ElOption v-if="field.kind === 'multi-select'" value="multi-select-any-of" :label="t('author.authorPropertyFilter.match.any')" />
            <ElOption v-if="field.kind === 'article-reference'" value="reference-any-of" :label="t('author.authorPropertyFilter.match.any')" />
            <ElOption value="is-present" :label="t('author.authorPropertyFilter.value.exists')" />
            <ElOption value="missing" :label="t('author.authorTextSearch.not.set')" />
            <ElOption value="null" :label="t('author.authorTextSearch.explicit.null')" />
          </ElSelect>
          <ElCheckbox v-if="sameField.length" :disabled="busy || existingAlternatives"
            :model-value="existingAlternatives || anyOf" @update:model-value="anyOf = $event === true">
            {{ t('author.authorPropertyFilter.match.any.existing.condition.for.this.field') }}
          </ElCheckbox>
          <template v-if="mode !== 'is-present' && mode !== 'missing' && mode !== 'null'">
            <label :for="valueId">{{ t('author.authorPropertyFilter.property.value') }}</label>
            <ElSelect v-if="field.kind === 'boolean'" :id="valueId" v-model="flag" :ariaLabel="t('author.authorPropertyFilter.property.value')" :disabled="busy">
              <ElOption :value="false" :label="t('author.authorPropertyFilter.false')" /><ElOption :value="true" :label="t('author.authorPropertyFilter.true')" />
            </ElSelect>
            <ElSelect v-else-if="field.kind === 'single-select' && mode !== 'single-select-any-of'" :id="valueId" v-model="choice"
              :ariaLabel="t('author.authorPropertyFilter.property.value')" :disabled="busy">
              <ElOption v-for="option in field.options" :key="option.id" :value="option.id" :label="option.label" />
            </ElSelect>
            <ElSelect v-else-if="field.kind === 'multi-select' || mode === 'single-select-any-of'" :id="valueId" v-model="multiple"
              :ariaLabel="t('author.authorPropertyFilter.property.value')" :disabled="busy" multiple>
              <ElOption v-for="option in field.options" :key="option.id" :value="option.id" :label="option.label" />
            </ElSelect>
            <ElInput v-else :id="valueId" v-model="text" :disabled="busy"
              :placeholder="mode === 'reference-any-of' ? t('author.authorPropertyFilter.article.ids.separated.by.commas') : field.kind === 'date' ? '2026-01-01T00:00:00.000Z' : field.kind === 'article-reference' ? t('admin.moderation.m35') : undefined" />
          </template>
          <ElButton v-if="canAdd" text
            :disabled="busy || !!pendingChange" @click="add">{{ t('author.authorPropertyFilter.add.condition') }}</ElButton>
        </template>
      </template>
      <ElButton v-if="!embedded && (field?.enabled || !field && conditions.length)" type="primary"
        :disabled="busy || !!pendingChange" @click="search()">{{ conditions.some(item => item.anyOf) || sameField.length && anyOf
          ? t('author.authorPropertyFilter.apply.conditions') : conditions.length ? t('author.authorPropertyFilter.match.all.conditions') : t('author.authorPropertyFilter.filter.properties') }}</ElButton>
      <section v-if="!embedded && result" :aria-label="t('author.authorPropertyFilter.property.filter.results')">
        <p v-if="!result.rows.length" role="status">{{ t('author.savedViewPanel.no.matching.articles') }}</p>
        <ul v-else>
          <li v-for="item in result.rows" :key="item.id">
            <RouterLink :to="{ name: 'edit', params: { id: item.id } }">{{ item.title }}</RouterLink>
          </li>
        </ul>
        <ElButton v-if="result.nextCursor" :disabled="busy" @click="search(true)">{{ t('author.savedViewPanel.more.matching.articles') }}</ElButton>
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
