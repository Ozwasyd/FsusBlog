<template>
  <div class="account-page comment-moderation-page account-motion-enter w-full">
    <FsusUiPageHeader
      v-if="!embedded"
      title="评论审核"
      content="集中处理评论队列、筛选风险命中项，并执行需要管理员二次验证的审核操作。"
      class="account-page-header--compact"
    />

    <CommentModerationToolbar
      class="mb-0"
      :filters="filters"
      :loading="loading"
      :total="allItems.length"
      :filtered-total="filteredItems.length"
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
import { FsusUiPageHeader } from "@/fsusui"
import CommentModerationBulkActions from '@/components/admin/comment-moderation/CommentModerationBulkActions.vue'
import CommentModerationDetailDrawer from '@/components/admin/comment-moderation/CommentModerationDetailDrawer.vue'
import CommentModerationQueue from '@/components/admin/comment-moderation/CommentModerationQueue.vue'
import CommentModerationToolbar from '@/components/admin/comment-moderation/CommentModerationToolbar.vue'
import { useCommentModerationActions } from '@/composables/useCommentModerationActions'
import {
  commentModerationStatusLabel,
  type CommentModerationFilterKey,
  type CommentModerationViewItem,
  useCommentModerationQueue
} from '@/composables/useCommentModerationQueue'
import type { CommentModerationStatus } from '@/api/authoring'

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
  applyBulk,
  applyBlockAnonymousNullifier,
  applyRevokeAnonymousCredential
} = useCommentModerationActions()
const {
  highlightedKeys: taskFeedbackHighlightedIds
} = taskFeedback

const detailVisible = ref(false)
const detailItem = ref<CommentModerationViewItem | null>(null)
const hasAdditionalQueueFilters = computed(() => activeFilterChips.value.length > 1)
const currentStatusLabel = computed(() => commentModerationStatusLabel(filters.status))
const commentQueueEmptyTitle = computed(() =>
  hasAdditionalQueueFilters.value ? `没有匹配的${currentStatusLabel.value}评论` : `${currentStatusLabel.value}队列暂无评论`
)
const commentQueueEmptyDescription = computed(() =>
  hasAdditionalQueueFilters.value
    ? '调整关键词、文章、用户或风险筛选后再查看；也可以点击上方重置。'
    : '切换状态查看其他审核结果。'
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
  void applyBlockAnonymousNullifier(item, refreshAndPrune)
}

const handleRevokeAnonymousCredential = (item: CommentModerationViewItem): void => {
  void applyRevokeAnonymousCredential(item, refreshAndPrune)
}

watch(
  () => filteredItems.value.map((item) => item.id).join(','),
  () => pruneVisibleSelection()
)

onMounted(() => {
  void refreshAndPrune()
})
</script>
