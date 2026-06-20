<template>
  <section class="admin-data-surface">
    <el-table
      v-if="!isMobile"
      class="user-table"
      v-loading="loading"
      :data="tableRows"
      :row-key="(row: UserListViewItem) => String(row.accountId)"
      :row-class-name="rowClassName"
    >
      <el-table-column prop="accountId" label="Account" min-width="88" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <span class="tabular-nums">{{ row.accountId }}</span>
        </template>
      </el-table-column>

      <el-table-column label="匿名账号" :min-width="accountColumnWidth">
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
                {{ row.displayHandle }}
              </span>
              <SemanticTime
                v-if="!props.isMobile"
                :value="row.createTime"
                :text="`${row.createdAtText} 初始化`"
                class="mt-0.5 tabular-nums text-[11px] tabular-nums text-[var(--fsusblog-text-muted)] normal-case tracking-normal"
              />
            </p>
          </div>
        </template>
      </el-table-column>

      <el-table-column prop="identityKind" label="身份" :width="identityColumnWidth" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <span class="text-xs font-semibold italic normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
            {{ row.identityKindLabel }}
          </span>
        </template>
      </el-table-column>

      <el-table-column v-if="hasWideTable" label="凭据" min-width="220">
        <template #default="{ row }: { row: UserListViewItem }">
          <div class="flex flex-col whitespace-nowrap">
            <span class="text-[12px] text-[var(--fsusblog-text-tertiary)] font-bold">{{ row.credentialSummary }}</span>
            <span class="text-[11px] text-[var(--fsusblog-text-subtle)]">{{ row.riskFlagsText }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column prop="status" label="状态" :width="statusColumnWidth" align="center">
        <template #default="{ row }: { row: UserListViewItem }">
          <span class="inline-flex flex-col items-center justify-center">
            <span class="mb-1 h-1 w-1 rounded-[var(--fsus-radius-control-small)]" :class="row.statusDotClass" aria-hidden="true" />
            <span class="text-xs font-semibold normal-case tracking-normal" :class="row.statusClass">
              {{ row.statusText }}
            </span>
          </span>
        </template>
      </el-table-column>

      <el-table-column label="操作" :width="actionColumnWidth" align="right" :fixed="hasWideTable ? 'right' : false">
        <template #default="{ row }: { row: UserListViewItem }">
          <div
            v-if="!row.isDeleted"
            class="flex items-center justify-end gap-2 pr-2"
          >
            <el-button
              link
              :type="row.status === 0 ? 'danger' : 'success'"
              size="small"
              :loading="isProcessing && processingId === row.accountId"
              :aria-label="`变更匿名账号状态：${row.displayHandle}`"
              @click="emit('toggle-status', row)"
            >
              {{ row.status === 0 ? '封禁' : '解封' }}
            </el-button>
          </div>
          <span v-else-if="row.isDeleted" class="text-[var(--fsusblog-text-subtle)] text-xs font-semibold normal-case italic tracking-normal pr-4">已注销</span>
        </template>
      </el-table-column>

      <template #empty>
        <AdminInlineEmptyState :title="emptyTitle" :description="emptyDescription">
          <template v-if="hasActiveFilters" #actions>
            <el-button @click="emit('reset-filters')">清除筛选</el-button>
          </template>
        </AdminInlineEmptyState>
      </template>
    </el-table>

    <div
      v-else
      v-loading="loading"
      class="user-resource-list divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]"
      role="list"
      aria-label="匿名账号列表"
    >
      <article
        v-for="row in list"
        :key="row.accountId"
        class="user-resource-list-item bg-[var(--fsusblog-page-bg)] px-4 py-5"
        :class="rowMotionClass(row.accountId)"
        role="listitem"
        v-memo="[row.accountId, row.displayHandle, row.status, row.riskFlags, rowMotionClass(row.accountId)]"
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
                {{ row.displayHandle }}
              </span>
              <span class="text-xs font-semibold italic normal-case tracking-normal px-2 py-0.5 bg-[var(--fsusblog-panel-bg-soft)] text-[var(--fsusblog-text-muted)]">
                {{ row.identityKindLabel }}
              </span>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-3 text-[11px] tabular-nums text-[var(--fsusblog-text-muted)] normal-case tracking-normal">
              <SemanticTime :value="row.createTime" :text="row.createdAtText" />
              <span class="text-[var(--fsusblog-text-subtle)]">/</span>
              <span>{{ row.credentialSummary }}</span>
              <span class="text-[var(--fsusblog-text-subtle)]">/</span>
              <span>{{ row.riskFlagsText }}</span>
            </div>
          </div>
          <div class="shrink-0 flex flex-col items-center">
            <span class="h-1 w-1 rounded-[var(--fsus-radius-control-small)] mb-1" :class="row.statusDotClass" aria-hidden="true" />
            <span class="text-xs font-semibold normal-case tracking-normal" :class="row.statusClass">
              {{ row.statusText }}
            </span>
          </div>
        </div>

        <div v-if="!row.isDeleted" class="grid grid-cols-1 gap-2" aria-label="匿名账号高风险操作">
          <el-button
            :type="row.status === 0 ? 'danger' : 'success'"
            :loading="isProcessing && processingId === row.accountId"
            :aria-label="`变更匿名账号状态：${row.displayHandle}`"
            @click="emit('toggle-status', row)"
          >
            {{ row.status === 0 ? '封禁' : '解封' }}
          </el-button>
        </div>
        <div v-else class="text-center py-3 bg-[var(--fsusblog-panel-bg-soft)] text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-subtle)]">
          已注销账户
        </div>
      </article>

      <AdminInlineEmptyState
        v-if="!loading && list.length === 0"
        :title="emptyTitle"
        :description="emptyDescription"
      >
        <template v-if="hasActiveFilters" #actions>
          <el-button @click="emit('reset-filters')">清除筛选</el-button>
        </template>
      </AdminInlineEmptyState>
    </div>

    <div class="admin-data-surface__footer">
      <el-pagination
        :current-page="currentPage"
        :page-size="pageSize"
        :total="total"
        :pager-count="5"
        :page-sizes="[10, 20, 50]"
        :layout="isMobile ? 'prev, next' : 'total, sizes, prev, pager, next'"
        @current-change="emit('update:current-page', $event)"
        @size-change="emit('update:page-size', $event)"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import SemanticTime from '@/components/ui/SemanticTime.vue'
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
  rowMotionClass?: (id: number) => string
  emptyTitle?: string
  emptyDescription?: string
  hasActiveFilters?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  emptyTitle: '暂无匿名账号记录',
  emptyDescription: '匿名账号初始化后会显示在这里。',
  hasActiveFilters: false
})

const accountColumnWidth = computed(() => (props.isMobile ? 136 : 220))
const identityColumnWidth = computed(() => (props.isMobile ? 72 : 128))
const statusColumnWidth = computed(() => (props.isMobile ? 56 : 124))
const actionColumnWidth = computed(() => (props.isMobile ? 56 : 124))
const hasWideTable = useMediaQuery('(min-width: 1024px)', true)
const tableRows = computed(() => props.list)
const rowMotionClass = (id: number): string => props.rowMotionClass?.(id) ?? 'blog-motion-row-state'
const rowClassName = ({ row }: { row: UserListViewItem }): string => rowMotionClass(row.accountId)

const emit = defineEmits<{
  refresh: []
  'toggle-status': [row: UserListViewItem]
  'reset-filters': []
  'update:current-page': [value: number]
  'update:page-size': [value: number]
}>()
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
