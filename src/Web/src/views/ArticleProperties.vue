<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import {
  propertyApi, type EditableProperty, type PropertyDefinitionCommand, type PropertyTextCommand, type PropertyWorkspace,
} from '../../../Contracts/properties-client'
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
const editing = shallowRef<EditableProperty>()
const value = ref('')
const retryCount = ref(0)
let scope = new AbortController()

type Command =
  | { kind: 'definition'; request: PropertyDefinitionCommand }
  | { kind: 'text'; request: PropertyTextCommand }
const retained = shallowRef<Command>()
const canRetry = ref(false)
const shouldReload = ref(false)
const mutating = ref(false)
const unsettled = computed(() => mutating.value || canRetry.value)
watch(unsettled, active => emit('pending', active), { flush: 'sync' })

function clearEdits() {
  creating.value = false
  editing.value = undefined
  definitionKey.value = ''
  definitionName.value = ''
  value.value = ''
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
  if (definitionKey.value.length > 64 || definitionName.value.length > 256 ||
      !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(definitionKey.value) || !definitionName.value.trim()) {
    failure.value = 'Enter a label and a key using lowercase letters, numbers, underscores or hyphens.'
    return
  }
  void perform({ kind: 'definition', request: {
    operation: 1, definitionId: crypto.randomUUID(), requestId: crypto.randomUUID(), schemaRevision: current.schemaRevision,
    definitionRevision: 0n, machineKey: definitionKey.value, label: definitionName.value,
  } })
}

function writeText(remove = false) {
  const current = workspace.value
  const property = editing.value
  if (!current || !property || busy.value || props.disabled || canRetry.value || shouldReload.value ||
      (!remove && property.deprecated)) return
  if (!remove && value.value.length > 16_384) {
    failure.value = 'Property value exceeds the supported length.'
    return
  }
  void perform({ kind: 'text', request: {
    articleId: current.articleId, articleRevision: current.articleRevision, schemaRevision: current.schemaRevision,
    valueRevision: current.valueRevision, definitionId: property.definitionId, definitionRevision: property.definitionRevision,
    requestId: crypto.randomUUID(), remove, value: remove ? '' : value.value,
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
      : await propertyApi.text(command.request, lifetime.signal)
    if (lifetime.signal.aborted) return
    if (receipt.definitionId !== command.request.definitionId) throw Error('Wrong property receipt')
    retained.value = undefined
    clearEdits()
    message.value = command.kind === 'definition' ? 'Property created.' : command.request.remove ? 'Property removed.' : 'Property saved.'
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
  value.value = field.value ?? ''
  failure.value = ''
  message.value = ''
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
      <p v-if="!workspace.fields.length && !creating">No text properties yet.</p>
      <dl v-if="workspace.fields.length">
        <template v-for="field in workspace.fields" :key="field.definitionId">
          <dt>{{ field.label }}</dt>
          <dd>
            <span>{{ field.value === null ? 'Unset' : field.value || 'Blank' }}</span>
            <ElButton v-if="!field.deprecated || field.value !== null" text :disabled="disabled || busy || canRetry" @click="beginValue(field)">
              {{ field.deprecated ? 'Manage' : 'Edit' }} {{ field.label }}
            </ElButton>
          </dd>
        </template>
      </dl>
      <ElButton v-if="workspace.nextKey" text :disabled="busy || !!editing || creating || canRetry" @click="load(scope, true)">More properties</ElButton>
      <ElButton v-if="!creating && !editing" :disabled="disabled || busy || canRetry" @click="creating = true">Add text property</ElButton>
      <form v-if="creating" @submit.prevent="createDefinition">
        <label for="new-property-label">Property label</label>
        <ElInput id="new-property-label" v-model="definitionName" :disabled="disabled || busy || canRetry" />
        <label for="new-property-key">Property key</label>
        <ElInput id="new-property-key" v-model="definitionKey" :disabled="disabled || busy || canRetry" />
        <ElButton native-type="submit" type="primary" :disabled="disabled || busy || canRetry">Create property</ElButton>
        <ElButton :disabled="busy || canRetry" @click="clearEdits">Cancel</ElButton>
      </form>
      <form v-if="editing" @submit.prevent="writeText()">
        <label for="property-value">{{ editing.label }} value</label>
        <ElInput id="property-value" v-model="value" :disabled="disabled || busy || canRetry || editing.deprecated" />
        <ElButton v-if="!editing.deprecated" native-type="submit" type="primary" :disabled="disabled || busy || canRetry">Save property</ElButton>
        <ElButton v-if="editing.value !== null" :disabled="disabled || busy || canRetry" @click="writeText(true)">Remove value</ElButton>
        <ElButton :disabled="busy || canRetry" @click="clearEdits">Cancel</ElButton>
      </form>
    </template>
  </section>
</template>
