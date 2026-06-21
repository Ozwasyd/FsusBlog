<template>
  <div class="account-page">
    <header class="account-page-header">
      <h1 class="account-page-title">匿名账号治理</h1>
      <p class="account-page-description">
        管理匿名账号容器、凭据状态与封禁操作。
      </p>
    </header>

    <UserManageHeader
      :total="total"
      :keyword="queryParams.keyword ?? ''"
      :status="queryParams.status"
      :loading="loading"
      :active-filters="activeFilterChips"
      @search="handleSearch"
      @reset="resetFilters"
      @remove-filter="removeFilter"
      @update:keyword="onKeywordChange"
      @update:status="onStatusChange"
    />

    <UserManageTable
      :loading="loading"
      :list="listView"
      :total="total"
      :current-page="queryParams.page"
      :page-size="queryParams.pageSize"
      :is-processing="isProcessing"
      :processing-id="processingId"
      :row-motion-class="rowMotion.classFor"
      :empty-title="userTableEmptyTitle"
      :empty-description="userTableEmptyDescription"
      :has-active-filters="userTableHasActiveFilters"
      @refresh="fetchData"
      @toggle-status="handleToggleStatus"
      @reset-filters="resetFilters"
      @update:current-page="onPageChange"
      @update:page-size="onPageSizeChange"
    />

    <UserBanDialog
      v-model:visible="banDialog.visible"
      :reason="banDialog.reason"
      :quick-reasons="banDialog.quickReasons"
      :is-processing="isProcessing"
      :is-calculating="isCalculating"
      :target-account-label="banDialog.targetUser?.displayHandle ?? ''"
      :target-initials="getTargetInitials(banDialog.targetUser)"
      :confirm-account-label="banDialog.confirmAccountLabel"
      :validation="banReasonValidation"
      :can-submit="canSubmitBan"
      @update:reason="onBanReasonChange"
      @update:confirm-account-label="onBanConfirmChange"
      @submit="handleBanSubmit"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UserBanDialog from '@/components/admin/users/UserBanDialog.vue'
import UserManageHeader from '@/components/admin/users/UserManageHeader.vue'
import UserManageTable from '@/components/admin/users/UserManageTable.vue'
import { useAdminUserManage } from '@/composables/useAdminUserManage'

const {
  loading,
  listView,
  total,
  queryParams,
  isCalculating,
  processingId,
  isProcessing,
  banDialog,
  activeFilterChips,
  rowMotion,
  banReasonValidation,
  canSubmitBan,
  fetchData,
  onKeywordChange,
  onStatusChange,
  onPageChange,
  onPageSizeChange,
  onBanReasonChange,
  onBanConfirmChange,
  handleSearch,
  resetFilters,
  removeFilter,
  handleToggleStatus,
  handleBanSubmit,
  getTargetInitials
} = useAdminUserManage()

const userTableHasActiveFilters = computed(() => activeFilterChips.value.length > 0)
const userTableEmptyTitle = computed(() => userTableHasActiveFilters.value ? '没有匹配的账号' : '暂无匿名账号记录')
const userTableEmptyDescription = computed(() =>
  userTableHasActiveFilters.value
    ? '调整关键词或清除筛选。'
    : '匿名账号初始化后会显示在这里。'
)
</script>

<style scoped>
@reference "@/assets/main.css";

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
