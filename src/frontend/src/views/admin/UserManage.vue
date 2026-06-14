<template>
  <div class="account-page">
    <header class="account-page-header">
      <h1 class="account-page-title">用户管理</h1>
      <p class="account-page-description">
        管理账户状态、密码重置与封禁操作。
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
      :is-mobile="isMobile"
      :is-processing="isProcessing"
      :processing-id="processingId"
      :row-motion-class="rowMotion.classFor"
      :empty-title="userTableEmptyTitle"
      :empty-description="userTableEmptyDescription"
      :has-active-filters="userTableHasActiveFilters"
      @refresh="fetchData"
      @open-reset="openResetDialog"
      @toggle-status="handleToggleStatus"
      @reset-filters="resetFilters"
      @update:current-page="onPageChange"
      @update:page-size="onPageSizeChange"
    />

    <UserResetPasswordDialog
      v-model:visible="resetDialog.visible"
      :is-processing="isProcessing"
      :is-calculating="isCalculating"
      :target-username="resetDialog.targetUser?.username ?? ''"
      :password="resetDialog.form.newPassword"
      :confirm-username="resetDialog.form.confirmUsername"
      :password-policy="resetPasswordPolicy"
      :can-submit="canSubmitResetPassword"
      @update:password="onResetPasswordChange"
      @update:confirm-username="onResetPasswordConfirmChange"
      @generate-password="generateStrongPassword"
      @copy-password="copyResetPassword"
      @submit="handleResetSubmit"
    />

    <UserBanDialog
      v-model:visible="banDialog.visible"
      :reason="banDialog.reason"
      :quick-reasons="banDialog.quickReasons"
      :is-processing="isProcessing"
      :is-calculating="isCalculating"
      :target-username="banDialog.targetUser?.username ?? ''"
      :target-initials="getTargetInitials(banDialog.targetUser)"
      :confirm-username="banDialog.confirmUsername"
      :validation="banReasonValidation"
      :can-submit="canSubmitBan"
      @update:reason="onBanReasonChange"
      @update:confirm-username="onBanConfirmChange"
      @submit="handleBanSubmit"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UserBanDialog from '@/components/admin/users/UserBanDialog.vue'
import UserManageHeader from '@/components/admin/users/UserManageHeader.vue'
import UserManageTable from '@/components/admin/users/UserManageTable.vue'
import UserResetPasswordDialog from '@/components/admin/users/UserResetPasswordDialog.vue'
import { useAdminUserManage } from '@/composables/useAdminUserManage'

const {
  isMobile,
  loading,
  listView,
  total,
  queryParams,
  isCalculating,
  processingId,
  isProcessing,
  resetDialog,
  banDialog,
  activeFilterChips,
  rowMotion,
  resetPasswordPolicy,
  canSubmitResetPassword,
  banReasonValidation,
  canSubmitBan,
  fetchData,
  onKeywordChange,
  onStatusChange,
  onPageChange,
  onPageSizeChange,
  onBanReasonChange,
  onResetPasswordChange,
  onResetPasswordConfirmChange,
  onBanConfirmChange,
  handleSearch,
  resetFilters,
  removeFilter,
  handleToggleStatus,
  handleBanSubmit,
  openResetDialog,
  handleResetSubmit,
  generateStrongPassword,
  copyResetPassword,
  getTargetInitials
} = useAdminUserManage()

const userTableHasActiveFilters = computed(() => activeFilterChips.value.length > 0)
const userTableEmptyTitle = computed(() => userTableHasActiveFilters.value ? '没有匹配的用户' : '暂无用户记录')
const userTableEmptyDescription = computed(() =>
  userTableHasActiveFilters.value
    ? '调整关键词或清除筛选。'
    : '创建或导入用户后会显示在这里。'
)
</script>

<style scoped>
@reference "@/assets/main.css";

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
