<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] p-6" aria-label="评论审核筛选">
    <div class="flex flex-wrap items-center gap-3">
      <div
        class="comment-moderation-status-tabs"
        role="radiogroup"
        aria-label="评论审核状态筛选"
      >
        <button
          v-for="option in statusOptions"
          :key="option.value"
          type="button"
          class="comment-moderation-status-tabs__item"
          :class="{ 'is-active': filters.status === option.value }"
          role="radio"
          :aria-checked="filters.status === option.value"
          :disabled="loading"
          @mousedown="onStatusChange(option.value)"
          @pointerdown="onStatusChange(option.value)"
          @click="onStatusChange(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="emit('refresh')">刷新</el-button>
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
            <span class="text-[var(--fsusblog-text-muted)]"><el-icon aria-hidden="true"><Search /></el-icon></span>
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

      <div class="lg:col-span-2">
        <el-select
          :model-value="filters.blockedRegion"
          name="commentModerationBlockedRegion"
          aria-label="按屏蔽地区筛选评论"
          placeholder="屏蔽地区"
          clearable
          :disabled="loading || blockedRegionOptions.length === 0"
          @update:model-value="onBlockedRegionChange"
        >
          <el-option
            v-for="option in blockedRegionOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
      </div>

      <div class="lg:col-span-2">
        <el-select
          :model-value="filters.modelLabel"
          name="commentModerationModelLabel"
          aria-label="按模型标签筛选评论"
          placeholder="模型标签"
          clearable
          :disabled="loading || modelLabelOptions.length === 0"
          @update:model-value="onModelLabelChange"
        >
          <el-option
            v-for="option in modelLabelOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
      </div>

      <div class="lg:col-span-2">
        <el-select
          :model-value="filters.modelProvider"
          name="commentModerationModelRuntime"
          aria-label="按模型运行时筛选评论"
          placeholder="模型运行时"
          clearable
          :disabled="loading || modelRuntimeOptions.length === 0"
          @update:model-value="onModelRuntimeChange"
        >
          <el-option
            v-for="option in modelRuntimeOptions"
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
        <span class="text-xs font-medium tabular-nums text-[var(--fsusblog-text-muted)]">匹配 {{ filteredTotal }} / {{ total }}</span>
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

const props = defineProps<{
  filters: CommentModerationFilters
  loading: boolean
  total: number
  filteredTotal: number
  hitReasonOptions: ReadonlyArray<{ value: string; label: string }>
  blockedRegionOptions: ReadonlyArray<{ value: string; label: string }>
  modelLabelOptions: ReadonlyArray<{ value: string; label: string }>
  modelRuntimeOptions: ReadonlyArray<{ value: string; label: string }>
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
  'update:blockedRegion': [value: string]
  'update:modelLabel': [value: string]
  'update:modelRuntime': [value: string]
  'update:dateRange': [value: [string, string] | null]
}>()

const onStatusChange = (value: string | number | boolean): void => {
  const nextStatus = Number(value) as CommentModerationStatus
  if (nextStatus === props.filters.status) {
    return
  }
  emit('update:status', nextStatus)
}

const onHitReasonChange = (value: string | null): void => {
  emit('update:hitReason', value ?? '')
}

const onBlockedRegionChange = (value: string | null): void => {
  emit('update:blockedRegion', value ?? '')
}

const onModelLabelChange = (value: string | null): void => {
  emit('update:modelLabel', value ?? '')
}

const onModelRuntimeChange = (value: string | null): void => {
  emit('update:modelRuntime', value ?? '')
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

.comment-moderation-status-tabs {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control);
  background: var(--fsusblog-surface-bg);
}

.comment-moderation-status-tabs__item {
  min-height: 40px;
  border: 0;
  border-right: 1px solid var(--fsusblog-panel-border);
  background: transparent;
  color: var(--fsusblog-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  padding: 0 var(--fsus-space-4);
  transition:
    background-color var(--fsus-motion-control, 160ms ease),
    color var(--fsus-motion-control, 160ms ease),
    box-shadow var(--fsus-motion-control, 160ms ease);
}

.comment-moderation-status-tabs__item:last-child {
  border-right: 0;
}

.comment-moderation-status-tabs__item:hover:not(:disabled) {
  color: var(--fsusblog-text-primary);
}

.comment-moderation-status-tabs__item.is-active {
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
  box-shadow: inset 0 -2px 0 var(--fsusblog-color-primary);
}

.comment-moderation-status-tabs__item:focus-visible {
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
  outline: none;
}

.comment-moderation-status-tabs__item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
