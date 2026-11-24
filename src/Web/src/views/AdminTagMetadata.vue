<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElInlineActions, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { changeTaxonomyMetadata, currentTaxonomyMetadata, normalizeTaxonomyMetadata, type AdminMetadataKind,
  type AdminTaxonomyMetadata, type AdminTaxonomyMetadataEdit } from '../../../Contracts/admin-tag-metadata'

const props = defineProps<{ kind: AdminMetadataKind; id: number }>()
const emit = defineEmits<{ close: []; saved: [metadata: AdminTaxonomyMetadata]; 'session-lost': [error: ApiError] }>()
const lifetime = new AbortController()
const current = shallowRef<AdminTaxonomyMetadata>()
const outstanding = shallowRef<AdminTaxonomyMetadataEdit>()
const name = ref('')
const description = ref('')
const error = ref<string | { key: MessageKey; kind: AdminMetadataKind }>('')
const busy = ref(false)
const stale = ref(false)
const creating = computed(() => props.id === 0)
const kindLabel = computed(() => t(props.kind === 'tag' ? 'admin.taxonomy.kindTag' : 'admin.taxonomy.kindCategory'))
const label = computed(() => props.kind === 'tag' ? t('page.tag') : t('page.category'))
const heading = computed(() => creating.value ? t('admin.taxonomy.m41', { kind: kindLabel.value }) : t('admin.tagMetadata.m8', { kind: kindLabel.value }))
const warning = computed(() => props.kind === 'tag'
  ? t('admin.tagMetadata.m3')
  : t('admin.tagMetadata.m4'))
const submitLabel = computed(() => {
  if (creating.value) return outstanding.value ? t('admin.tagMetadata.m9', { kind: kindLabel.value }) : heading.value
  return outstanding.value ? t('admin.tagMetadata.m10', { kind: kindLabel.value }) : t('admin.tagMetadata.m11', { kind: kindLabel.value })
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
      error.value = creating.value ? { key: 'admin.tagMetadata.m12', kind: props.kind }
        : { key: 'admin.tagMetadata.m13', kind: props.kind }
    } else error.value = creating.value ? { key: 'admin.tagMetadata.m14', kind: props.kind }
      : { key: 'admin.tagMetadata.m15', kind: props.kind }
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
    const saved = await changeTaxonomyMetadata(props.kind, input, lifetime.signal)
    if (!lifetime.signal.aborted) emit('saved', saved)
  })
}

onMounted(() => { if (!creating.value) void load() })
onScopeDispose(() => lifetime.abort())
</script>

<template>
  <div class="tag-metadata-editor" :aria-label="heading" :aria-busy="busy">
    <ElAlert
      v-if="error"
      :title="typeof error === 'string' ? error : t(error.key, { kind: t(error.kind === 'tag' ? 'admin.taxonomy.kindTag' : 'admin.taxonomy.kindCategory') })"
      type="error"
      :closable="false"
    />
    <form v-if="creating || current" class="tag-metadata-form" @submit.prevent="save">
      <div class="tag-metadata-field">
        <label :for="`admin-${kind}-name`">{{ t('admin.tagMetadata.m16', { label }) }}</label>
        <ElInput :id="`admin-${kind}-name`" v-model="name" :disabled="busy || !!outstanding || stale" />
      </div>
      <div class="tag-metadata-field">
        <label :for="`admin-${kind}-description`">{{ t('admin.tagMetadata.m17', { label }) }}</label>
        <ElInput :id="`admin-${kind}-description`" v-model="description" type="textarea" :disabled="busy || !!outstanding || stale" />
      </div>
      <ElAlert v-if="!normalized" :title="warning" type="warning" :closable="false" />
      <ElInlineActions>
        <ElButton :disabled="busy" @click="emit('close')">{{ t('nav.cancel') }}</ElButton>
        <ElButton v-if="!creating && (stale || !current)" :disabled="busy" @click="load">{{ t('admin.tagMetadata.m18', { kind: kindLabel }) }}</ElButton>
        <ElButton v-if="!stale" native-type="submit" type="primary" :disabled="!normalized || busy" :loading="busy">
          {{ submitLabel }}
        </ElButton>
      </ElInlineActions>
    </form>
    <ElInlineActions v-else>
      <ElButton :disabled="busy" @click="emit('close')">{{ t('nav.cancel') }}</ElButton>
      <ElButton v-if="!creating && (stale || !current)" :disabled="busy" @click="load">{{ t('admin.tagMetadata.m18', { kind: kindLabel }) }}</ElButton>
    </ElInlineActions>
  </div>
</template>

<style scoped lang="scss">
@use '../shared-fields' as fields;

.tag-metadata-editor,
.tag-metadata-form,
.tag-metadata-field {
  display: grid;
  gap: 12px;
}

.tag-metadata-field {
  gap: 6px;
}

.tag-metadata-field label {

  @include fields.admin-label;
}
</style>
