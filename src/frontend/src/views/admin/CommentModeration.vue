<template>
  <div class="account-page comment-moderation-page account-motion-enter w-full">
    <AccountPageHeader
      v-if="!embedded"
      title="评论审核"
      description="集中处理评论队列、筛选风险命中项，并执行需要管理员二次验证的审核操作。"
      compact
    />

    <CommentModerationToolbar
      class="mb-0"
      :filters="filters"
      :loading="loading"
      :total="allItems.length"
      :filtered-total="filteredItems.length"
      :counters="counters"
      :hit-reason-options="hitReasonOptions"
      :blocked-region-options="blockedRegionOptions"
      :model-label-options="modelLabelOptions"
      :model-provider-options="modelProviderOptions"
      :active-filters="activeFilterChips"
      @refresh="refreshAndPrune"
      @search="refreshAndPrune"
      @reset="resetAndPrune"
      @remove-filter="removeFilterAndPrune"
      @update:status="updateStatus"
      @update:keyword="filters.keyword = $event"
      @update:article="filters.article = $event"
      @update:user="filters.user = $event"
      @update:hit-reason="filters.hitReason = $event"
      @update:blocked-region="filters.blockedRegion = $event"
      @update:model-label="filters.modelLabel = $event"
      @update:model-provider="filters.modelProvider = $event"
      @update:date-range="filters.dateRange = $event"
    />

    <AdminTaskFeedbackBar
      class="border-t border-[var(--fsusblog-panel-border)]"
      :phase="taskFeedbackPhase"
      :message="taskFeedbackMessage"
      :detail="taskFeedbackDetail"
      :aria-message="taskFeedbackAriaMessage"
      :assertive-message="taskFeedbackAssertiveMessage"
      :busy="taskFeedbackBusy"
    />

    <CommentModerationBulkActions
      class="blog-motion-task-region"
      :class="{ 'blog-motion-task-region--pending': processingBulk }"
      :selected-count="selectedIds.length"
      :reason="actionReason"
      :ban-users="banUsers"
      :loading="processingBulk"
      @update:reason="actionReason = $event"
      @update:ban-users="banUsers = $event"
      @clear="clearSelection"
      @apply="(status) => applyBulk(status, refreshAndPrune)"
    />

    <CommentModerationQueue
      :items="filteredItems"
      :selected-ids="selectedIds"
      :loading="loading"
      :processing-id="processingId"
      :highlighted-ids="taskFeedbackHighlightedIds"
      :empty-title="commentQueueEmptyTitle"
      :empty-description="commentQueueEmptyDescription"
      @toggle="toggleSelection"
      @detail="openDetail"
      @apply="(item, status) => applySingle(item, status, refreshAndPrune)"
      @block-anonymous-nullifier="handleBlockAnonymousNullifier"
      @revoke-anonymous-credential="handleRevokeAnonymousCredential"
    />

    <CommentModerationDetailDrawer
      v-model:visible="detailVisible"
      :item="detailItem"
      :processing="isProcessing"
      @apply="(item, status) => applySingle(item, status, refreshAndPrune)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import AdminTaskFeedbackBar from '@/components/admin/AdminTaskFeedbackBar.vue'
import CommentModerationBulkActions from '@/components/admin/comment-moderation/CommentModerationBulkActions.vue'
import CommentModerationDetailDrawer from '@/components/admin/comment-moderation/CommentModerationDetailDrawer.vue'
import CommentModerationQueue from '@/components/admin/comment-moderation/CommentModerationQueue.vue'
import CommentModerationToolbar from '@/components/admin/comment-moderation/CommentModerationToolbar.vue'
import { useCommentModerationActions } from '@/composables/useCommentModerationActions'
import {
  type CommentModerationFilterKey,
  type CommentModerationViewItem,
  useCommentModerationQueue
} from '@/composables/useCommentModerationQueue'
import type { CommentModerationStatus } from '@/api/authoring'
import { showWarningToast } from '@/utils/errorPresentation'

withDefaults(defineProps<{
  embedded?: boolean
}>(), {
  embedded: false
})

const {
  loading,
  filters,
  allItems,
  filteredItems,
  counters,
  hitReasonOptions,
  blockedRegionOptions,
  modelLabelOptions,
  modelProviderOptions,
  activeFilterChips,
  refreshQueue,
  setStatus,
  resetFilters,
  removeFilter
} = useCommentModerationQueue({ limit: 100 })

const {
  selectedIds,
  actionReason,
  banUsers,
  processingId,
  processingBulk,
  isProcessing,
  taskFeedback,
  toggleSelection,
  clearSelection,
  pruneSelection,
  applySingle,
  applyBulk
} = useCommentModerationActions()
const {
  phase: taskFeedbackPhase,
  message: taskFeedbackMessage,
  detail: taskFeedbackDetail,
  assertiveMessage: taskFeedbackAssertiveMessage,
  busy: taskFeedbackBusy,
  ariaMessage: taskFeedbackAriaMessage,
  highlightedKeys: taskFeedbackHighlightedIds
} = taskFeedback

const detailVisible = ref(false)
const detailItem = ref<CommentModerationViewItem | null>(null)
const hasAdditionalQueueFilters = computed(() => activeFilterChips.value.length > 1)
const commentQueueEmptyTitle = computed(() =>
  hasAdditionalQueueFilters.value ? '没有匹配的评论审核项' : '当前队列暂无评论'
)
const commentQueueEmptyDescription = computed(() =>
  hasAdditionalQueueFilters.value
    ? '调整关键词、文章、用户或风险筛选后再查看；也可以点击上方重置。'
    : '切换状态可查看已隐藏或已拒绝评论，新的待审核评论会自动进入队列。'
)

const pruneVisibleSelection = (): void => {
  pruneSelection(filteredItems.value.map((item) => item.id))
  if (detailItem.value && !filteredItems.value.some((item) => item.id === detailItem.value?.id)) {
    detailVisible.value = false
    detailItem.value = null
  }
}

const refreshAndPrune = async (): Promise<void> => {
  await refreshQueue()
  pruneVisibleSelection()
}

const resetAndPrune = async (): Promise<void> => {
  await resetFilters()
  pruneVisibleSelection()
}

const removeFilterAndPrune = async (key: CommentModerationFilterKey): Promise<void> => {
  await removeFilter(key)
  pruneVisibleSelection()
}

const updateStatus = async (status: CommentModerationStatus): Promise<void> => {
  await setStatus(status)
  pruneVisibleSelection()
}

const openDetail = (item: CommentModerationViewItem): void => {
  detailItem.value = item
  detailVisible.value = true
}

const handleBlockAnonymousNullifier = (item: CommentModerationViewItem): void => {
  if (!item.canBlockAnonymousNullifier) {
    showWarningToast('当前管理员没有封禁匿名 Nullifier 的权限')
    return
  }

  showWarningToast(`Nullifier 封禁 API 尚未接入；已保留 ${item.actorDisplayName} 的匿名治理动作，不提供账号反查。`)
}

const handleRevokeAnonymousCredential = (item: CommentModerationViewItem): void => {
  if (!item.canRevokeAnonymousCredential) {
    showWarningToast('当前管理员没有撤销匿名凭证的权限')
    return
  }

  showWarningToast(`匿名凭证撤销 API 尚未接入；已保留 ${item.actorDisplayName} 的凭证治理动作，不提供账号反查。`)
}

watch(
  () => filteredItems.value.map((item) => item.id).join(','),
  () => pruneVisibleSelection()
)

onMounted(() => {
  void refreshAndPrune()
})
</script>
