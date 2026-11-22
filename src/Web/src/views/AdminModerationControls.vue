<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElCheckbox, ElCopyableDetail, ElDialog, ElEmptyState,
  ElInlineActions, ElInput, ElResourceList, ElResourceListItem,
  ElSkeleton, ElTag, ElTimeline, ElTimelineItem,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { type AdminCommentCursor } from '../../../Contracts/admin-identity'
import { validModerationReason } from '../../../Contracts/admin-moderation'
import { validModerationCoordinates } from '../../../Contracts/comment-moderation-timeline'
import { WireLimits } from '../../../Contracts/wire.generated'
import {
  AdminModerationController,
  moderationCoordinate as coordinate,
  type ModerationDisplayMessage,
} from '../admin/adminModerationController'
import { useDelayedBusy } from '../delayedBusy'

function displayMessage(message: ModerationDisplayMessage): string {
  if (typeof message === 'string') return t(message)
  if ('conflicts' in message) return t(message.key, {
    unavailable: message.conflicts.map(row => t('admin.moderation.m62', {
      article: row.articleId, comment: row.commentId.toString(),
    })).join(' · '),
  })
  return t(message.key, message.params)
}

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: ApiError] }>()
const batchHeading = ref<HTMLElement>()
const statuses = ['admin.moderation.m1', 'admin.moderation.m2', 'admin.moderation.m3', 'admin.moderation.m4'] as const
const eventLabels: Record<string, MessageKey> = {
  create: 'admin.moderation.m5', approve: 'admin.moderation.m2', reject: 'admin.moderation.m3', hide: 'admin.moderation.m4', edit: 'admin.moderation.m6', delete: 'admin.moderation.m7',
  appeal: 'admin.moderation.m8', appeal_decision: 'admin.moderation.m9',
}

const controller = new AdminModerationController({
  hooks: {
    onSessionLost: error => emit('sessionLost', error),
    onBatchClaimed: async isActive => {
      await nextTick()
      if (isActive()) batchHeading.value?.focus()
    },
  },
})

const state = shallowRef(controller.snapshot())
const unsubscribe = controller.subscribe(() => {
  state.value = controller.snapshot()
})

const queue = computed(() => state.value.queue)
const claim = computed(() => state.value.claim)
const batchClaims = computed(() => state.value.batchClaims)
const selected = computed(() => state.value.selected)
const reason = computed({
  get: () => state.value.reason,
  set: value => controller.setReason(value),
})
const trimmedReason = computed(() => state.value.reason.trim())
const reasonValid = computed(() => validModerationReason(trimmedReason.value))
const batchReason = computed({
  get: () => state.value.batchReason,
  set: value => controller.setBatchReason(value),
})
const trimmedBatchReason = computed(() => state.value.batchReason.trim())
const batchReasonValid = computed(() => validModerationReason(trimmedBatchReason.value))
const batchExpiry = computed(() => {
  const claims = state.value.batchClaims
  return claims && claims.length > 0 ? Math.min(...claims.map(row => Number(row.expiresAt))) : null
})
const selectedTargets = computed(() => state.value.queue?.comments.filter(row => state.value.selected.has(coordinate(row))) ?? [])
const visibleComments = computed(() => state.value.batchClaims ? selectedTargets.value : state.value.queue?.comments ?? [])
const batchAvailable = computed(() => state.value.queue?.batchEnabled === true &&
  state.value.queue.comments.length >= WireLimits.AdminModerationBatchMinimum && !state.value.claim)
