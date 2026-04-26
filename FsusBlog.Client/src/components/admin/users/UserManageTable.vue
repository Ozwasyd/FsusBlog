<template>
  <section class="admin-table-panel">
    <el-table
      v-if="!isMobile"
      v-loading="loading"
      :data="list"
      :row-key="(row: UserListViewItem) => row.id"
      style="width: 100%"
      class="user-table"
    >
      <el-table-column
        prop="id"
        label="ID"
        min-width="80"
        align="center"
        class-name="font-mono text-[#D4D4D8] hidden-sm-and-down"
      />

      <el-table-column label="用户" :min-width="userColumnWidth">
        <template #default="{ row }: { row: UserListViewItem }">
          <div
            class="flex items-center overflow-hidden"
            :class="props.isMobile ? 'gap-2' : 'gap-5 whitespace-nowrap'"
          >
            <el-avatar :size="props.isMobile ? 26 : 32" class="bg-[#F4F4F5] text-[#A1A1AA] font-bold shrink-0">
              {{ row.initials }}
            </el-avatar>
            <p class="min-w-0 flex flex-col justify-center overflow-hidden">
              <span class="truncate text-sm font-bold leading-tight text-[#3F3F46]">
                {{ row.username }}
              </span>
              <time
                v-if="!props.isMobile"
                class="mt-0.5 font-mono text-[10px] tabular-nums text-[#A1A1AA]"
              >
                {{ row.createdAtText }} 注册
              </time>
            </p>
          </div>
        </template>
      </el-table-column>

      <el-table-column prop="role" label="角色" :width="roleColumnWidth" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <span class="text-[10px] font-black italic uppercase" :class="row.roleClass">
            {{ row.roleShort }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="最后活动" width="160" class-name="hidden-md-and-down">
        <template #default="{ row }: { row: UserListViewItem }">
          <time v-if="row.lastLoginTime" class="flex flex-col whitespace-nowrap tabular-nums">
            <span class="text-[11px] text-[#71717A] font-mono">{{ row.lastLoginText }}</span>
            <span class="text-[10px] text-[#D4D4D8] font-mono flex items-center gap-1">
              <el-icon class="text-[8px]"><Location /></el-icon> {{ row.lastLoginIp }}
            </span>
          </time>
          <span v-else class="text-[#D4D4D8] text-[11px] italic">--</span>
        </template>
      </el-table-column>

      <el-table-column prop="status" label="状态" :width="statusColumnWidth" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <span class="inline-flex flex-col items-center justify-center">
            <span class="mb-1 h-1.5 w-1.5 rounded-[var(--fsus-radius-full)]" :class="row.statusDotClass" />
            <span class="text-[10px] font-bold" :class="row.statusClass">
              {{ row.statusText }}
            </span>
          </span>
        </template>
      </el-table-column>

      <el-table-column label="操作" :width="actionColumnWidth" align="right" fixed="right">
        <template #default="{ row }: { row: UserListViewItem }">
          <div
            v-if="!row.isAdmin && !row.isDeleted"
            class="flex items-center justify-end gap-1 pr-1"
          >
            <el-button
              link
              type="primary"
              :icon="Key"
              :disabled="isProcessing"
              size="small"
              aria-label="重置密码"
              title="重置密码"
              @click="emit('open-reset', row)"
            />
            <el-divider direction="vertical" class="mx-0.5" />
            <el-button
              link
              :type="row.status === 0 ? 'danger' : 'success'"
              :icon="row.status === 0 ? 'CircleClose' : 'CircleCheck'"
              size="small"
              class="user-status-action"
              :loading="isProcessing && processingId === row.id"
              @click="emit('toggle-status', row)"
            >
              {{ row.status === 0 ? '封禁' : '解封' }}
            </el-button>
          </div>
          <span v-else-if="row.isDeleted" class="text-[#D4D4D8] text-[9px] italic pr-2">DELETED</span>
          <span v-else class="text-[#D4D4D8] text-[9px] italic pr-2">PROTECTED</span>
        </template>
      </el-table-column>

      <template #empty>
        <el-empty description="暂无用户记录" :image-size="112" />
      </template>
    </el-table>

    <div v-else v-loading="loading" class="user-mobile-list" aria-label="用户列表">
      <article
        v-for="row in list"
        :key="row.id"
        class="user-mobile-card"
      >
        <div class="user-mobile-card-main">
          <el-avatar :size="36" class="shrink-0 bg-[#F4F4F5] text-[#A1A1AA] font-bold">
            {{ row.initials }}
          </el-avatar>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm font-bold leading-tight text-[#3F3F46]">
                {{ row.username }}
              </span>
              <span class="shrink-0 text-[10px] font-black italic uppercase" :class="row.roleClass">
                {{ row.roleShort }}
              </span>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#A1A1AA]">
              <time>{{ row.createdAtText }} 注册</time>
              <span v-if="row.lastLoginText">{{ row.lastLoginText }} 活动</span>
            </div>
          </div>
        </div>

        <div class="user-mobile-status">
          <span class="h-1.5 w-1.5 rounded-[var(--fsus-radius-full)]" :class="row.statusDotClass" />
          <span class="text-xs font-bold" :class="row.statusClass">
            {{ row.statusText }}
          </span>
        </div>

        <div v-if="!row.isAdmin && !row.isDeleted" class="user-mobile-actions">
          <el-button
            type="primary"
            plain
            :icon="Key"
            :disabled="isProcessing"
            @click="emit('open-reset', row)"
          >
            重置密码
          </el-button>
          <el-button
            :type="row.status === 0 ? 'danger' : 'success'"
            plain
            class="user-status-action"
            :loading="isProcessing && processingId === row.id"
            @click="emit('toggle-status', row)"
          >
            {{ row.status === 0 ? '封禁' : '解封' }}
          </el-button>
        </div>
        <div v-else class="user-mobile-protected">
          {{ row.isDeleted ? '已注销账户' : '受保护账户' }}
        </div>
      </article>

      <el-empty v-if="!loading && list.length === 0" description="暂无用户记录" :image-size="112" />
    </div>

    <div class="admin-table-footer">
      <span class="text-[10px] font-semibold uppercase text-[#A1A1AA]">User Directory</span>
      <el-pagination
        :current-page="currentPage"
        :page-size="pageSize"
        :total="total"
        :pager-count="5"
        :layout="isMobile ? 'prev, next' : 'total, sizes, prev, pager, next'"
        background
        class="custom-pagination"
        @update:current-page="emit('update:current-page', $event)"
        @update:page-size="emit('update:page-size', $event)"
        @size-change="emit('refresh')"
        @current-change="emit('refresh')"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Key, Location } from '@element-plus/icons-vue'
import type { UserListItem } from '@/api/admin'
import type { UserListViewItem } from '@/composables/useAdminUserManage'

interface Props {
  loading: boolean
  list: readonly UserListViewItem[]
  total: number
  currentPage: number
  pageSize: number
  isMobile: boolean
  isProcessing: boolean
  processingId: number | null
}

const props = defineProps<Props>()

const userColumnWidth = computed(() => (props.isMobile ? 136 : 220))
const roleColumnWidth = computed(() => (props.isMobile ? 44 : 80))
const statusColumnWidth = computed(() => (props.isMobile ? 56 : 80))
const actionColumnWidth = computed(() => (props.isMobile ? 56 : 120))

const emit = defineEmits<{
  refresh: []
  'open-reset': [row: UserListItem]
  'toggle-status': [row: UserListItem]
  'update:current-page': [value: number]
  'update:page-size': [value: number]
}>()
</script>

<style scoped>
.user-table :deep(.el-table__body-wrapper) {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

:deep(.user-table) {
  --el-table-header-bg-color: rgba(252, 252, 252, 0.96);
  --el-table-header-text-color: #a1a1aa;
  --el-table-row-hover-bg-color: rgba(42, 89, 156, 0.04);
}

:deep(.user-table .el-table__header th) {
  font-size: 0.65rem;
  letter-spacing: 0;
  text-transform: uppercase;
}

:deep(.el-table__inner-wrapper::before) {
  display: none;
}

.custom-pagination {
  gap: 16px;
}

.custom-pagination :deep(.el-pager li) {
  background-color: transparent;
  color: #71717a;
  font-weight: 500;
}

.custom-pagination :deep(.el-pager li.is-active) {
  background-color: #2a599c !important;
  color: white !important;
  font-weight: 800;
}

.user-table :deep(.user-status-action.el-button) {
  position: relative;
  z-index: 1;
}

.user-mobile-list {
  display: grid;
  gap: 0.875rem;
}

.user-mobile-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.875rem;
  border: 1px solid var(--fsus-panel-border);
  border-radius: 16px;
  background: rgba(252, 252, 252, 0.76);
  padding: 1rem;
}

.user-mobile-card-main {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.75rem;
}

.user-mobile-status {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 0.5rem;
  border-radius: var(--fsus-radius-full);
  background: rgba(244, 244, 245, 0.76);
  padding: 0.35rem 0.65rem;
}

.user-mobile-actions {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.625rem;
}

.user-mobile-actions :deep(.el-button) {
  width: 100%;
  min-height: 44px;
  margin-left: 0 !important;
}

.user-mobile-protected {
  border-radius: var(--fsus-radius-sm);
  background: rgba(244, 244, 245, 0.76);
  padding: 0.75rem;
  text-align: center;
  color: #a1a1aa;
  font-size: 0.75rem;
  font-weight: 700;
}

@media (max-width: 639px) {
  .admin-table-footer {
    padding-inline: 0;
  }

  .custom-pagination {
    width: 100%;
  }

  .custom-pagination :deep(.btn-prev),
  .custom-pagination :deep(.btn-next) {
    min-width: 44px;
    min-height: 40px;
  }
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
