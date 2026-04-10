<template>
  <el-card shadow="never" class="list-card border-none rounded-xl overflow-hidden min-h-125">
    <el-table
      v-loading="loading"
      :data="list"
      :row-key="(row: UserListViewItem) => row.id"
      stripe
      style="width: 100%"
      class="user-table"
    >
      <el-table-column prop="id" label="ID" min-width="80" align="center" class-name="font-mono text-zinc-300 hidden-sm-and-down" />

      <el-table-column label="用户" min-width="220">
        <template #default="{ row }: { row: UserListViewItem }">
          <div class="flex items-center gap-3 whitespace-nowrap overflow-visible">
            <el-avatar :size="32" class="bg-zinc-100 text-zinc-400 font-bold shrink-0">
              {{ row.initials }}
            </el-avatar>
            <div class="flex flex-col justify-center">
              <div class="font-bold text-zinc-700 text-sm leading-tight">
                {{ row.username }}
              </div>
              <div class="text-[10px] text-zinc-400 font-mono mt-0.5 tabular-nums">
                {{ row.createdAtText }} 注册
              </div>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column prop="role" label="角色" width="80" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <span class="text-[10px] font-black italic uppercase" :class="row.roleClass">
            {{ row.roleShort }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="最后活动" width="160" class-name="hidden-md-and-down">
        <template #default="{ row }: { row: UserListViewItem }">
          <div v-if="row.lastLoginTime" class="flex flex-col whitespace-nowrap tabular-nums">
            <span class="text-[11px] text-zinc-600 font-mono">{{ row.lastLoginText }}</span>
            <span class="text-[10px] text-zinc-300 font-mono flex items-center gap-1">
              <el-icon class="text-[8px]"><Location /></el-icon> {{ row.lastLoginIp }}
            </span>
          </div>
          <span v-else class="text-zinc-300 text-[11px] italic">--</span>
        </template>
      </el-table-column>

      <el-table-column prop="status" label="状态" width="80" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <div class="flex flex-col items-center justify-center">
            <div class="w-1.5 h-1.5 rounded-full mb-1" :class="row.statusDotClass" />
            <span class="text-[10px] font-bold" :class="row.statusClass">
              {{ row.statusText }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="120" align="right" :fixed="isMobile ? false : 'right'">
        <template #default="{ row }: { row: UserListViewItem }">
          <div v-if="!row.isAdmin" class="flex justify-end items-center gap-1 pr-1">
            <el-button link type="primary" :icon="Key" :disabled="isProcessing" size="small" @click="emit('open-reset', row)" />
            <el-divider direction="vertical" class="mx-0.5" />
            <el-button
              link
              :type="row.status === 0 ? 'danger' : 'success'"
              :icon="row.status === 0 ? 'CircleClose' : 'CircleCheck'"
              size="small"
              :loading="isProcessing && processingId === row.id"
              @click="emit('toggle-status', row)"
            >
              {{ row.status === 0 ? '封禁' : '解封' }}
            </el-button>
          </div>
          <span v-else class="text-zinc-300 text-[9px] italic pr-2">PROTECTED</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="flex justify-end mt-6 mb-2 px-2 sm:px-4">
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
  </el-card>
</template>

<script setup lang="ts">
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

defineProps<Props>()

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

:deep(.el-table__inner-wrapper::before) {
  display: none;
}

.custom-pagination :deep(.el-pager li) {
  background-color: transparent;
  color: #71717a;
  font-weight: 500;
}

.custom-pagination :deep(.el-pager li.is-active) {
  background-color: #3b82f6 !important;
  color: white !important;
  font-weight: 800;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
