<template>
  <div class="account-page">
    <FsusUiTaskPageHeader
      title="匿名账号治理"
      class="account-task-page-header"
    />

    <CollectionWorkbench
      title="匿名账号"
      title-id="user-manage-list-title"
      :meta="`共 ${total} 条记录 · 封禁与解封会触发强制算力校验。`"
      :state="userWorkbenchState"
      :busy="loading"
    >
      <template #primary-filter>
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
      </template>

      <template #loading>
        <div class="px-4 py-6" aria-busy="true"><el-skeleton :rows="6" animated /></div>
      </template>

      <template #empty>
        <AdminInlineEmptyState :title="userTableEmptyTitle" :description="userTableEmptyDescription">
          <template v-if="userTableHasActiveFilters" #actions>
            <el-button @click="resetFilters">清除筛选</el-button>
          </template>
        </AdminInlineEmptyState>
      </template>

      <template #results>
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
      </template>

      <template v-if="total > 0" #pagination>
        <el-pagination
          :current-page="queryParams.page"
          :page-size="queryParams.pageSize"
          :total="total"
          :pager-count="5"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          @current-change="onPageChange"
          @size-change="onPageSizeChange"
        />
      </template>
    </CollectionWorkbench>

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
import { FsusUiTaskPageHeader } from '@/fsusui'
import { computed } from 'vue'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import CollectionWorkbench from '@/components/admin/CollectionWorkbench.vue'
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
const userWorkbenchState = computed(() => loading.value && listView.value.length === 0
  ? 'loading'
  : listView.value.length > 0
    ? 'ready'
    : 'empty')
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
