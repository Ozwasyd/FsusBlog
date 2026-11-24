<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElCheckbox, ElDangerZone, ElEmptyState, ElFormSection,
  ElInput, ElKeyValueGrid, ElKeyValueItem, ElSettingsSection, ElSkeleton,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  executeAdminArticleDraftRollback, readAdminArticleDraftRollbackAvailability, requestAdminArticleDraftRollbackProof,
  executeAdminArticleRollback, isValidAdminArticleRollbackReason, readAdminArticleRollbackAvailability,
  readAdminArticleRollbackPreview, requestAdminArticleRollbackProof,
  type AdminArticleDraftRollbackIntent, type AdminArticleDraftRollbackReceipt,
  type AdminArticleRollbackIntent, type AdminArticleRollbackPreview, type AdminArticleRollbackReceipt,
} from '../../../Contracts/admin-article-rollback'
import AdminArticleArchive from './AdminArticleArchive.vue'

type RollbackIntent = AdminArticleRollbackIntent | AdminArticleDraftRollbackIntent
type RollbackReceipt = AdminArticleRollbackReceipt | AdminArticleDraftRollbackReceipt

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [cause: unknown]; busy: [value: boolean] }>()
const lifetime = new AbortController()
const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
const available = ref(false)
const checkingAvailability = ref(true)
const draftAvailable = ref(false)
const articleId = ref('')
const sourceRevision = ref('')
const reason = ref('')
const confirmed = ref(false)
const draftReason = ref('')
const draftConfirmed = ref(false)
const busy = ref(false)
const archiveWorking = ref(false)
const error = ref<MessageKey | ''>('')
const preview = shallowRef<AdminArticleRollbackPreview>()
const retry = shallowRef<RollbackIntent>()
const receipt = shallowRef<RollbackReceipt>()
const sourceCoordinates = computed(() => {
  if (!/^[1-9][0-9]{0,9}$/.test(articleId.value) || !/^[1-9][0-9]{0,18}$/.test(sourceRevision.value)) return
  const article = Number(articleId.value)
  const source = BigInt(sourceRevision.value)
  if (article <= 2_147_483_647 && source <= 9_223_372_036_854_775_807n) return { article, source }
})
const editingLocked = computed(() => busy.value || !!retry.value || archiveWorking.value)
watch(editingLocked, value => emit('busy', value), { immediate: true, flush: 'sync' })
const canRollback = computed(() => !!preview.value?.packageComplete && !editingLocked.value)
const canPublish = computed(() => canRollback.value &&
  confirmed.value && isValidAdminArticleRollbackReason(reason.value.trim()))
const canRestoreDraft = computed(() => canRollback.value && draftAvailable.value &&
  draftConfirmed.value && isValidAdminArticleRollbackReason(draftReason.value.trim()))
const receiptTitle = computed(() => {
  const result = receipt.value
  if (!result) return ''
  return 'privateReleaseId' in result
    ? t('admin.rollback.restored', { revision: String(result.revision) })
    : t('admin.rollback.published', { revision: String(result.revision), publication: String(result.publicationId) })
})
const draftRetry = computed(() => retry.value !== undefined && 'targetStatus' in retry.value)
const blockers = computed(() => [
  '', t('admin.rollback.noRights'), t('admin.rollback.noResponsibility'),
  t('admin.rollback.attachments'), t('admin.rollback.schedule'),
  t('admin.rollback.draft'),
])

function resetPreview() {
  preview.value = undefined
  receipt.value = undefined
  error.value = ''
  confirmed.value = false
  draftConfirmed.value = false
}

async function readPreview() {
  const coordinates = sourceCoordinates.value
  if (!coordinates || editingLocked.value || signal.aborted) return
  resetPreview()
  busy.value = true
  try {
    const result = await readAdminArticleRollbackPreview(coordinates.article, coordinates.source, signal)
    if (!signal.aborted) preview.value = result
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401) emit('session-lost', cause)
    else if (cause instanceof ApiError && cause.status === 404) error.value = 'admin.rollback.unavailable'
    else if (cause instanceof ApiError && cause.status === 409) error.value = 'admin.rollback.resolveChanges'
    else error.value = 'admin.rollback.loadFailed'
  } finally { busy.value = false }
}

