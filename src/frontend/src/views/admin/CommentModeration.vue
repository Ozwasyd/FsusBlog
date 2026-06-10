<template>
  <div class="account-page comment-moderation-page account-motion-enter w-full">
    <AccountPageHeader
      eyebrow="管理 / MODERATION"
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
      @update:date-range="filters.dateRange = $event"
    />

    <CommentModerationBulkActions
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
      @toggle="toggleSelection"
      @detail="openDetail"
      @apply="(item, status) => applySingle(item, status, refreshAndPrune)"
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
import { onMounted, ref, watch } from 'vue'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
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

const {
  loading,
  filters,
  allItems,
  filteredItems,
  counters,
  hitReasonOptions,
  blockedRegionOptions,
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
  toggleSelection,
  clearSelection,
  pruneSelection,
  applySingle,
  applyBulk
} = useCommentModerationActions()

const detailVisible = ref(false)
const detailItem = ref<CommentModerationViewItem | null>(null)

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

watch(
  () => filteredItems.value.map((item) => item.id).join(','),
  () => pruneVisibleSelection()
)

onMounted(() => {
  void refreshAndPrune()
})
</script>
