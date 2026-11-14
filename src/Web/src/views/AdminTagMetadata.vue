<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { changeTagMetadata, currentTagMetadata, normalizeTagMetadata, type AdminTagMetadata,
  type AdminTagMetadataEdit } from '../../../Contracts/admin-tag-metadata'

const props = defineProps<{ id: number }>()
const emit = defineEmits<{ close: []; saved: []; 'session-lost': [error: ApiError] }>()
const lifetime = new AbortController()
const current = shallowRef<AdminTagMetadata>()
const outstanding = shallowRef<AdminTagMetadataEdit>()
const name = ref('')
const description = ref('')
const error = ref('')
const busy = ref(false)
const stale = ref(false)
const normalized = computed(() => {
  try { return normalizeTagMetadata(name.value, description.value) }
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
      stale.value = true
      error.value = failure.message
    } else if (failure instanceof ApiError && failure.status === 403) {
      outstanding.value = undefined
      stale.value = true
      error.value = 'You do not have permission to change this tag.'
    } else error.value = 'Could not confirm the tag change. You can retry the same request.'
  } finally {
    if (!lifetime.signal.aborted) busy.value = false
  }
}

async function load() {
  await run(async () => {
    const metadata = await currentTagMetadata(props.id, lifetime.signal)
    if (lifetime.signal.aborted) return
    current.value = metadata
    name.value = metadata.name
    description.value = metadata.description
    stale.value = false
  })
}

function save() {
  if (!current.value || !normalized.value || stale.value) return
  const input = outstanding.value ??= {
    ...normalized.value, id: props.id, expectedRevision: current.value.revision, requestId: crypto.randomUUID(),
  }
  void run(async () => {
    await changeTagMetadata(input, lifetime.signal)
    if (!lifetime.signal.aborted) emit('saved')
  })
}

onMounted(load)
onScopeDispose(() => lifetime.abort())
</script>

<template>
  <section class="tag-metadata-editor" aria-label="Edit tag metadata" :aria-busy="busy">
    <h3>Edit tag metadata</h3>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <form v-if="current" @submit.prevent="save">
      <label for="admin-tag-name">Tag name</label>
      <ElInput id="admin-tag-name" v-model="name" :disabled="busy || !!outstanding || stale" />
      <label for="admin-tag-description">Tag description</label>
      <ElInput id="admin-tag-description" v-model="description" type="textarea" :disabled="busy || !!outstanding || stale" />
      <ElAlert v-if="!normalized" title="Use a nonnumeric tag name up to 128 UTF-8 bytes and a description up to 500 characters."
        type="warning" :closable="false" />
      <ElButton v-if="!stale" native-type="submit" type="primary" :disabled="!normalized || busy" :loading="busy">
        {{ outstanding ? 'Retry tag update' : 'Save tag metadata' }}
      </ElButton>
    </form>
    <ElButton v-if="stale || !current" native-type="button" :disabled="busy" @click="load">Reload tag metadata</ElButton>
    <ElButton native-type="button" :disabled="busy" @click="emit('close')">Close tag editor</ElButton>
  </section>
</template>

<style scoped>
.tag-metadata-editor, .tag-metadata-editor form { display: grid; gap: .5rem; }
.tag-metadata-editor { padding: .75rem; border: 1px solid var(--fsus-border); }
.tag-metadata-editor h3 { margin: 0; }
.tag-metadata-editor :deep(.el-button) { justify-self: start; }
</style>
