<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElCheckboxGroup, ElInput, ElOption, ElRadio, ElRadioGroup, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import {
  normalizePropertyDecimal, propertyApi, propertyKinds,
  type EditableProperty, type PropertyKind, type PropertyOption, type PropertySchemaCommand, type PropertyValue,
  type PropertyValueCommand, type PropertyWorkspace,
} from '../../../Contracts/property-values'
import { invalidateSession } from '../session'

const props = defineProps<{ articleId: number; revision: bigint; identity: number; disabled: boolean }>()
const emit = defineEmits<{ pending: [value: boolean] }>()
const workspace = shallowRef<PropertyWorkspace>()
const busy = ref(false)
const message = ref('')
const failure = ref('')
const creating = ref(false)
const definitionName = ref('')
const definitionKey = ref('')
const definitionKind = ref<PropertyKind>('text')
const options = ref<PropertyOption[]>([])
const editing = shallowRef<EditableProperty>()
const value = ref('')
const boolean = ref<boolean | ''>('')
const selected = ref<string[]>([])
const retryCount = ref(0)
let scope = new AbortController()

type Command =
  | { kind: 'definition'; request: PropertySchemaCommand }
  | { kind: 'value'; request: PropertyValueCommand }
const retained = shallowRef<Command>()
const canRetry = ref(false)
const shouldReload = ref(false)
const mutating = ref(false)
const formTouched = ref(false)
const unsettled = computed(() => mutating.value || canRetry.value || formTouched.value)
const disabledInput = computed(() => props.disabled || busy.value || canRetry.value || shouldReload.value)
const editingDisabled = computed(() => disabledInput.value || editing.value?.deprecated === true)
const kindLabels: Record<PropertyKind, string> = {
  text: 'Text', number: 'Number', boolean: 'Boolean', date: 'Date', 'single-select': 'Single select',
  'multi-select': 'Multiple select', 'article-reference': 'Article reference', url: 'URL',
}
const isSelection = (kind: PropertyKind) => kind === 'single-select' || kind === 'multi-select'
const inputHelp = computed(() => {
  switch (editing.value?.kind) {
    case 'number': return 'Use decimal notation without an exponent.'
    case 'date': return 'Enter a date (YYYY-MM-DD, midnight UTC) or a UTC timestamp ending in Z.'
    case 'article-reference': return 'Enter the numeric ID of a readable article.'
    case 'url': return 'Enter an absolute HTTPS URL.'
    default: return ''
  }
})
watch(unsettled, active => emit('pending', active), { flush: 'sync' })

function clearEdits() {
  creating.value = false
  editing.value = undefined
  definitionKey.value = ''
  definitionName.value = ''
  definitionKind.value = 'text'
  options.value = []
  value.value = ''
  boolean.value = ''
  selected.value = []
  formTouched.value = false
}

function startDefinition() {
  clearEdits()
  creating.value = true
  failure.value = ''
  message.value = ''
}

function newOption() {
  return { id: crypto.randomUUID(), label: '' }
}

function setKind(kind: unknown) {
  const accepted = propertyKinds.find(item => item === kind)
  if (!accepted || accepted === definitionKind.value) return
  definitionKind.value = accepted
  if (isSelection(accepted) && !options.value.length) options.value = [newOption()]
  formTouched.value = true
}

function addOption() {
  if (options.value.length >= 32) return
  options.value.push(newOption())
  formTouched.value = true
}

function removeOption(id: string) {
  options.value = options.value.filter(option => option.id !== id)
  formTouched.value = true
}

function setBoolean(answer: unknown) {
  if (typeof answer !== 'boolean') return
  boolean.value = answer
  formTouched.value = true
}

function selectOne(answer: unknown) {
  if (typeof answer !== 'string') return
  selected.value = [answer]
  formTouched.value = true
}

function selectMany(answers: readonly (string | number)[]) {
  selected.value = answers.filter((item): item is string => typeof item === 'string')
  formTouched.value = true
}

function failureMessage(cause: unknown) {
  if (!(cause instanceof ApiError)) return 'The server did not confirm the request.'
  if (cause.status === 401) {
    invalidateSession()
    return 'Log in again to edit properties.'
  }
  if (cause.status === 403 || cause.status === 404) return 'You can no longer edit these properties.'
  return cause.message
}

