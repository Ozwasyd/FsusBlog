<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
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
const status = ref<MessageKey | ''>('')
const error = ref<MessageKey | ''>('')
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
    error.value = 'author.canvasBundle.sizeError'
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
    status.value = 'author.canvasBundle.validated'
  } catch (cause) {
    if (request.signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('expired')
    else error.value = 'author.canvasBundle.invalid'
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
      error.value = 'author.canvasBundle.rejected'
    } else {
      error.value = 'author.canvasBundle.uncertain'
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
  <ElButton native-type="button" :disabled="props.disabled" @click="begin">{{ t('author.canvasBundle.open') }}</ElButton>
  <ElDialog :model-value="open" :title="t('author.canvasBundle.title')" append-to-body
    :show-close="!applying && !retry" :close-on-click-modal="!applying && !retry" :close-on-press-escape="!applying && !retry"
    @close="close" @closed="restore">
    <div v-if="open" class="bundle-intake">
      <p>{{ t('author.canvasBundle.explanation') }}</p>
      <label for="canvas-bundle-file">{{ t('author.canvasBundle.file') }}</label>
      <input id="canvas-bundle-file" type="file" accept=".fsuscanvas,application/vnd.fsus.canvas+json" :disabled="applying || !!retry" @change="load" />
      <p v-if="loading" role="status">{{ t('author.canvasBundle.validating') }}</p>
      <p v-if="status" role="status">{{ t(status) }}</p>
      <p v-if="error" role="alert">{{ t(error) }}</p>
      <template v-if="plan">
        <h3>{{ plan.title }}</h3>
        <p>{{ t('author.canvasBundle.summary', { revision: plan.sourceRevision.toString(), nodes: plan.nodeCount, edges: plan.edgeCount }) }}</p>
        <p v-if="refs">{{ t('author.canvasBundle.mapped', { mapped: mapped.length, refs }) }}</p>
        <div v-for="reference in shown" :key="reference.slot" class="bundle-reference">
          <label :for="`bundle-article-${reference.slot}`">
            {{ t('author.canvasBundle.article', { slot: reference.slot }) }}
            <span v-if="reference.anchor"> · {{ reference.anchor }}</span>
          </label>
          <input :id="`bundle-article-${reference.slot}`" v-model="mappings[reference.slot].article"
            inputmode="numeric" :disabled="applying || !!retry" />
          <template v-if="reference.pinned">
            <label :for="`bundle-revision-${reference.slot}`">{{ t('author.canvasBundle.pin', { slot: reference.slot }) }}</label>
            <input :id="`bundle-revision-${reference.slot}`" v-model="mappings[reference.slot].pin"
              inputmode="numeric" :disabled="applying || !!retry" />
          </template>
        </div>
        <div v-if="refs > size" class="bundle-actions">
          <ElButton :disabled="page === 0" @click="page--">{{ t('author.canvasBundle.previous') }}</ElButton>
          <ElButton :disabled="(page + 1) * size >= refs" @click="page++">{{ t('author.canvasBundle.more') }}</ElButton>
        </div>
      </template>
      <div class="bundle-actions">
        <ElButton :disabled="applying || !!retry" @click="close">{{ t('nav.cancel') }}</ElButton>
        <ElButton v-if="plan" type="primary" :disabled="applying || (!retry && !canImport)" @click="apply">
          {{ t(retry && !applying ? 'author.canvasBundle.retry' : 'author.canvasBundle.create') }}
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