const busy = computed(() => state.value.busy)
const failure = computed(() => state.value.failure)
const notice = computed(() => state.value.notice)
const historyArticle = computed({
  get: () => state.value.historyArticle,
  set: value => controller.setHistoryArticle(value),
})
const historyComment = computed({
  get: () => state.value.historyComment,
  set: value => controller.setHistoryComment(value),
})
const historyDialogOpen = computed({
  get: () => state.value.historyDialogOpen,
  set: open => controller.setHistoryDialogOpen(open),
})
const historyLoading = computed(() => state.value.historyLoading)
const historyError = computed(() => state.value.historyError)
const history = computed(() => state.value.history)
const revisions = computed(() => state.value.revisions)
const canReadHistory = computed(() => !state.value.historyLoading &&
  validModerationCoordinates(state.value.historyArticle, state.value.historyComment))

watch(() => props.sessionSignal, signal => {
  controller.bindSession(signal, { autoLoad: true })
}, { immediate: true, flush: 'sync' })

onMounted(() => {
  if (!props.sessionSignal.aborted && !state.value.queue) void controller.load()
})

onUnmounted(() => {
  unsubscribe()
  controller.dispose()
})

const refreshRequested = ref(false)
watch(busy, active => { if (!active) refreshRequested.value = false }, { flush: 'sync' })
const refreshLoading = useDelayedBusy(() => busy.value && refreshRequested.value)

const isClaimed = (row: AdminCommentCursor) => controller.isClaimed(row)
const load = (after: AdminCommentCursor | null = null) => {
  refreshRequested.value = after === null
  return controller.load(after)
}
const openCommentHistory = (row: AdminCommentCursor) => controller.openCommentHistory(row)
const loadHistory = () => controller.loadHistory()
const loadRevisions = (before: number | null = null) => controller.loadRevisions(before)
const claimForReview = (target: AdminCommentCursor) => controller.claimForReview(target)
const renew = () => controller.renew()
const release = () => controller.release()
const decide = (decision: 1 | 2) => controller.decide(decision)
const select = (row: AdminCommentCursor, checked: boolean) => controller.select(row, checked)
const startBatch = () => controller.startBatch()
const cancelBatch = () => controller.cancelBatch()
const decideBatch = (decision: 1 | 2) => controller.decideBatch(decision)
</script>

