<template>
  <section class="bg-[var(--fsusblog-page-bg)] border-y border-[var(--fsusblog-panel-border)]">
    <el-table
      v-if="!isMobile"
      class="user-table"
      v-loading="loading"
      :data="tableRows"
      :row-key="(row: UserListViewItem) => String(row.id)"
    >
      <el-table-column prop="id" label="ID" min-width="80" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <span class="tabular-nums">{{ row.id }}</span>
        </template>
      </el-table-column>

      <el-table-column label="用户" :min-width="userColumnWidth">
        <template #default="{ row }: { row: UserListViewItem }">
          <div
            class="flex items-center overflow-hidden"
            :class="props.isMobile ? 'gap-2' : 'gap-5 whitespace-nowrap'"
          >
            <div class="shrink-0">
              <el-avatar :size="props.isMobile ? 26 : 32">
                {{ row.initials }}
              </el-avatar>
            </div>
            <p class="min-w-0 flex flex-col justify-center overflow-hidden">
              <span class="truncate text-sm font-bold leading-tight text-[var(--fsusblog-text-primary)]">
                {{ row.username }}
              </span>
              <SemanticTime
                v-if="!props.isMobile"
                :value="row.createTime"
                :text="`${row.createdAtText} 注册`"
                class="mt-0.5 tabular-nums text-[11px] tabular-nums text-[var(--fsusblog-text-muted)] normal-case tracking-normal"
              />
            </p>
          </div>
        </template>
      </el-table-column>

      <el-table-column prop="role" label="角色" :width="roleColumnWidth" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <span class="text-[11px] font-black italic normal-case tracking-normal" :class="row.roleClass">
            {{ row.roleLabel }}
          </span>
        </template>
      </el-table-column>

      <el-table-column v-if="hasWideTable" label="最后活动" width="160">
        <template #default="{ row }: { row: UserListViewItem }">
          <div v-if="row.lastLoginTime" class="flex flex-col whitespace-nowrap tabular-nums">
            <span class="text-[12px] text-[var(--fsusblog-text-tertiary)] tabular-nums font-bold">{{ row.lastLoginText }}</span>
            <span class="text-[11px] text-[var(--fsusblog-text-subtle)] tabular-nums flex items-center gap-1">
              <span class="text-[11px]" aria-hidden="true"><el-icon><Location /></el-icon></span> {{ row.lastLoginIp }}
            </span>
            <SemanticTime :value="row.lastLoginTime" class="sr-only" />
          </div>
          <span v-else class="text-[var(--fsusblog-text-subtle)] text-[11px] italic">--</span>
        </template>
      </el-table-column>

      <el-table-column prop="status" label="状态" :width="statusColumnWidth" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <span class="inline-flex flex-col items-center justify-center">
            <span class="mb-1 h-1 w-1 rounded-[var(--fsus-radius-control-small)]" :class="row.statusDotClass" aria-hidden="true" />
            <span class="text-[11px] font-black normal-case tracking-normal" :class="row.statusClass">
              {{ row.statusText }}
            </span>
          </span>
        </template>
      </el-table-column>

      <el-table-column label="操作" :width="actionColumnWidth" align="right" fixed="right">
        <template #default="{ row }: { row: UserListViewItem }">
          <div
            v-if="!row.isAdmin && !row.isDeleted"
            class="flex items-center justify-end gap-2 pr-2"
          >
            <el-button
              link
              type="primary"
              :icon="Key"
              :disabled="isProcessing"
              size="small"
              :aria-label="`重置 ${row.username} 的密码`"
              @click="emit('open-reset', row)"
            />
            <el-divider direction="vertical" />
            <el-button
              link
              :type="row.status === 0 ? 'danger' : 'success'"
              size="small"
              :loading="isProcessing && processingId === row.id"
              @click="emit('toggle-status', row)"
            >
              {{ row.status === 0 ? '封禁' : '解封' }}
            </el-button>
          </div>
          <span v-else-if="row.isDeleted" class="text-[var(--fsusblog-text-subtle)] text-[11px] font-black normal-case italic tracking-normal pr-4">已注销</span>
          <span v-else class="text-[var(--fsusblog-text-subtle)] text-[11px] font-black normal-case italic tracking-normal pr-4">受保护</span>
        </template>
      </el-table-column>

      <template #empty>
        <el-empty description="暂无用户记录" />
      </template>
    </el-table>

    <div v-else v-loading="loading" class="divide-y divide-[var(--fsusblog-panel-border)]" aria-label="用户列表">
      <article
        v-for="row in list"
        :key="row.id"
        class="user-mobile-card p-6 bg-[var(--fsusblog-page-bg)] transition-colors hover:bg-[var(--fsusblog-panel-bg)]"
      >
        <div class="flex items-center gap-4 mb-6">
          <div class="shrink-0">
            <el-avatar :size="36">
              {{ row.initials }}
            </el-avatar>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-3">
              <span class="truncate text-sm font-bold text-[var(--fsusblog-text-primary)]">
                {{ row.username }}
              </span>
              <span class="text-[11px] font-black italic normal-case tracking-normal px-2 py-0.5 bg-[var(--fsusblog-panel-bg-soft)]" :class="row.roleClass">
                {{ row.roleLabel }}
              </span>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-3 text-[11px] tabular-nums text-[var(--fsusblog-text-muted)] normal-case tracking-normal">
              <SemanticTime :value="row.createTime" :text="row.createdAtText" />
              <span v-if="row.lastLoginTime" class="text-[var(--fsusblog-text-subtle)]">/</span>
              <SemanticTime v-if="row.lastLoginTime" :value="row.lastLoginTime" :text="row.lastLoginText" />
            </div>
          </div>
          <div class="shrink-0 flex flex-col items-center">
             <span class="h-1 w-1 rounded-[var(--fsus-radius-control-small)] mb-1" :class="row.statusDotClass" aria-hidden="true" />
             <span class="text-[11px] font-black normal-case tracking-normal" :class="row.statusClass">
              {{ row.statusText }}
            </span>
          </div>
        </div>

        <div v-if="!row.isAdmin && !row.isDeleted" class="grid grid-cols-2 gap-2">
          <el-button
            :disabled="isProcessing"
            @click="emit('open-reset', row)"
          >
            重置密码
          </el-button>
          <el-button
            :type="row.status === 0 ? 'danger' : 'success'"
            :loading="isProcessing && processingId === row.id"
            @click="emit('toggle-status', row)"
          >
            {{ row.status === 0 ? '封禁' : '解封' }}
          </el-button>
        </div>
        <div v-else class="text-center py-3 bg-[var(--fsusblog-panel-bg-soft)] text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-subtle)]">
          {{ row.isDeleted ? '已注销账户' : '受保护账户' }}
        </div>
      </article>

      <el-empty v-if="!loading && list.length === 0" description="暂无用户记录" />
    </div>

    <div class="p-8 border-t border-[var(--fsusblog-panel-border)] flex flex-col sm:flex-row items-center justify-between gap-6 bg-[var(--fsusblog-panel-bg)]">
      <span class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">用户目录 / Database</span>
      <el-pagination
        :current-page="currentPage"
        :page-size="pageSize"
        :total="total"
        :pager-count="5"
        :page-sizes="[10, 20, 50, 100]"
        :layout="isMobile ? 'prev, next' : 'total, sizes, prev, pager, next'"
        @current-change="emit('update:current-page', $event)"
        @size-change="emit('update:page-size', $event)"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Key, Location } from '@/ui/fsusIcons'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import type { UserListItem } from '@/api/admin'
import type { UserListViewItem } from '@/composables/useAdminUserManage'
import { useMediaQuery } from '@/composables/useMediaQuery'

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
const roleColumnWidth = computed(() => (props.isMobile ? 44 : 116))
const statusColumnWidth = computed(() => (props.isMobile ? 56 : 124))
const actionColumnWidth = computed(() => (props.isMobile ? 56 : 132))
const hasWideTable = useMediaQuery('(min-width: 1024px)', true)
const tableRows = computed(() => [...props.list])

const emit = defineEmits<{
  refresh: []
  'open-reset': [row: UserListItem]
  'toggle-status': [row: UserListItem]
  'update:current-page': [value: number]
  'update:page-size': [value: number]
}>()
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
