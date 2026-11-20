<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElCheckboxGroup, ElInput, ElOption, ElRadio, ElRadioGroup, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import {
  normalizePropertyDecimal, propertyApi, propertyKinds,
  type EditableProperty, type PropertyKind, type PropertyOption, type PropertySchemaCommand, type PropertyValue,
  type PropertyValueBatchCommand, type PropertyValueCommand, type PropertyWorkspace,
} from '../../../Contracts/property-values'
import { WireLimits } from '../../../Contracts/wire.generated'
import type { PropertySearchSeek } from '../authoring/canvasEditorHandoff'
import { verifySourceMatch } from '../authoring/sourceCoordinates'
import { showPropertyValue as showValue } from '../authoring/propertyDisplay'
import { currentSession, invalidateSession } from '../authorSession'

const props = defineProps<{
  articleId: number; revision: bigint; identity: number; disabled: boolean
  sourceTarget?: PropertySearchSeek; inspectorReady?: boolean
}>()
const emit = defineEmits<{
  pending: [value: boolean]
  sourceRevealed: [target: PropertySearchSeek, success: boolean]
}>()
const workspace = shallowRef<PropertyWorkspace>()
const pageKeys = shallowRef<readonly string[]>([''])
const heading = shallowRef<HTMLElement>()
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
const valueForm = ref<HTMLFormElement>()
const valueInput = ref<InstanceType<typeof ElInput>>()
const boolean = ref<boolean | ''>('')
const selected = ref<string[]>([])
const retryCount = ref(0)
let scope = new AbortController()

type Command =
  | { kind: 'definition'; request: PropertySchemaCommand }
  | { kind: 'value'; request: PropertyValueCommand }
  | { kind: 'batch'; request: PropertyValueBatchCommand }