<template>
  <section class="admin-moderation" aria-labelledby="admin-moderation-heading">
    <h2 id="admin-moderation-heading" class="moderation-sr-title">{{ t('admin.moderation.m32') }}</h2>
    <div class="moderation-panel-actions">
      <ElButton text :disabled="Boolean(claim || batchClaims)" :loading="refreshLoading" @click="load()">{{ t('admin.moderation.refresh') }}</ElButton>
    </div>

    <ElAlert v-if="failure" :title="displayMessage(failure)" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="displayMessage(notice)" type="success" :closable="false" show-icon />
    <ElSkeleton v-if="busy && !queue" animated />

    <template v-if="queue">
      <div v-if="batchAvailable" class="moderation-batch-panel">
        <template v-if="batchClaims && batchExpiry">
          <h3 ref="batchHeading" tabindex="-1">{{ t('admin.moderation.m44') }}</h3>
          <p role="status">{{ t('admin.moderation.m69', { count: batchClaims.length }) }}</p>
          <p class="moderation-expiry">
            {{ t('admin.moderation.m45') }}
            <time :datetime="new Date(batchExpiry).toISOString()">{{ new Date(batchExpiry).toLocaleTimeString() }}</time>
          </p>
          <div class="moderation-field">
            <label for="admin-moderation-batch-reason">{{ t('admin.moderation.m46') }}</label>
            <ElInput id="admin-moderation-batch-reason" v-model="batchReason" type="textarea" :disabled="busy" />
          </div>
          <p v-if="trimmedBatchReason && !batchReasonValid" class="moderation-validation">{{ t('admin.moderation.m47') }}</p>
          <ElInlineActions>
            <ElButton type="primary" :disabled="busy || !batchReasonValid" @click="decideBatch(1)">
              {{ t('admin.moderation.m48') }}
            </ElButton>
            <ElButton :disabled="busy || !batchReasonValid" @click="decideBatch(2)">
              {{ t('admin.moderation.m49') }}
            </ElButton>
            <ElButton :disabled="busy" @click="cancelBatch">{{ t('admin.moderation.m50') }}</ElButton>
          </ElInlineActions>
        </template>
        <div v-else class="moderation-batch-bar">
          <ElButton
            :disabled="busy || selected.size < WireLimits.AdminModerationBatchMinimum" @click="startBatch">{{ t('admin.moderation.m51') }}</ElButton>
          <p class="moderation-status" role="status">
            {{ t('admin.moderation.m70', { count: selected.size, min: WireLimits.AdminModerationBatchMinimum, max: WireLimits.AdminModerationBatchCount }) }}
          </p>
        </div>
      </div>

      <ElEmptyState v-if="queue.comments.length === 0" :title="t('admin.moderation.m52')" role="status" />
      <ElResourceList v-else class="moderation-comments" density="compact">
        <div v-for="item in visibleComments" :key="`${item.articleId}-${item.commentId}`" class="moderation-comment-row" role="listitem">
          <article class="moderation-comment-card">
            <header class="moderation-comment-header">
              <h3>{{ item.displayName }}</h3>
              <p class="moderation-comment-meta">
                {{ t('admin.moderation.m71', { article: item.articleId, comment: item.commentId.toString() }) }}
                · <time :datetime="new Date(item.createdAt).toISOString()">{{ new Date(item.createdAt).toLocaleString() }}</time>
              </p>
            </header>
            <p class="moderation-body">{{ item.body }}</p>
            <div class="moderation-comment-controls">
              <ElCheckbox
                v-if="batchAvailable"
                class="moderation-selection"
                :model-value="selected.has(coordinate(item))"
                :disabled="busy || Boolean(batchClaims) || (selected.size >= WireLimits.AdminModerationBatchCount && !selected.has(coordinate(item)))"
                @update:model-value="select(item, $event === true)"
              >
                {{ t('admin.moderation.m72', { comment: item.commentId.toString() }) }}
              </ElCheckbox>
              <div v-if="claim && isClaimed(item)" class="moderation-claim">
                <p class="moderation-status" role="status">{{ t('admin.moderation.m53') }}</p>
                <p class="moderation-expiry">
                  {{ t('admin.moderation.m54') }}
                  <time :datetime="new Date(Number(claim.expiresAt)).toISOString()">{{ new Date(Number(claim.expiresAt)).toLocaleTimeString() }}</time>
                </p>
                <div class="moderation-field">
                  <label for="admin-moderation-reason">{{ t('admin.moderation.m55') }}</label>
                  <ElInput id="admin-moderation-reason" v-model="reason" type="textarea" :disabled="busy" />
                </div>
                <p v-if="trimmedReason && !reasonValid" class="moderation-validation">{{ t('admin.moderation.m47') }}</p>
                <ElInlineActions>
                  <ElButton type="primary" :disabled="busy || !reasonValid" @click="decide(1)">
                    {{ t('admin.moderation.m56') }}
                  </ElButton>
                  <ElButton :disabled="busy || !reasonValid" @click="decide(2)">
                    {{ t('admin.moderation.m57') }}
                  </ElButton>
                  <ElButton :disabled="busy" @click="renew">{{ t('admin.moderation.m58') }}</ElButton>
                  <ElButton :disabled="busy" @click="release">{{ t('admin.moderation.m59') }}</ElButton>
                </ElInlineActions>
              </div>
              <ElInlineActions v-else-if="!batchClaims">
                <ElButton
                  :disabled="busy || Boolean(claim) || selected.size > 0"
                  @click="claimForReview(item)"
                >{{ t('admin.moderation.m60') }}</ElButton>
                <ElButton
                  text
                  :disabled="busy"
                  @click="openCommentHistory(item)"
                >{{ t('admin.moderation.inspectHistory') }}</ElButton>
              </ElInlineActions>
            </div>
          </article>
        </div>
      </ElResourceList>

      <div v-if="queue.next" class="moderation-more">
        <ElButton text :disabled="busy || Boolean(claim || batchClaims)" @click="load(queue.next)">{{ t('admin.moderation.m61') }}</ElButton>
      </div>
    </template>

    <details class="moderation-lookup-details">
      <summary>{{ t('admin.moderation.lookupById') }}</summary>
      <form id="admin-comment-history-form" class="moderation-lookup-form" @submit.prevent="loadHistory">
        <div class="moderation-lookup-fields">
          <div class="moderation-field">
            <label for="admin-comment-history-article">{{ t('admin.moderation.m35') }}</label>
            <ElInput id="admin-comment-history-article" v-model="historyArticle" v-bind="{ inputmode: 'numeric', maxlength: 10 }" :disabled="busy" />
          </div>
          <div class="moderation-field">
            <label for="admin-comment-history-comment">{{ t('admin.moderation.m36') }}</label>
            <ElInput id="admin-comment-history-comment" v-model="historyComment" v-bind="{ inputmode: 'numeric', maxlength: 19 }" :disabled="busy" />
          </div>
        </div>
        <ElInlineActions>
          <ElButton native-type="submit" :disabled="!canReadHistory">{{ t('admin.moderation.m37') }}</ElButton>
          <ElButton :disabled="!canReadHistory" @click="loadRevisions()">{{ t('admin.moderation.m38') }}</ElButton>
        </ElInlineActions>
      </form>
    </details>

    <ElDialog
      :model-value="historyDialogOpen"
      :title="t('admin.moderation.historyTitle', { article: historyArticle, comment: historyComment })"
      width="min(36rem, 92vw)"
      @update:model-value="visible => { if (!visible) historyDialogOpen = false }"
    >
      <div class="moderation-history-dialog">
        <ElSkeleton v-if="historyLoading" animated />
        <ElAlert v-else-if="historyError" :title="t(historyError)" type="error" :closable="false" />
        <template v-else>
          <template v-if="history">
            <p class="moderation-status" role="status">
              {{ t('admin.moderation.m67', { status: t(history.deleted ? 'admin.moderation.m7' : statuses[history.currentStatus]) }) }}
            </p>
            <ElAlert v-if="!history.consistent" :title="t('admin.moderation.m39')" type="warning" :closable="false" />
            <ElEmptyState v-if="history.events.length === 0" :title="t('admin.moderation.m40')" />
            <ElTimeline v-else class="moderation-timeline">
              <ElTimelineItem
                v-for="(event, index) in history.events"
                :key="index"
                :timestamp="new Date(event.occurredAtUtc).toLocaleString()"
                placement="top"
              >
                <div class="moderation-timeline-event">
                  <div class="moderation-timeline-head">
                    <strong>{{ Object.hasOwn(eventLabels, event.eventType) ? t(eventLabels[event.eventType]) : event.eventType }}</strong>
                    <template v-if="eventLabels[event.eventType] !== statuses[event.nextStatus]"> · {{ t(statuses[event.nextStatus]) }}</template>
                    · {{ event.actorType }}
                    · <time :datetime="event.occurredAtUtc">{{ new Date(event.occurredAtUtc).toLocaleString() }}</time>
                  </div>
                  <p v-if="event.reasonCode" class="moderation-body">{{ event.reasonCode }}</p>
                </div>
              </ElTimelineItem>
            </ElTimeline>
          </template>

          <template v-if="revisions">
            <h4 class="moderation-subheading">{{ t('admin.moderation.m41') }}</h4>
            <ElResourceList class="moderation-revisions" density="compact">
              <ElResourceListItem
                v-for="revision in revisions.rows"
                :key="revision.version"
                :title="t('admin.moderation.m68', { version: revision.version })"
              >
                <template #badge>
                  <ElTag size="small" type="info">{{ revision.operation }}</ElTag>
                </template>
                <template #meta>
                  <time :datetime="revision.createdAtUtc">{{ new Date(revision.createdAtUtc).toLocaleString() }}</time>
                </template>
                <p class="moderation-body">{{ revision.content }}</p>
                <details class="moderation-digest-details">
                  <summary>{{ t('admin.moderation.m42') }}</summary>
                  <ElCopyableDetail :value="revision.contentSha256" />
                </details>
              </ElResourceListItem>
            </ElResourceList>
            <ElInlineActions v-if="revisions.next">
              <ElButton :disabled="!canReadHistory" @click="loadRevisions(revisions.next)">{{ t('admin.moderation.m43') }}</ElButton>
            </ElInlineActions>
          </template>
        </template>
      </div>
      <template #footer>
        <ElInlineActions>
          <ElButton @click="historyDialogOpen = false">{{ t('admin.moderation.closeHistory') }}</ElButton>
        </ElInlineActions>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped lang="scss">
