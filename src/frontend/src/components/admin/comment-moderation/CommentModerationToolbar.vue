<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] p-6" aria-label="评论审核筛选">
    <div class="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
      <div class="grid grid-cols-1 gap-px bg-[var(--fsusblog-panel-bg-soft)] border border-[var(--fsusblog-panel-border)] sm:grid-cols-3">
        <div v-for="counter in counters" :key="counter.label" class="bg-[var(--fsusblog-page-bg)] px-5 py-4">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ counter.label }}</div>
          <div class="mt-2 text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ counter.value }}</div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <el-radio-group
          :model-value="filters.status"
          aria-label="评论审核状态筛选"
          :disabled="loading"
          @update:model-value="onStatusChange"
        >
          <el-radio-button v-for="option in statusOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </el-radio-button>
        </el-radio-group>
        <el-button :icon="Refresh" :loading="loading" @click="emit('refresh')">刷新</el-button>
      </div>
    </div>

    <div class="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-12">
      <div class="lg:col-span-3">
        <el-input
          :model-value="filters.keyword"
          name="commentModerationKeyword"
          aria-label="搜索评论内容"
          placeholder="搜索内容、原因或 ID"
          clearable
          :disabled="loading"
          @update:model-value="emit('update:keyword', String($event))"
          @clear="emit('search')"
          @keyup.enter="emit('search')"
        >
          <template #prefix>
            <span class="text-[var(--fsusblog-text-muted)]"><el-icon><Search /></el-icon></span>
          </template>
        </el-input>
      </div>

      <div class="lg:col-span-2">
        <el-input
          :model-value="filters.article"
          name="commentModerationArticle"
          aria-label="按文章筛选评论"
          placeholder="文章 ID / 标题"
          clearable
          :disabled="loading"
          @update:model-value="emit('update:article', String($event))"
          @clear="emit('search')"
          @keyup.enter="emit('search')"
        />
      </div>

      <div class="lg:col-span-2">
        <el-input
          :model-value="filters.user"
          name="commentModerationUser"
          aria-label="按用户筛选评论"
          placeholder="用户 ID / 昵称"
          clearable
          :disabled="loading"
          @update:model-value="emit('update:user', String($event))"
          @clear="emit('search')"
          @keyup.enter="emit('search')"
        />
      </div>

      <div class="lg:col-span-2">
        <el-select
          :model-value="filters.hitReason"
          name="commentModerationHitReason"
          aria-label="按命中原因筛选评论"
          placeholder="命中原因"
          clearable
          :disabled="loading || hitReasonOptions.length === 0"
          @update:model-value="onHitReasonChange"
        >
          <el-option
            v-for="option in hitReasonOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
      </div>

      <div class="lg:col-span-3">
        <el-date-picker
          :model-value="filters.dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          aria-label="按时间范围筛选评论"
          :disabled="loading"
          @update:model-value="onDateRangeChange"
        />
      </div>
    </div>

    <div class="mt-5 flex flex-wrap items-center justify-between gap-4">
      <div class="flex flex-wrap gap-2" aria-label="当前评论筛选条件">
        <el-tag
          v-for="chip in activeFilters"
          :key="chip.key"
          closable
          type="info"
          @close="emit('remove-filter', chip.key)"
        >
          {{ chip.label }}
        </el-tag>
      </div>

      <div class="flex items-center gap-3">
        <span class="text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]">匹配 {{ filteredTotal }} / {{ total }}</span>
        <el-button type="primary" :icon="Search" :loading="loading" @click="emit('search')">查询</el-button>
        <el-button :disabled="loading || activeFilters.length <= 1" @click="emit('reset')">重置</el-button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Search, Refresh } from '@/fsusui/icons'
import {
  commentModerationStatusOptions as statusOptions,
  type CommentModerationFilterKey,
  type CommentModerationFilters
} from '@/composables/useCommentModerationQueue'
import type { CommentModerationStatus } from '@/api/authoring'

defineProps<{
  filters: CommentModerationFilters
  loading: boolean
  total: number
  filteredTotal: number
  counters: ReadonlyArray<{ label: string; value: number }>
  hitReasonOptions: ReadonlyArray<{ value: string; label: string }>
  activeFilters: ReadonlyArray<{ key: CommentModerationFilterKey; label: string }>
}>()

const emit = defineEmits<{
  refresh: []
  search: []
  reset: []
  'remove-filter': [key: CommentModerationFilterKey]
  'update:status': [value: CommentModerationStatus]
  'update:keyword': [value: string]
  'update:article': [value: string]
  'update:user': [value: string]
  'update:hitReason': [value: string]
  'update:dateRange': [value: [string, string] | null]
}>()

const onStatusChange = (value: string | number | boolean): void => {
  emit('update:status', Number(value) as CommentModerationStatus)
}

const onHitReasonChange = (value: string | null): void => {
  emit('update:hitReason', value ?? '')
}

const onDateRangeChange = (value: unknown): void => {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string') {
    emit('update:dateRange', [value[0], value[1]])
    return
  }
  emit('update:dateRange', null)
}
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