watch(() => [props.articleId, props.revision, props.identity, retryCount.value] as const, () => {
  scope.abort()
  scope = new AbortController()
  workspace.value = undefined
  retained.value = undefined
  canRetry.value = false
  shouldReload.value = false
  mutating.value = false
  clearEdits()
  message.value = ''
  void load(scope)
}, { immediate: true, flush: 'sync' })
onScopeDispose(() => {
  scope.abort()
  emit('pending', false)
})

async function load(lifetime: AbortController, next = false) {
  busy.value = true
  shouldReload.value = false
  failure.value = ''
  const current = next ? workspace.value : undefined
  try {
    const result = await propertyApi.workspace({
      articleId: props.articleId, articleRevision: props.revision,
      schemaRevision: current?.schemaRevision ?? 0n, valueRevision: current?.valueRevision ?? 0n,
      afterKey: current?.nextKey ?? '',
    }, lifetime.signal)
    if (lifetime.signal.aborted) return
    if (result.articleId !== props.articleId || result.articleRevision !== props.revision) throw Error('Property identity changed')
    workspace.value = current ? { ...result, fields: [...current.fields, ...result.fields] } : result
  } catch (cause) {
    if (!lifetime.signal.aborted) {
      failure.value = failureMessage(cause)
      shouldReload.value = true
    }
  } finally {
    if (!lifetime.signal.aborted) busy.value = false
  }
}

function createDefinition() {
  const current = workspace.value
  if (!current || busy.value || props.disabled || canRetry.value || shouldReload.value) return
  const validLabel = (label: string) => label.trim().length > 0 && label.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(label)
  if (definitionKey.value.length > 64 || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(definitionKey.value) ||
      !validLabel(definitionName.value)) {
    failure.value = 'Enter a label and a key using lowercase letters, numbers, underscores or hyphens.'
    return
  }
  const values = isSelection(definitionKind.value) ? options.value : []
  if (isSelection(definitionKind.value) && (values.length === 0 || !values.every(option => validLabel(option.label)))) {
    failure.value = 'Enter a label for each option.'
    return
  }
  void perform({ kind: 'definition', request: {
    operation: 1, definitionId: crypto.randomUUID(), requestId: crypto.randomUUID(), schemaRevision: current.schemaRevision,
    definitionRevision: 0n, machineKey: definitionKey.value, label: definitionName.value,
    kind: definitionKind.value, options: values.map(option => ({ ...option })),
  } })
}

function normalizeDate(input: string): string {
  const match = /^(?!0000)([0-9]{4}-[0-9]{2}-[0-9]{2})(?:T([0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,3}))?Z)?$/.exec(input)
  if (!match) throw Error('Enter a valid date or a UTC timestamp ending in Z.')
  const canonical = `${match[1]}T${match[2] ?? '00:00:00'}.${(match[3] ?? '').padEnd(3, '0')}Z`
  const parsed = new Date(canonical)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== canonical) {
    throw Error('Enter a valid date or a UTC timestamp ending in Z.')
  }
  return canonical
}

function editedValue(kind: PropertyKind): PropertyValue {
  switch (kind) {
    case 'text':
      if (value.value.length > 16_384 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.value)) {
        throw Error('Enter a single line of at most 16,384 characters.')
      }
      return { kind, value: value.value }
    case 'number':
      try {
        return { kind, value: normalizePropertyDecimal(value.value) }
      } catch {
        throw Error('Enter a decimal in the supported range without rounding or an exponent.')
      }
    case 'boolean':
      if (boolean.value === '') throw Error('Choose True or False.')
      return { kind, value: boolean.value }
    case 'date':
      return { kind, value: normalizeDate(value.value) }
    case 'single-select': {
      const option = selected.value[0]
      if (option === undefined) throw Error('Choose an option.')
      return { kind, value: option }
    }
    case 'multi-select':
      return { kind, value: [...selected.value] }
    case 'article-reference': {
      const id = Number(value.value)
      if (!/^[1-9][0-9]{0,9}$/.test(value.value) || id > 0x7fffffff || id === props.articleId) {
        throw Error('Enter the numeric ID of another article.')
      }
      return { kind, value: [id] }
    }
    case 'url': {
      if (!/^https:\/\//i.test(value.value) || /[\s\\]/u.test(value.value) || value.value.length > 2048) {
        throw Error('Enter an absolute HTTPS URL.')
      }
      let url: URL
      try {
        url = new URL(value.value)
      } catch {
        throw Error('Enter an absolute HTTPS URL.')
      }
      if (url.username || url.password) throw Error('The URL cannot contain credentials.')
      return { kind, value: value.value }
    }
  }
}