@use '../shared-fields' as fields;

.admin-moderation {
  display: grid;
  gap: var(--fsus-space-2, 12px);
}

.moderation-sr-title {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.moderation-panel-actions {
  display: flex;
  justify-content: flex-end;
}

.moderation-comments {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--el-bg-color);
  overflow: hidden;
}

.moderation-lookup-details {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  padding: 12px 16px;
  background: var(--fsus-color-surface-raised, var(--el-fill-color-light));
}

.moderation-lookup-details summary {
  cursor: pointer;
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-secondary);
}

.moderation-lookup-form {
  margin-top: 12px;
}

.moderation-lookup-form,
.moderation-claim,
.moderation-timeline-event,
.moderation-history-dialog {
  display: grid;
  gap: 10px;
}

.moderation-lookup-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.moderation-field {
  display: grid;
  gap: 6px;
}

.moderation-field label {

  @include fields.admin-label;
}

.moderation-status,
.moderation-expiry,
.moderation-validation,
.moderation-subheading,
.moderation-body {
  margin: 0;
}

.moderation-status,
.moderation-expiry,
.moderation-comment-meta {
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.moderation-comment-meta {
  margin: 0;
}

.moderation-validation {
  font-size: var(--el-font-size-small);
  color: var(--el-color-danger);
}

.moderation-subheading {
  font-size: var(--el-font-size-base);
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.moderation-timeline {
  padding-inline-start: 4px;
  overflow-wrap: anywhere;
}

.moderation-timeline-head {
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.moderation-timeline-head strong {
  color: var(--el-text-color-primary);
}

.moderation-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--el-font-size-base);
  line-height: 1.5;
  color: var(--el-text-color-primary);
}

.moderation-digest-details {
  display: grid;
  gap: 6px;
}

.moderation-digest-details summary {
  cursor: pointer;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}

.moderation-batch-panel {
  display: grid;
  gap: 10px;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--fsus-color-surface-raised, var(--el-fill-color-light));
}

.moderation-batch-panel h3,
.moderation-batch-panel p {
  margin: 0;
}

.moderation-batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.moderation-comment-row {
  padding: 14px 16px;
}

.moderation-comment-row + .moderation-comment-row {
  border-top: 1px solid var(--el-border-color-lighter);
}

.moderation-comment-card {
  display: grid;
  gap: 10px;
}

.moderation-comment-header {
  display: grid;
  gap: 4px;
}

.moderation-comment-header h3 {
  margin: 0;
  font-size: var(--el-font-size-base);
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow-wrap: anywhere;
}

.moderation-comment-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.moderation-selection {
  max-width: 100%;
  height: auto;
  min-height: var(--el-checkbox-height, 2rem);
  margin-inline: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

.moderation-claim {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--fsus-color-surface-raised, var(--el-fill-color-light));
}

.moderation-more {
  display: flex;
  justify-content: flex-start;
}
</style>
