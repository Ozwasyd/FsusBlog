<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef } from 'vue'
import { ElButton, ElDialog } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import { canvasBundle, type CanvasBundleExecute, type CanvasBundleMapping, type CanvasBundlePlan } from '../../../Contracts/canvas-bundle'

const props = defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ imported: [id: string], pending: [value: boolean], expired: [] }>()
const open = ref(false)
const opener = ref<HTMLElement>()
const plan = shallowRef<CanvasBundlePlan>()
const selected = shallowRef<Uint8Array>()
const retry = shallowRef<CanvasBundleExecute>()
const mappings = ref<Record<number, { article: string; pin: string }>>({})
const page = ref(0)
const status = ref('')
const error = ref('')
const loading = ref(false)
const applying = ref(false)
let active: AbortController | undefined

const size = 20
const shown = computed(() => plan.value?.references.slice(page.value * size, (page.value + 1) * size) ?? [])
const refs = computed(() => plan.value?.references.length ?? 0)
const mapped = computed(() => {
  const valid: CanvasBundleMapping[] = []
  for (const reference of plan.value?.references ?? []) {
    const value = mappings.value[reference.slot]
    if (!value || !/^[1-9][0-9]{0,9}$/.test(value.article) || Number(value.article) > 2_147_483_647) continue
    const pinned = reference.pinned
    if (pinned && (!/^[1-9][0-9]{0,18}$/.test(value.pin) || BigInt(value.pin) > 9_223_372_036_854_775_807n)) continue
    valid.push({ slot: reference.slot, articleId: Number(value.article), pinnedRevision: pinned ? BigInt(value.pin) : null })
  }
  return valid
})
const canImport = computed(() => !!plan.value && !loading.value && !applying.value && refs.value === mapped.value.length)

function clear() {
  active?.abort()
  active = undefined
  selected.value = undefined
  retry.value = undefined
  plan.value = undefined
  mappings.value = {}
  page.value = 0
  status.value = ''
  error.value = ''
  loading.value = false
}
function begin(event: MouseEvent) {
  opener.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  clear()
  open.value = true
}
function close() {
  if (!applying.value && !retry.value) {
    open.value = false
    clear()
  }
}
function restore() {
  void nextTick(() => opener.value?.focus())
}
onScopeDispose(() => { active?.abort(); emit('pending', false) })

async function load(event: Event) {
  if (!(event.target instanceof HTMLInputElement) || applying.value || retry.value) return
  const file = event.target.files?.[0]
  clear()
  if (!file) return
  if (file.size === 0 || file.size > WireLimits.CanvasBundleBytes) {
    error.value = 'Choose a Canvas bundle of 3.5 MB or less.'
    return
  }
  const request = new AbortController()
  active = request
  loading.value = true
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (request.signal.aborted) return
    const result = await canvasBundle.plan(bytes, request.signal)
    if (request.signal.aborted) return
    selected.value = bytes
    mappings.value = Object.fromEntries(result.references.map(reference => [reference.slot, { article: '', pin: '' }]))
    plan.value = result
    status.value = 'Bundle validated. No Canvas has been created.'
  } catch (cause) {
    if (request.signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('expired')
    else error.value = 'The file could not be validated as a Canvas bundle.'
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}

async function apply() {
  const bundle = selected.value
  const frozen = plan.value
  if (!bundle || !frozen || applying.value || (!retry.value && !canImport.value)) return
  const command = retry.value ?? { canvasId: crypto.randomUUID(), commandId: crypto.randomUUID(),
    digest: frozen.digest, mappings: mapped.value, bundle }
  const request = new AbortController()
  active = request
  retry.value = command
  applying.value = true
  error.value = ''
  emit('pending', true)
  try {
    const result = await canvasBundle.import(command, request.signal)
    if (request.signal.aborted) return
    applying.value = false
    retry.value = undefined
    emit('pending', false)
    open.value = false
    clear()
    emit('imported', result.id)
  } catch (cause) {
    if (request.signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('expired')
    if (cause instanceof ApiError && [400, 401, 403, 404, 409, 413].includes(cause.status)) {
      retry.value = undefined
      error.value = 'Import was rejected. Check the exact local article mappings and ownership.'
    } else {
      error.value = 'The outcome could not be confirmed. Retry the same import.'
    }
  } finally {
    if (!request.signal.aborted) {
      applying.value = false
      emit('pending', !!retry.value)
    }
  }
}
</script>

<template>
  <ElButton native-type="button" :disabled="props.disabled" @click="begin">Import Canvas</ElButton>
  <ElDialog :model-value="open" title="Import Canvas bundle" append-to-body
    :show-close="!applying && !retry" :close-on-click-modal="!applying && !retry" :close-on-press-escape="!applying && !retry"
    @close="close" @closed="restore">
    <div v-if="open" class="bundle-intake">
      <p>Import creates a separate Canvas. Notes in this file are unencrypted.</p>
      <label for="canvas-bundle-file">Canvas bundle file</label>
      <input id="canvas-bundle-file" type="file" accept=".fsuscanvas,application/vnd.fsus.canvas+json" :disabled="applying || !!retry" @change="load" />
      <p v-if="loading" role="status">Validating bundle…</p>
      <p v-if="status" role="status">{{ status }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="plan">
        <h3>{{ plan.title }}</h3>
        <p>Source revision {{ plan.sourceRevision }} · {{ plan.nodeCount }} nodes · {{ plan.edgeCount }} edges</p>
        <p v-if="refs">{{ mapped.length }}/{{ refs }} references mapped. Enter IDs you own on this site.</p>
        <div v-for="reference in shown" :key="reference.slot" class="bundle-reference">
          <label :for="`bundle-article-${reference.slot}`">
            Reference {{ reference.slot }} article ID
            <span v-if="reference.anchor"> · {{ reference.anchor }}</span>
          </label>
          <input :id="`bundle-article-${reference.slot}`" v-model="mappings[reference.slot].article"
            inputmode="numeric" :disabled="applying || !!retry" />
          <template v-if="reference.pinned">
            <label :for="`bundle-revision-${reference.slot}`">Reference {{ reference.slot }} fixed revision</label>
            <input :id="`bundle-revision-${reference.slot}`" v-model="mappings[reference.slot].pin"
              inputmode="numeric" :disabled="applying || !!retry" />
          </template>
        </div>
        <div v-if="refs > size" class="bundle-actions">
          <ElButton :disabled="page === 0" @click="page--">Previous mappings</ElButton>
          <ElButton :disabled="(page + 1) * size >= refs" @click="page++">More mappings</ElButton>
        </div>
      </template>
      <div class="bundle-actions">
        <ElButton :disabled="applying || !!retry" @click="close">Cancel</ElButton>
        <ElButton v-if="plan" type="primary" :disabled="applying || (!retry && !canImport)" @click="apply">
          {{ retry && !applying ? 'Retry import' : 'Create from bundle' }}
        </ElButton>
      </div>
    </div>
  </ElDialog>
</template>

<style scoped>
.bundle-intake,.bundle-reference { display:grid; gap:.45rem; }
.bundle-reference { padding-block:.5rem; border-block-end:1px solid var(--fsus-border); }
.bundle-reference input { font:inherit; background:var(--fsus-paper); border:1px solid var(--fsus-border); color:inherit; padding:.45rem; }
.bundle-actions { display:flex; flex-wrap:wrap; gap:.5rem; padding-block-start:.5rem; }
.bundle-actions :deep(.el-button + .el-button) { margin-inline-start:0; }
</style>