function writeValue(action: 'save' | 'remove' = 'save') {
  const current = workspace.value
  const property = editing.value
  if (!current || !property || busy.value || props.disabled || canRetry.value || shouldReload.value ||
      (action !== 'remove' && property.deprecated)) return
  let updated: PropertyValue
  try {
    updated = action === 'remove' ? { kind: 'missing' } : editedValue(property.kind)
  } catch (error) {
    failure.value = error instanceof Error ? error.message : 'Enter a valid property value.'
    return
  }
  void perform({ kind: 'value', request: {
    articleId: current.articleId, articleRevision: current.articleRevision, schemaRevision: current.schemaRevision,
    valueRevision: current.valueRevision, definitionId: property.definitionId, definitionRevision: property.definitionRevision,
    requestId: crypto.randomUUID(), value: updated,
  } })
}

async function perform(command: Command) {
  if (busy.value || props.disabled) return
  const lifetime = scope
  busy.value = true
  mutating.value = true
  canRetry.value = false
  failure.value = ''
  message.value = ''
  retained.value = command
  try {
    const receipt = command.kind === 'definition'
      ? await propertyApi.definition(command.request, lifetime.signal)
      : await propertyApi.value(command.request, lifetime.signal)
    if (lifetime.signal.aborted) return
    if (receipt.definitionId !== command.request.definitionId) throw Error('Wrong property receipt')
    retained.value = undefined
    clearEdits()
    message.value = command.kind === 'definition' ? 'Property created.'
      : command.request.value.kind === 'missing' ? 'Property removed.' : 'Property saved.'
    await load(lifetime)
  } catch (cause) {
    if (lifetime.signal.aborted) return
    failure.value = failureMessage(cause)
    if (lifetime.signal.aborted) return
    if (cause instanceof ApiError && cause.status < 500 && cause.status !== 429) {
      retained.value = undefined
      shouldReload.value = cause.status === 409 || cause.status === 404
    } else {
      canRetry.value = true
    }
  } finally {
    if (!lifetime.signal.aborted) {
      busy.value = false
      mutating.value = false
    }
  }
}

function beginValue(field: EditableProperty) {
  clearEdits()
  editing.value = field
  const stored = field.value
  if (stored.kind === 'boolean') boolean.value = stored.value
  else if (stored.kind === 'single-select') selected.value = [stored.value]
  else if (stored.kind === 'multi-select') selected.value = [...stored.value]
  else if (stored.kind === 'article-reference') value.value = stored.value.join(', ')
  else if (stored.kind !== 'missing' && stored.kind !== 'null' && stored.kind !== 'unavailable') value.value = stored.value
  failure.value = ''
  message.value = ''
}

function showValue(field: EditableProperty): string {
  const stored = field.value
  function optionsLabel(optionIds: string[]) {
    const labels = field.options.filter(option => optionIds.includes(option.id)).map(option => option.label)
    return labels.length ? labels.join(', ') : 'None selected'
  }
  switch (stored.kind) {
    case 'missing': return 'Unset'
    case 'null': return 'Null'
    case 'unavailable': return 'Unavailable reference'
    case 'boolean': return stored.value ? 'True' : 'False'
    case 'article-reference': return stored.value.map(id => `Article #${id}`).join(', ')
    case 'single-select': return optionsLabel([stored.value])
    case 'multi-select': return optionsLabel(stored.value)
    default: return stored.value || 'Blank'
  }
}
</script>