function accept(next: RollbackReceipt) {
  receipt.value = next
  retry.value = undefined
  preview.value = undefined
  reason.value = ''
  confirmed.value = false
  draftReason.value = ''
  draftConfirmed.value = false
}

function execute(intent: RollbackIntent, proof?: string): Promise<RollbackReceipt> {
  return 'targetStatus' in intent
    ? executeAdminArticleDraftRollback(intent, proof, signal)
    : executeAdminArticleRollback(intent, proof, signal)
}

async function rollback(toDraft: boolean) {
  const base = preview.value
  if (!base || !(toDraft ? canRestoreDraft.value : canPublish.value) || signal.aborted) return
  const coordinates: AdminArticleRollbackIntent = {
    articleId: base.articleId,
    expectedRevision: base.currentRevision,
    expectedPublicationId: base.currentPublicationId,
    sourceRevision: base.sourceRevision,
    idempotencyKey: crypto.randomUUID(),
    reason: (toDraft ? draftReason.value : reason.value).trim(),
  }
  const intent = toDraft ? { ...coordinates, targetStatus: 0 } : coordinates
  busy.value = true
  error.value = ''
  let attempted = false
  try {
    const proof = await ('targetStatus' in intent
      ? requestAdminArticleDraftRollbackProof(intent, signal)
      : requestAdminArticleRollbackProof(intent, signal))
    if (signal.aborted) return
    attempted = true
    const saved = await execute(intent, proof)
    if (!signal.aborted) accept(saved)
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
      error.value = 'admin.archive.passkeyCanceled'
    } else if (cause instanceof ApiError && cause.status === 409) {
      preview.value = undefined
      error.value = 'admin.rollback.changed'
    } else if (!attempted && cause instanceof ApiError && cause.status === 401) {
      emit('session-lost', cause)
    } else if (attempted && (!(cause instanceof ApiError) || cause.status >= 500)) {
      retry.value = intent
      error.value = toDraft ? 'admin.rollback.draftUnknown'
        : 'admin.rollback.publicUnknown'
    } else {
      error.value = toDraft ? 'admin.rollback.draftFailed'
        : 'admin.rollback.publicFailed'
    }
    confirmed.value = false
    draftConfirmed.value = false
  } finally { busy.value = false }
}

async function checkReceipt() {
  const intent = retry.value
  if (!intent || busy.value || archiveWorking.value || signal.aborted) return
  busy.value = true
  error.value = ''
  try {
    const stored = await execute(intent)
    if (!signal.aborted) accept(stored)
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status < 500) {
      retry.value = undefined
      preview.value = undefined
      error.value = 'admin.rollback.recoverFailed'
    } else {
      error.value = 'targetStatus' in intent ? 'admin.rollback.draftStillUnknown'
        : 'admin.rollback.publicStillUnknown'
    }
  } finally { busy.value = false }
}

onMounted(async () => {
  try {
    const enabled = await readAdminArticleRollbackAvailability(signal)
    if (signal.aborted || !enabled) return
    available.value = true
    const canDraft = await readAdminArticleDraftRollbackAvailability(signal)
    if (!signal.aborted) draftAvailable.value = canDraft
  } catch {
    // Only show actions whose independent availability checks succeeded.
  } finally { if (!signal.aborted) checkingAvailability.value = false }
})
onScopeDispose(() => lifetime.abort())
</script>

