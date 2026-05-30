<template>
  <div class="account-page">
    <header class="account-page-header">
      <div class="account-page-eyebrow">管理</div>
      <h1 class="account-page-title">用户管理</h1>
      <p class="account-page-description">
        筛选账户、查看状态并执行封禁、解封与密码重置等高风险操作。
      </p>
    </header>

    <UserManageHeader
      :total="total"
      :keyword="queryParams.keyword ?? ''"
      :status="queryParams.status"
      :loading="loading"
      @search="handleSearch"
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
      @refresh="fetchData"
      @open-reset="openResetDialog"
      @toggle-status="handleToggleStatus"
      @update:current-page="onPageChange"
      @update:page-size="onPageSizeChange"
    />

    <UserResetPasswordDialog
      v-model:visible="resetDialog.visible"
      :is-processing="isProcessing"
      :is-calculating="isCalculating"
      :target-username="resetDialog.targetUser?.username ?? ''"
      :password="resetDialog.form.newPassword"
      @update:password="onResetPasswordChange"
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
      @update:reason="onBanReasonChange"
      @submit="handleBanSubmit"
    />
  </div>
</template>

<script setup lang="ts">
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
  fetchData,
  onKeywordChange,
  onStatusChange,
  onPageChange,
  onPageSizeChange,
  onBanReasonChange,
  onResetPasswordChange,
  handleSearch,
  handleToggleStatus,
  handleBanSubmit,
  openResetDialog,
  handleResetSubmit,
  getTargetInitials
} = useAdminUserManage()
</script>

<style scoped>
@reference "@/assets/main.css";

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
