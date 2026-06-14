<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-label="评论审核队列">
    <div class="border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-6 py-3">
      <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核队列</div>
    </div>

    <el-responsive-collection
      v-loading="loading"
      :items="items"
      :row-key="getRowKey"
      compact-query="(max-width: 767px)"
      aria-label="评论审核列表"
    >
      <template #card="{ item }">
        <article
          class="bg-[var(--fsusblog-page-bg)] p-6"
          :class="rowMotionClass(item as CommentModerationViewItem)"
        >
          <div class="flex items-start gap-4">
            <el-checkbox
              :model-value="isSelected(item as CommentModerationViewItem)"
              :aria-label="`选择评论 ${(item as CommentModerationViewItem).id}`"
              :disabled="loading"
              @change="(value: unknown) => toggle(item as CommentModerationViewItem, Boolean(value))"
            />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ (item as CommentModerationViewItem).userName }}</span>
                <span class="text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]">#{{ (item as CommentModerationViewItem).id }}</span>
                <span class="text-xs font-semibold normal-case tracking-normal" :class="(item as CommentModerationViewItem).statusClass">
                  {{ (item as CommentModerationViewItem).statusLabel }}
                </span>
              </div>
              <p class="mt-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
                {{ (item as CommentModerationViewItem).content }}
              </p>
              <div class="mt-4 recommendation-strip">
                <span>{{ (item as CommentModerationViewItem).recommendedActionLabel }}</span>
                <span>原因：{{ (item as CommentModerationViewItem).recommendedActionReason }}</span>
              </div>
              <details class="mt-4 moderation-detail-fold">
                <summary>详情</summary>
                <div class="mt-3 flex flex-wrap gap-2">
                  <el-tag v-for="reason in (item as CommentModerationViewItem).hitReasonLabels" :key="reason" size="small" type="info">
                    {{ reason }}
                  </el-tag>
                </div>
                <div class="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-bold text-[var(--fsusblog-text-muted)]">
                  <span>{{ (item as CommentModerationViewItem).regionSummary }}</span>
                  <span>{{ (item as CommentModerationViewItem).regionConfidenceLabel }}</span>
                  <span>屏蔽：{{ (item as CommentModerationViewItem).blockedRegionLabel }}</span>
                  <span>{{ (item as CommentModerationViewItem).regionReviewLabel }}</span>
                </div>
                <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-bold text-[var(--fsusblog-text-muted)]">
                  <span>{{ (item as CommentModerationViewItem).modelSignalLabel }}</span>
                  <span>{{ (item as CommentModerationViewItem).modelConfidenceLabel }}</span>
                  <span>{{ (item as CommentModerationViewItem).modelProviderLabel }}</span>
                </div>
              </details>
              <div class="mt-4 flex flex-wrap items-center gap-2">
                <el-button :icon="ViewIcon" size="small" @click="emit('detail', item as CommentModerationViewItem)">详情</el-button>
                <el-button :icon="Check" size="small" type="success" :disabled="!(item as CommentModerationViewItem).regionCanApprove" :loading="processingId === (item as CommentModerationViewItem).id" @click="emit('apply', item as CommentModerationViewItem, CommentModerationStatus.Approved)">通过评论</el-button>
                <el-button :icon="Hide" size="small" :loading="processingId === (item as CommentModerationViewItem).id" @click="emit('apply', item as CommentModerationViewItem, CommentModerationStatus.Hidden)">隐藏评论</el-button>
                <el-button :icon="Close" size="small" type="danger" :loading="processingId === (item as CommentModerationViewItem).id" @click="emit('apply', item as CommentModerationViewItem, CommentModerationStatus.Rejected)">拒绝评论</el-button>
              </div>
            </div>
          </div>
        </article>
      </template>

      <template #empty>
        <AdminInlineEmptyState :title="emptyTitle" :description="emptyDescription" />
      </template>

      <template #table>
        <el-table
          :data="items"
          :row-key="getRowKey"
          :row-class-name="rowClassName"
        >
          <el-table-column width="56" align="center">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <el-checkbox
                :model-value="isSelected(row)"
                :aria-label="`选择评论 ${row.id}`"
                :disabled="loading"
                @change="(value: unknown) => toggle(row, Boolean(value))"
              />
            </template>
          </el-table-column>

          <el-table-column label="评论" min-width="360">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <div class="min-w-0 py-2">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ row.userName }}</span>
                  <span class="text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]">#{{ row.id }}</span>
                  <SemanticTime
                    :value="row.createTime"
                    :text="row.createTimeText"
                    class="text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]"
                  />
                </div>
                <p class="mt-3 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
                  {{ row.content }}
                </p>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="文章 / 用户" min-width="220">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <div class="space-y-2 text-[12px] leading-relaxed">
                <div class="break-words font-bold text-[var(--fsusblog-text-primary)]">{{ row.articleLabel }}</div>
                <div class="break-words text-[var(--fsusblog-text-muted)]">{{ row.userLabel }}</div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="命中原因" min-width="180">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <div class="flex flex-wrap gap-1.5">
                <el-tag v-for="reason in row.hitReasonLabels" :key="reason" size="small" type="info">
                  {{ reason }}
                </el-tag>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="推荐动作" min-width="220">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <div class="recommendation-strip">
                <span>{{ row.recommendedActionLabel }}</span>
                <span>原因：{{ row.recommendedActionReason }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="地区策略" min-width="210">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <div class="space-y-1.5 text-[11px] font-bold leading-relaxed text-[var(--fsusblog-text-muted)]">
                <div>{{ row.regionSummary }}</div>
                <div>{{ row.regionConfidenceLabel }}</div>
                <div class="break-words">屏蔽：{{ row.blockedRegionLabel }}</div>
                <div>{{ row.regionReviewLabel }}</div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="模型风险信号" min-width="190">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <div class="space-y-1.5 text-[11px] font-bold leading-relaxed text-[var(--fsusblog-text-muted)]">
                <div>{{ row.modelSignalLabel }}</div>
                <div>{{ row.modelConfidenceLabel }}</div>
                <div class="break-words">{{ row.modelProviderLabel }}</div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="状态" width="112" align="center">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <span class="inline-flex flex-col items-center gap-1">
                <span class="text-xs font-semibold normal-case tracking-normal" :class="row.statusClass">{{ row.statusLabel }}</span>
              </span>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="230" fixed="right" align="right">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <div class="flex items-center justify-end gap-1 pr-2">
                <el-button link type="primary" :icon="ViewIcon" @click="emit('detail', row)">详情</el-button>
                <el-dropdown>
                  <el-button link type="primary" :loading="processingId === row.id">
                    审核 <span class="ml-0.5 inline-flex"><el-icon><ArrowDown /></el-icon></span>
                  </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item :icon="Check" :disabled="!row.regionCanApprove" @click="emit('apply', row, CommentModerationStatus.Approved)">通过评论</el-dropdown-item>
                      <el-dropdown-item :icon="Hide" @click="emit('apply', row, CommentModerationStatus.Hidden)">隐藏评论</el-dropdown-item>
                      <el-dropdown-item :icon="Close" @click="emit('apply', row, CommentModerationStatus.Rejected)">拒绝评论</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </template>
          </el-table-column>

          <template #empty>
            <AdminInlineEmptyState :title="emptyTitle" :description="emptyDescription" />
          </template>
        </el-table>
      </template>
    </el-responsive-collection>
  </section>
</template>

<script setup lang="ts">
import { ArrowDown, Check, Close, Hide, View as ViewIcon } from '@/fsusui/icons'
import { CommentModerationStatus, type CommentModerationStatus as CommentModerationStatusValue } from '@/api/authoring'
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import type { CommentModerationViewItem } from '@/composables/useCommentModerationQueue'

const props = withDefaults(defineProps<{
  items: readonly CommentModerationViewItem[]
  selectedIds: readonly string[]
  loading: boolean
  processingId: string | null
  highlightedIds?: readonly string[]
  emptyTitle?: string
  emptyDescription?: string
}>(), {
  highlightedIds: () => [],
  emptyTitle: '当前队列暂无评论',
  emptyDescription: '新的待审核、隐藏或拒绝评论会在对应状态下出现。'
})

const emit = defineEmits<{
  toggle: [id: string, checked: boolean]
  detail: [item: CommentModerationViewItem]
  apply: [item: CommentModerationViewItem, status: CommentModerationStatusValue]
}>()

const getRowKey = (row: CommentModerationViewItem): string => row.id

const isSelected = (item: CommentModerationViewItem): boolean => props.selectedIds.includes(item.id)
const isHighlighted = (item: CommentModerationViewItem): boolean => (props.highlightedIds ?? []).includes(item.id)

const rowMotionClass = (item: CommentModerationViewItem): string => [
  'blog-motion-row-state',
  props.processingId === item.id ? 'blog-motion-row-pending' : '',
  isHighlighted(item) ? 'blog-motion-row-updated' : ''
].filter(Boolean).join(' ')

const rowClassName = ({ row }: { row: CommentModerationViewItem }): string =>
  rowMotionClass(row)

const toggle = (item: CommentModerationViewItem, checked: boolean): void => {
  emit('toggle', item.id, checked)
}
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}

.recommendation-strip {
  display: grid;
  gap: 0.25rem;
  border-left: 2px solid var(--fsusblog-color-primary);
  background: var(--fsusblog-page-bg-soft);
  padding: 0.75rem 1rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1.45;
}

.moderation-detail-fold summary {
  cursor: pointer;
  color: var(--fsusblog-text-muted);
  font-size: 0.6875rem;
  font-weight: 800;
  outline: none;
}

.moderation-detail-fold summary:focus-visible {
  border-radius: var(--fsus-radius-control-small);
  box-shadow: 0 0 0 2px var(--fsusblog-color-focus-ring);
}
</style>