<template>
  <ElSkeleton v-if="checkingAvailability" :rows="3" />
  <ElEmptyState v-else-if="!available" :title="t('admin.rollback.unavailable')" size="compact" />
  <ElSettingsSection
    v-if="available"
    class="article-rollback"
    ariaLabelledby="admin-article-rollback-heading"
    v-bind="{ 'aria-busy': busy || archiveWorking }"
    density="compact"
  >
    <template #title>
      <span id="admin-article-rollback-heading">{{ t('admin.rollback.heading') }}</span>
    </template>

    <ElFormSection density="compact">
      <form class="rollback-lookup-form" @submit.prevent="readPreview">
        <div class="rollback-lookup-fields">
          <div class="rollback-field">
            <label for="admin-rollback-article">{{ t('admin.moderation.m35') }}</label>
            <ElInput id="admin-rollback-article" v-model="articleId" v-bind="{ inputmode: 'numeric' }" :disabled="editingLocked" @input="resetPreview" />
          </div>
          <div class="rollback-field">
            <label for="admin-rollback-source">{{ t('admin.rollback.historicalRevision') }}</label>
            <ElInput id="admin-rollback-source" v-model="sourceRevision" v-bind="{ inputmode: 'numeric' }" :disabled="editingLocked" @input="resetPreview" />
          </div>
        </div>
        <div>
          <ElButton native-type="submit" :disabled="!sourceCoordinates || editingLocked">{{ t('admin.rollback.preview') }}</ElButton>
        </div>
      </form>
    </ElFormSection>

    <ElAlert v-if="error" :title="t(error)" type="error" :closable="false" />
    <ElAlert v-if="receiptTitle" :title="receiptTitle" type="success" :closable="false" />

    <div v-if="retry">
      <ElButton native-type="button" :loading="busy" @click="checkReceipt">
        {{ draftRetry ? t('admin.rollback.checkDraft') : t('admin.rollback.checkPublic') }}
      </ElButton>
    </div>

    <div v-else-if="preview" class="rollback-preview">
      <h3>{{ preview.sourceTitle }}</h3>
      <ElKeyValueGrid density="compact">
        <ElKeyValueItem :label="t('admin.rollback.currentRevision')" :value="String(preview.currentRevision)" />
        <ElKeyValueItem :label="t('admin.rollback.currentPublication')" :value="String(preview.currentPublicationId)" />
        <ElKeyValueItem :label="t('admin.rollback.sourceRevision')" :value="String(preview.sourceRevision)" />
        <ElKeyValueItem :label="t('admin.rollback.sourcePublication')" :value="String(preview.sourcePublicationId)" />
      </ElKeyValueGrid>

      <ElAlert v-if="!preview.packageComplete" :title="blockers[preview.blockingReason]" type="warning" :closable="false" />
      <template v-else>
        <ElFormSection density="compact">
          <div class="rollback-field">
            <label for="admin-rollback-reason">{{ t('admin.rollback.reason') }}</label>
            <ElInput id="admin-rollback-reason" v-model="reason" type="textarea" :disabled="editingLocked" @input="confirmed = false" />
          </div>
          <ElCheckbox :model-value="confirmed" :disabled="editingLocked" @update:model-value="confirmed = $event === true">
            {{ t('admin.rollback.confirmPublic') }}
          </ElCheckbox>
          <div>
            <ElButton native-type="button" type="primary" :disabled="!canPublish" :loading="busy" @click="rollback(false)">
              {{ t('admin.rollback.publish') }}
            </ElButton>
          </div>
        </ElFormSection>

        <ElDangerZone v-if="draftAvailable" class="draft-rollback" density="compact">
          <div class="rollback-field">
            <label for="admin-rollback-draft-reason">{{ t('admin.rollback.draftReason') }}</label>
            <ElInput id="admin-rollback-draft-reason" v-model="draftReason" type="textarea" :disabled="editingLocked" @input="draftConfirmed = false" />
          </div>
          <ElCheckbox :model-value="draftConfirmed" :disabled="editingLocked" @update:model-value="draftConfirmed = $event === true">
            {{ t('admin.rollback.confirmDraft') }}
          </ElCheckbox>
          <div>
            <ElButton native-type="button" type="danger" plain :disabled="!canRestoreDraft" :loading="busy" @click="rollback(true)">
              {{ t('admin.rollback.restoreDraft') }}
            </ElButton>
          </div>
        </ElDangerZone>
      </template>
    </div>

    <AdminArticleArchive
      :session-signal="signal"
      :preview="preview"
      :blocked="busy || !!retry"
      @working-change="archiveWorking = $event"
      @invalidate-review="resetPreview()"
      @session-lost="emit('session-lost', $event)"
    />
  </ElSettingsSection>
</template>

<style scoped lang="scss">
@use '../review-panel' as layout;
@use '../shared-fields' as fields;

.rollback-lookup-form,
.rollback-preview,
.rollback-field {
  display: grid;
  gap: 10px;
}

.rollback-lookup-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.rollback-field label {

  @include fields.admin-label;
}

.rollback-preview h3 {
  @include layout.review-item-heading;
}
</style>