type StagedValue = { field: EditableProperty; value: PropertyValue }
const batchMode = ref(false)
const staged = shallowRef<ReadonlyMap<string, StagedValue>>(new Map())
const batchFull = computed(() => staged.value.size >= WireLimits.PropertyBatchMaxChanges)
const retained = shallowRef<Command>()
const canRetry = ref(false)
const shouldReload = ref(false)
const mutating = ref(false)
const formTouched = ref(false)
const unsettled = computed(() => mutating.value || canRetry.value || formTouched.value || staged.value.size > 0)
const disabledInput = computed(() => props.disabled || busy.value || canRetry.value || shouldReload.value)
const editingDisabled = computed(() => disabledInput.value || editing.value?.deprecated === true)
const kindLabels: Record<PropertyKind, MessageKey> = {
  text: 'author.properties.text', number: 'author.properties.number', boolean: 'author.properties.boolean', date: 'author.properties.date', 'single-select': 'author.properties.singleSelect',
  'multi-select': 'author.properties.multipleSelect', 'article-reference': 'author.properties.articleReference', url: 'author.properties.url',
}
const isSelection = (kind: PropertyKind) => kind === 'single-select' || kind === 'multi-select'
const inputHelp = computed(() => {
  switch (editing.value?.kind) {
    case 'number': return t('author.properties.useDecimalNotationWithoutAnExponent')
    case 'date': return t('author.properties.enterADateYyyyMmDdMidnightUtc')
    case 'article-reference': return t('author.properties.enterTheNumericIdOfAReadableArticle')
    case 'url': return t('author.properties.enterAnAbsoluteHttpsUrl')
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
  if (!(cause instanceof ApiError)) return t('author.properties.theServerDidNotConfirmTheRequest')
  if (cause.status === 401) {
    invalidateSession()
    return t('author.properties.logInAgainToEditProperties')
  }
  if (cause.status === 403 || cause.status === 404) return t('author.properties.youCanNoLongerEditTheseProperties')
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
  staged.value = new Map()
  batchMode.value = false
  pageKeys.value = ['']
  clearEdits()
  message.value = ''
  void load(scope)
}, { immediate: true, flush: 'sync' })
onScopeDispose(() => {
  scope.abort()
  emit('pending', false)
})

async function load(lifetime: AbortController, keys: readonly string[] = [''], expected?: PropertyWorkspace) {
  busy.value = true
  shouldReload.value = false
  failure.value = ''
  const afterKey = keys.at(-1) ?? ''
  try {
    const result = await propertyApi.workspace({
      articleId: props.articleId, articleRevision: props.revision,
      schemaRevision: afterKey && expected ? expected.schemaRevision : 0n,
      valueRevision: afterKey && expected ? expected.valueRevision : 0n,
      afterKey,
    }, lifetime.signal)
    if (lifetime.signal.aborted) return false
    if (result.articleId !== props.articleId || result.articleRevision !== props.revision) throw Error('Property identity changed')
    if (expected && (result.schemaRevision !== expected.schemaRevision || result.valueRevision !== expected.valueRevision)) {
      failure.value = t('author.properties.thePropertySchemaOrValuesChangedReloadTo')
      shouldReload.value = true
      return false
    }
    workspace.value = result
    pageKeys.value = keys
    return true
  } catch (cause) {
    if (!lifetime.signal.aborted) {
      failure.value = failureMessage(cause)
      shouldReload.value = !expected || (cause instanceof ApiError && (cause.status === 409 || cause.status === 404))
    }
    return false
  } finally {
    if (!lifetime.signal.aborted) busy.value = false
  }
}

async function changePage(forward: boolean) {
  const current = workspace.value
  if (!current || disabledInput.value || editing.value || creating.value) return
  const keys = pageKeys.value
  if (forward ? !current.nextKey : keys.length === 1) return
  const lifetime = scope
  const opener = document.activeElement
  if (!await load(lifetime, forward ? [...keys, current.nextKey] : keys.slice(0, -1), current)) return
  focusHeading(opener)
}

function createDefinition() {
  const current = workspace.value
  if (!current || disabledInput.value || batchMode.value) return
  const validLabel = (label: string) => label.trim().length > 0 && label.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(label)
  if (definitionKey.value.length > 64 || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(definitionKey.value) ||
      !validLabel(definitionName.value)) {
    failure.value = t('author.properties.enterALabelAndAKeyUsingLowercase')
    return
  }
  const values = isSelection(definitionKind.value) ? options.value : []
  if (isSelection(definitionKind.value) && (values.length === 0 || !values.every(option => validLabel(option.label)))) {
    failure.value = t('author.properties.enterALabelForEachOption')
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
  if (!match) throw Error(t('author.properties.enterAValidDateOrAUtcTimestamp'))
  const canonical = `${match[1]}T${match[2] ?? '00:00:00'}.${(match[3] ?? '').padEnd(3, '0')}Z`
  const parsed = new Date(canonical)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== canonical) {
    throw Error(t('author.properties.enterAValidDateOrAUtcTimestamp'))
  }
  return canonical
}

function editedValue(kind: PropertyKind): PropertyValue {
  switch (kind) {
    case 'text':
      if (value.value.length > 16_384 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.value)) {
        throw Error(t('author.properties.enterASingleLineOfAtMost16'))
      }
      return { kind, value: value.value }
    case 'number':
      try {
        return { kind, value: normalizePropertyDecimal(value.value) }
      } catch {
        throw Error(t('author.properties.enterADecimalInTheSupportedRangeWithout'))
      }
    case 'boolean':
      if (boolean.value === '') throw Error(t('author.properties.chooseTrueOrFalse'))
      return { kind, value: boolean.value }
    case 'date':
      return { kind, value: normalizeDate(value.value) }
    case 'single-select': {
      const option = selected.value[0]
      if (option === undefined) throw Error(t('author.properties.chooseAnOption'))
      return { kind, value: option }
    }
    case 'multi-select':
      return { kind, value: [...selected.value] }
    case 'article-reference': {
      const id = Number(value.value)
      if (!/^[1-9][0-9]{0,9}$/.test(value.value) || id > 0x7fffffff || id === props.articleId) {
        throw Error(t('author.properties.enterTheNumericIdOfAnotherArticle'))
      }
      return { kind, value: [id] }
    }
    case 'url': {
      if (!/^https:\/\//i.test(value.value) || /[\s\\]/u.test(value.value) || value.value.length > 2048) {
        throw Error(t('author.properties.enterAnAbsoluteHttpsUrl'))
      }
      let url: URL
      try {
        url = new URL(value.value)
      } catch {
        throw Error(t('author.properties.enterAnAbsoluteHttpsUrl'))
      }
      if (url.username || url.password) throw Error(t('author.properties.theUrlCannotContainCredentials'))
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
    failure.value = error instanceof Error ? error.message : t('author.properties.enterAValidPropertyValue')
    return
  }
  if (batchMode.value) {
    if (batchFull.value && !staged.value.has(property.definitionId)) return
    const pending = new Map(staged.value)
    pending.set(property.definitionId, { field: property, value: updated })
    staged.value = pending
    clearEdits()
    focusField(property)
    return
  }
  void perform({ kind: 'value', request: {
    articleId: current.articleId, articleRevision: current.articleRevision, schemaRevision: current.schemaRevision,
    valueRevision: current.valueRevision, definitionId: property.definitionId, definitionRevision: property.definitionRevision,
    requestId: crypto.randomUUID(), value: updated,
  } })
}

function startBatch() {
  if (disabledInput.value || creating.value || editing.value) return
  batchMode.value = true
  message.value = ''
  failure.value = ''
}

function discardBatch() {
  if (busy.value || canRetry.value) return
  staged.value = new Map()
  batchMode.value = false
  clearEdits()
  if (shouldReload.value) retryCount.value++
  else failure.value = ''
  focusHeading()
}

function unstage(id: string) {
  if (busy.value || canRetry.value || editing.value) return
  const pending = new Map(staged.value)
  pending.delete(id)
  staged.value = pending
  if (shouldReload.value && !pending.size) batchMode.value = false
  focusHeading()
}

function saveBatch() {
  const current = workspace.value
  if (!current || disabledInput.value || editing.value || !staged.value.size) return
  void perform({ kind: 'batch', request: {
    articleId: current.articleId, articleRevision: current.articleRevision, schemaRevision: current.schemaRevision,
    valueRevision: current.valueRevision, requestId: crypto.randomUUID(),
    changes: Array.from(staged.value.values(), ({ field, value }) => ({
      definitionId: field.definitionId, definitionRevision: field.definitionRevision, value,
    })),
  } })
}

function focusHeading(opener = document.activeElement) {
  const lifetime = scope
  void nextTick(() => {
    if (!lifetime.signal.aborted && (document.activeElement === opener || document.activeElement === document.body))
      heading.value?.focus()
  })
}

const fieldActionId = (field: EditableProperty) => `property-edit-${field.definitionId}`
function focusField(field: EditableProperty) {
  const lifetime = scope
  void nextTick(() => {
    if (!lifetime.signal.aborted) document.getElementById(fieldActionId(field))?.focus({ preventScroll: true })
  })
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
    switch (command.kind) {
      case 'definition':
        await propertyApi.definition(command.request, lifetime.signal)
        break
      case 'value':
        await propertyApi.value(command.request, lifetime.signal)
        break
      case 'batch': {
        const session = currentSession.value
        if (!session?.canAuthor || !session.siteSessionId || session.expiresAt <= Date.now()) {
          failure.value = t('author.properties.logInAgainToEditProperties')
          return
        }
        await propertyApi.values(command.request, lifetime.signal, session.siteSessionId)
        break
      }
    }
    if (lifetime.signal.aborted) return
    retained.value = undefined
    staged.value = new Map()
    batchMode.value = false
    clearEdits()
    message.value = command.kind === 'definition' ? t('author.properties.propertyCreated') : command.kind === 'batch' ? t('author.properties.propertyChangesSaved')
      : command.request.value.kind === 'missing' ? t('author.properties.propertyRemoved') : t('author.properties.propertySaved')
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
  const stored = staged.value.get(field.definitionId)?.value ?? field.value
  if (stored.kind === 'boolean') boolean.value = stored.value
  else if (stored.kind === 'single-select') selected.value = [stored.value]
  else if (stored.kind === 'multi-select') selected.value = [...stored.value]
  else if (stored.kind === 'article-reference') value.value = stored.value.join(', ')
  else if (stored.kind !== 'missing' && stored.kind !== 'null' && stored.kind !== 'unavailable') value.value = stored.value
  failure.value = ''
  message.value = ''
}

function openValueForm(field: EditableProperty) {
  beginValue(field)
  const lifetime = scope
  void nextTick(() => {
    if (lifetime.signal.aborted || editing.value !== field) return
    if (valueInput.value?.input && !valueInput.value.input.disabled) valueInput.value.focus()
    else valueForm.value?.querySelector<HTMLElement>('input:enabled, button:enabled')?.focus()
  })
}

function cancelValueForm() {
  const field = editing.value
  clearEdits()
  if (field) focusField(field)
}

watch([() => props.sourceTarget, () => props.inspectorReady, () => props.disabled, busy, workspace],
  async ([seek, inspectorReady, disabled, loading, snapshot], _, cleanup) => {
    if (!seek || !inspectorReady || disabled || loading) return
    const target = seek.target
    if (target.valueRevision <= 0n || !snapshot || snapshot.articleId !== target.articleId || snapshot.articleRevision !== target.revision ||
        snapshot.schemaRevision !== target.schemaRevision || snapshot.valueRevision !== target.valueRevision) {
      emit('sourceRevealed', seek, false)
      return
    }
    const request = new AbortController()
    cleanup(() => request.abort())
    const current = () => !request.signal.aborted && props.sourceTarget === seek && props.inspectorReady === true && seek.current() &&
      props.articleId === target.articleId && props.revision === target.revision && workspace.value === snapshot &&
      !disabledInput.value && !creating.value && !batchMode.value && !unsettled.value && !retained.value
    const previousFocus = document.activeElement
    let success = false
    try {
      if (!current() || editing.value) return
      const response = await propertyApi.textHit({
        articleId: target.articleId, articleRevision: target.revision, schemaRevision: target.schemaRevision,
        valueRevision: target.valueRevision, definitionId: target.definitionId, definitionRevision: target.definitionRevision,
        sourceDigest: target.sourceDigest,
      }, seek.credential, request.signal)
      const [field] = response.fields
      if (!current() || editing.value || field.value.kind !== 'text') return
      const raw = field.value.value
      if (!await verifySourceMatch(raw, target) || !current() || editing.value || document.activeElement !== previousFocus) return
      beginValue(field)
      await nextTick()
      const control = valueInput.value?.input
      const ownsInput = () => current() && editing.value === field && value.value === raw && valueInput.value?.input === control &&
        control instanceof HTMLInputElement && control.value === raw && control.isConnected && !control.disabled && !control.readOnly &&
        !control.closest('[inert]') && control.getClientRects().length > 0
      if (!(control instanceof HTMLInputElement) || !ownsInput() || document.activeElement !== previousFocus) return
      control.focus()
      if (!ownsInput() || document.activeElement !== control) return
      control.setSelectionRange(target.sourceStart, target.sourceEnd)
      success = ownsInput() && document.activeElement === control && control.selectionStart === target.sourceStart &&
        control.selectionEnd === target.sourceEnd
    } catch {
      // A missing, changed, or unverifiable source leaves the existing editor intact.
    } finally {
      if (!request.signal.aborted && props.sourceTarget === seek) emit('sourceRevealed', seek, success)
    }
  }, { immediate: true, flush: 'post' })


</script>

<template>
  <section class="editor-taxonomy" aria-labelledby="article-properties-title">
    <h2 id="article-properties-title" ref="heading" tabindex="-1">{{ t('author.properties.properties') }}</h2>
    <p v-if="mutating" role="status">{{ t('author.properties.savingArticleProperties') }}</p>
    <p v-else-if="busy" role="status">{{ t('author.properties.loadingArticleProperties') }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <ElAlert v-if="failure" :title="failure" type="error" :closable="false" />
    <ElButton v-if="shouldReload && !staged.size" :disabled="busy || disabled" @click="retryCount++">{{ t('author.properties.reloadProperties') }}</ElButton>
    <ElButton v-if="canRetry && retained" :disabled="busy || disabled" @click="perform(retained)">{{ t('author.properties.retryLastPropertyChange') }}</ElButton>
    <div v-if="batchMode" class="property-batch">
      <p v-if="staged.size" role="status">{{ t(staged.size === 1 ? 'author.properties.stagedOne' : 'author.properties.stagedMany', { count: staged.size }) }}</p>
      <p v-else>{{ t('author.properties.choosePropertiesToEditAndStageThemBefore') }}</p>
      <p v-if="batchFull">{{ t('author.properties.batchLimit', { limit: WireLimits.PropertyBatchMaxChanges }) }}</p>
      <p v-if="shouldReload && staged.size">{{ t('author.properties.discardTheStagedChangesToLoadTheCurrent') }}</p>
      <ul v-if="staged.size" class="staged-properties" :aria-label="t('author.properties.stagedPropertyChanges')">
        <li v-for="entry in staged.values()" :key="entry.field.definitionId">
          <span>{{ entry.field.label }} · {{ showValue(entry.field, entry.value) }}</span>
          <ElButton text native-type="button" :disabled="busy || canRetry || !!editing" @click="unstage(entry.field.definitionId)">
            {{ t('author.properties.unstageLabel', { label: entry.field.label }) }}
          </ElButton>
        </li>
      </ul>
      <div class="editor-taxonomy-actions">
        <ElButton type="primary" native-type="button" :disabled="disabledInput || !staged.size || !!editing" @click="saveBatch">
          {{ t('author.properties.savePropertyChanges') }}
        </ElButton>
        <ElButton native-type="button" :disabled="busy || canRetry" @click="discardBatch">
          {{ staged.size ? t('author.properties.discardStagedChanges') : t('author.properties.cancelBatch') }}
        </ElButton>
      </div>
    </div>
    <template v-if="workspace && !shouldReload">
      <p v-if="!workspace.fields.length && !creating">{{ t('author.properties.noPropertiesYet') }}</p>
      <dl v-if="workspace.fields.length">
        <template v-for="field in workspace.fields" :key="field.definitionId">
          <dt>{{ field.label }}</dt>
          <dd>
            <span>{{ showValue(field) }}</span>
            <ElButton
              v-if="!field.deprecated || field.value.kind !== 'missing'"
              v-bind="{ id: fieldActionId(field) }"
              text
              :disabled="disabledInput || creating || !!editing || (batchMode && batchFull && !staged.has(field.definitionId))"
              @click="openValueForm(field)"
            >
              {{ field.deprecated ? t('author.properties.manage') : t('author.properties.edit') }} {{ field.label }}
            </ElButton>
          </dd>
        </template>
      </dl>
      <nav v-if="pageKeys.length > 1 || workspace.nextKey" class="editor-taxonomy-actions" :aria-label="t('author.properties.propertyPages')">
        <ElButton text native-type="button" :disabled="disabledInput || !!editing || creating || pageKeys.length === 1"
          @click="changePage(false)">{{ t('author.properties.previousProperties') }}</ElButton>
        <span role="status">{{ t('author.properties.pageNumber', { page: pageKeys.length }) }}</span>
        <ElButton text native-type="button" :disabled="disabledInput || !!editing || creating || !workspace.nextKey"
          @click="changePage(true)">{{ t('author.properties.moreProperties') }}</ElButton>
      </nav>
      <div v-if="!creating && !editing && !batchMode" class="editor-taxonomy-actions">
        <ElButton :disabled="disabledInput" native-type="button" @click="startDefinition">{{ t('author.properties.addProperty') }}</ElButton>
        <ElButton v-if="workspace.fields.length" :disabled="disabledInput" native-type="button" @click="startBatch">{{ t('author.properties.editMultipleProperties') }}</ElButton>
      </div>
      <form v-if="creating" class="property-form" @submit.prevent="createDefinition">
        <label for="new-property-label">{{ t('author.properties.propertyLabel') }}</label>
        <ElInput id="new-property-label" v-model="definitionName" :disabled="disabledInput" @input="formTouched = true" />
        <label for="new-property-key">{{ t('author.properties.propertyKey') }}</label>
        <ElInput id="new-property-key" v-model="definitionKey" :disabled="disabledInput" @input="formTouched = true" />
        <label for="new-property-type">{{ t('author.properties.propertyType') }}</label>
        <ElSelect
          id="new-property-type" :model-value="definitionKind" :ariaLabel="t('author.properties.propertyType')" :disabled="disabledInput"
          @update:model-value="setKind"
        >
          <ElOption v-for="kind in propertyKinds" :key="kind" :label="t(kindLabels[kind])" :value="kind" />
        </ElSelect>
        <template v-if="isSelection(definitionKind)">
          <div v-for="(option, index) in options" :key="option.id" class="property-form">
            <label :for="`option-${option.id}`">{{ t('author.properties.optionNumber', { index: index + 1 }) }}</label>
            <ElInput :id="`option-${option.id}`" v-model="option.label" :disabled="disabledInput" @input="formTouched = true" />
            <ElButton text :disabled="disabledInput" @click="removeOption(option.id)">{{ t('author.properties.removeOption', { index: index + 1 }) }}</ElButton>
          </div>
          <ElButton text :disabled="disabledInput || options.length >= 32" @click="addOption">{{ t('author.properties.addOption') }}</ElButton>
        </template>
        <div class="editor-taxonomy-actions">
          <ElButton native-type="submit" type="primary" :disabled="disabledInput">{{ t('author.properties.createProperty') }}</ElButton>
          <ElButton :disabled="busy || canRetry" @click="clearEdits">{{ t('author.properties.cancel') }}</ElButton>
        </div>
      </form>
      <form v-if="editing" ref="valueForm" class="property-form" @submit.prevent="writeValue()">
        <p v-if="editing.deprecated" class="metadata">{{ t('author.properties.thisPropertyIsDeprecatedYouCanRemoveIts') }}</p>
        <ElRadioGroup
          v-if="editing.kind === 'boolean'" :model-value="boolean" :label="t('author.properties.labelValue', { label: editing.label })"
          :disabled="editingDisabled" @update:model-value="setBoolean"
        >
          <ElRadio :value="true">{{ t('author.properties.true') }}</ElRadio>
          <ElRadio :value="false">{{ t('author.properties.false') }}</ElRadio>
        </ElRadioGroup>
        <ElRadioGroup
          v-else-if="editing.kind === 'single-select'" :model-value="selected[0] ?? ''" :label="t('author.properties.labelValue', { label: editing.label })"
          :disabled="editingDisabled" @update:model-value="selectOne"
        >
          <ElRadio v-for="option in editing.options" :key="option.id" :value="option.id">{{ option.label }}</ElRadio>
        </ElRadioGroup>
        <ElCheckboxGroup
          v-else-if="editing.kind === 'multi-select'" :model-value="selected" :label="t('author.properties.labelValue', { label: editing.label })"
          :disabled="editingDisabled" @update:model-value="selectMany"
        >
          <ElCheckbox v-for="option in editing.options" :key="option.id" :label="option.id">{{ option.label }}</ElCheckbox>
        </ElCheckboxGroup>
        <template v-else>
          <label for="property-value">{{ t('author.properties.labelValue', { label: editing.label }) }}</label>
          <ElInput id="property-value" ref="valueInput" v-model="value" :disabled="editingDisabled" @input="formTouched = true" />
        </template>
        <p v-if="inputHelp" class="metadata">{{ inputHelp }}</p>
        <div class="editor-taxonomy-actions">
          <ElButton v-if="!editing.deprecated" native-type="submit" type="primary" :disabled="disabledInput">
            {{ batchMode ? t('author.properties.stageProperty') : t('author.properties.saveProperty') }}
          </ElButton>
          <ElButton v-if="editing.value.kind !== 'missing'" :disabled="disabledInput" native-type="button" @click="writeValue('remove')">
            {{ batchMode ? t('author.properties.stageRemoval') : t('author.properties.removeValue') }}
          </ElButton>
          <ElButton :disabled="busy || canRetry" @click="cancelValueForm">{{ t('author.properties.cancel') }}</ElButton>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.property-form, .property-batch { display: grid; gap: .5rem; min-width: 0; }
.property-batch p, .staged-properties { margin-block: 0; }
.staged-properties { padding-inline-start: 1.25rem; overflow-wrap: anywhere; }
.staged-properties li { margin-block: .25rem; }
dd { overflow-wrap: anywhere; }
</style>