<template>
  <section class="editor-taxonomy" aria-labelledby="article-properties-title">
    <h2 id="article-properties-title">Properties</h2>
    <p v-if="busy" role="status">Loading article properties…</p>
    <p v-if="message" role="status">{{ message }}</p>
    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" />
    <ElButton v-if="shouldReload" :disabled="busy || disabled" @click="retryCount++">Reload properties</ElButton>
    <ElButton v-if="canRetry && retained" :disabled="busy || disabled" @click="perform(retained)">Retry last property change</ElButton>
    <template v-if="workspace && !shouldReload">
      <p v-if="!workspace.fields.length && !creating">No properties yet.</p>
      <dl v-if="workspace.fields.length">
        <template v-for="field in workspace.fields" :key="field.definitionId">
          <dt>{{ field.label }}</dt>
          <dd>
            <span>{{ showValue(field) }}</span>
            <ElButton
              v-if="!field.deprecated || field.value.kind !== 'missing'"
              text
              :disabled="disabledInput || creating || !!editing"
              @click="beginValue(field)"
            >
              {{ field.deprecated ? 'Manage' : 'Edit' }} {{ field.label }}
            </ElButton>
          </dd>
        </template>
      </dl>
      <ElButton v-if="workspace.nextKey" text :disabled="busy || !!editing || creating || canRetry" @click="load(scope, true)">More properties</ElButton>
      <ElButton v-if="!creating && !editing" :disabled="disabledInput" @click="startDefinition">Add property</ElButton>
      <form v-if="creating" class="property-form" @submit.prevent="createDefinition">
        <label for="new-property-label">Property label</label>
        <ElInput id="new-property-label" v-model="definitionName" :disabled="disabledInput" @input="formTouched = true" />
        <label for="new-property-key">Property key</label>
        <ElInput id="new-property-key" v-model="definitionKey" :disabled="disabledInput" @input="formTouched = true" />
        <label for="new-property-type">Property type</label>
        <ElSelect
          id="new-property-type" :model-value="definitionKind" ariaLabel="Property type" :disabled="disabledInput"
          @update:model-value="setKind"
        >
          <ElOption v-for="kind in propertyKinds" :key="kind" :label="kindLabels[kind]" :value="kind" />
        </ElSelect>
        <template v-if="isSelection(definitionKind)">
          <div v-for="(option, index) in options" :key="option.id" class="property-form">
            <label :for="`option-${option.id}`">Option {{ index + 1 }}</label>
            <ElInput :id="`option-${option.id}`" v-model="option.label" :disabled="disabledInput" @input="formTouched = true" />
            <ElButton text :disabled="disabledInput" @click="removeOption(option.id)">Remove option {{ index + 1 }}</ElButton>
          </div>
          <ElButton text :disabled="disabledInput || options.length >= 32" @click="addOption">Add option</ElButton>
        </template>
        <div class="editor-taxonomy-actions">
          <ElButton native-type="submit" type="primary" :disabled="disabledInput">Create property</ElButton>
          <ElButton :disabled="busy || canRetry" @click="clearEdits">Cancel</ElButton>
        </div>
      </form>
      <form v-if="editing" class="property-form" @submit.prevent="writeValue()">
        <p v-if="editing.deprecated" class="metadata">This property is deprecated. You can remove its existing value.</p>
        <ElRadioGroup
          v-if="editing.kind === 'boolean'" :model-value="boolean" :label="`${editing.label} value`"
          :disabled="editingDisabled" @update:model-value="setBoolean"
        >
          <ElRadio :value="true">True</ElRadio>
          <ElRadio :value="false">False</ElRadio>
        </ElRadioGroup>
        <ElRadioGroup
          v-else-if="editing.kind === 'single-select'" :model-value="selected[0] ?? ''" :label="`${editing.label} value`"
          :disabled="editingDisabled" @update:model-value="selectOne"
        >
          <ElRadio v-for="option in editing.options" :key="option.id" :value="option.id">{{ option.label }}</ElRadio>
        </ElRadioGroup>
        <ElCheckboxGroup
          v-else-if="editing.kind === 'multi-select'" :model-value="selected" :label="`${editing.label} value`"
          :disabled="editingDisabled" @update:model-value="selectMany"
        >
          <ElCheckbox v-for="option in editing.options" :key="option.id" :label="option.id">{{ option.label }}</ElCheckbox>
        </ElCheckboxGroup>
        <template v-else>
          <label for="property-value">{{ editing.label }} value</label>
          <ElInput id="property-value" v-model="value" :disabled="editingDisabled" @input="formTouched = true" />
        </template>
        <p v-if="inputHelp" class="metadata">{{ inputHelp }}</p>
        <div class="editor-taxonomy-actions">
          <ElButton v-if="!editing.deprecated" native-type="submit" type="primary" :disabled="disabledInput">Save property</ElButton>
          <ElButton v-if="editing.value.kind !== 'missing'" :disabled="disabledInput" @click="writeValue('remove')">Remove value</ElButton>
          <ElButton :disabled="busy || canRetry" @click="clearEdits">Cancel</ElButton>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.property-form { display: grid; gap: .5rem; min-width: 0; }
dd { overflow-wrap: anywhere; }
</style>
