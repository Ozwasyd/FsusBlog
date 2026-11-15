<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { changeTaxonomyMetadata, currentTaxonomyMetadata, normalizeTaxonomyMetadata, type AdminMetadataKind,
  type AdminTaxonomyMetadata, type AdminTaxonomyMetadataEdit } from '../../../Contracts/admin-tag-metadata'

const props = defineProps<{ kind: AdminMetadataKind; id: number }>()
const emit = defineEmits<{ close: []; saved: []; 'session-lost': [error: ApiError] }>()
const lifetime = new AbortController()
const current = shallowRef<AdminTaxonomyMetadata>()
const outstanding = shallowRef<AdminTaxonomyMetadataEdit>()
const name = ref('')
const description = ref('')
const error = ref('')
const busy = ref(false)
const stale = ref(false)
const creating = computed(() => props.id === 0)
const label = computed(() => props.kind === 'tag' ? 'Tag' : 'Category')
const heading = computed(() => creating.value ? `Create ${props.kind}` : `Edit ${props.kind} metadata`)
const warning = computed(() => props.kind === 'tag'
  ? 'Use a nonnumeric tag name up to 128 UTF-8 bytes and a description up to 500 characters.'
  : 'Use a category name up to 128 UTF-8 bytes and a description up to 500 characters.')
const submitLabel = computed(() => {
  if (creating.value) return outstanding.value ? `Retry ${props.kind} creation` : heading.value
  return outstanding.value ? `Retry ${props.kind} update` : `Save ${props.kind} metadata`
})
const normalized = computed(() => {
  try { return normalizeTaxonomyMetadata(props.kind, name.value, description.value) }
  catch { return undefined }
})

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() }
  catch (failure) {
    if (lifetime.signal.aborted) return
    if (failure instanceof ApiError && failure.status === 401 && !failure.details.startsWith('pow_')) emit('session-lost', failure)
    else if (failure instanceof ApiError && failure.status === 409) {
      outstanding.value = undefined
      stale.value = !creating.value
      error.value = failure.message
    } else if (failure instanceof ApiError && failure.status === 403) {
      outstanding.value = undefined
      stale.value = true
      error.value = creating.value ? `You do not have permission to create a ${props.kind}.`
        : `You do not have permission to change this ${props.kind}.`
    } else error.value = creating.value ? `Could not confirm ${props.kind} creation. You can retry the same request.`
      : `Could not confirm the ${props.kind} change. You can retry the same request.`
  } finally {
    if (!lifetime.signal.aborted) busy.value = false
  }
}

async function load() {
  await run(async () => {
    const metadata = await currentTaxonomyMetadata(props.kind, props.id, lifetime.signal)
    if (lifetime.signal.aborted) return
    current.value = metadata
    name.value = metadata.name
    description.value = metadata.description
    stale.value = false
  })
}

function save() {
  if ((!creating.value && !current.value) || !normalized.value || stale.value || busy.value) return
  const input = outstanding.value ??= {
    ...normalized.value, id: props.id, expectedRevision: current.value?.revision ?? 0n, requestId: crypto.randomUUID(),
  }
  void run(async () => {
    await changeTaxonomyMetadata(props.kind, input, lifetime.signal)
    if (!lifetime.signal.aborted) emit('saved')
  })
}

onMounted(() => { if (!creating.value) void load() })
onScopeDispose(() => lifetime.abort())
</script>

<template>
  <section class="tag-metadata-editor" :aria-label="heading" :aria-busy="busy">
    <h3>{{ heading }}</h3>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <form v-if="creating || current" @submit.prevent="save">
      <label :for="`admin-${kind}-name`">{{ label }} name</label>
      <ElInput :id="`admin-${kind}-name`" v-model="name" :disabled="busy || !!outstanding || stale" />
      <label :for="`admin-${kind}-description`">{{ label }} description</label>
      <ElInput :id="`admin-${kind}-description`" v-model="description" type="textarea" :disabled="busy || !!outstanding || stale" />
      <ElAlert v-if="!normalized" :title="warning" type="warning" :closable="false" />
      <ElButton v-if="!stale" native-type="submit" type="primary" :disabled="!normalized || busy" :loading="busy">
        {{ submitLabel }}
      </ElButton>
    </form>
    <ElButton v-if="!creating && (stale || !current)" native-type="button" :disabled="busy" @click="load">Reload {{ kind }} metadata</ElButton>
    <ElButton native-type="button" :disabled="busy" @click="emit('close')">Close {{ kind }} editor</ElButton>
  </section>
</template>

<style scoped>
.tag-metadata-editor, .tag-metadata-editor form { display: grid; gap: .5rem; }
.tag-metadata-editor { padding: .75rem; border: 1px solid var(--fsus-border); }
.tag-metadata-editor h3 { margin: 0; }
.tag-metadata-editor :deep(.el-button) { justify-self: start; }
</style>
