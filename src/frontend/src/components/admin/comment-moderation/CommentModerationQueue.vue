<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-label="评论审核队列">
    <div class="border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-6 py-3">
      <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核队列</div>
    </div>

    <el-responsive-collection
      v-loading="loading"
      :items="items"
      :row-key="getRowKey"
      compact-query="(max-width: 767px)"
      aria-label="评论审核列表"
    >
      <template #card="{ item }">
        <div
          class="border-b border-[var(--fsusblog-panel-border)] py-3"
          :class="rowMotionClass(item as CommentModerationViewItem)"
        >
          <div class="flex items-start gap-3 px-4">
            <el-checkbox
              :model-value="isSelected(item as CommentModerationViewItem)"
              :aria-label="`选择评论 ${(item as CommentModerationViewItem).id}`"
              :disabled="loading"
              @change="(value: unknown) => toggle(item as CommentModerationViewItem, Boolean(value))"
            />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ (item as CommentModerationViewItem).actorDisplayName }}</span>
                <span class="text-xs font-medium tabular-nums text-[var(--fsusblog-text-muted)]">#{{ (item as CommentModerationViewItem).id }}</span>
                <span class="text-xs font-semibold normal-case tracking-normal" :class="(item as CommentModerationViewItem).statusClass">
                  {{ (item as CommentModerationViewItem).statusLabel }}
                </span>
                <el-tag v-if="(item as CommentModerationViewItem).autoModerated" size="small" type="success">
                  {{ (item as CommentModerationViewItem).moderationActorLabel }}
                </el-tag>
                <el-tag size="small" :type="(item as CommentModerationViewItem).isStrongAnonymous ? 'warning' : 'info'">
                  {{ (item as CommentModerationViewItem).authorModeLabel }}
                </el-tag>
                <el-tag v-if="(item as CommentModerationViewItem).isStrongAnonymous" size="small" type="danger">
                  不显示真实账号
                </el-tag>
              </div>
              <p class="mt-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
                {{ (item as CommentModerationViewItem).content }}
              </p>
              <div class="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-[var(--fsusblog-text-muted)]">
                <span>{{ (item as CommentModerationViewItem).displayLanguageLabel }}</span>
                <span>{{ (item as CommentModerationViewItem).anonymousScopeLabel }}</span>
                <span>{{ (item as CommentModerationViewItem).credentialLevelLabel }}</span>
                <span>{{ (item as CommentModerationViewItem).reputationBucketLabel }}</span>
                <span>{{ (item as CommentModerationViewItem).accountAgeBucketLabel }}</span>
                <span>{{ (item as CommentModerationViewItem).nullifierStatusLabel }}</span>
              </div>
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
                  <el-tag v-for="risk in (item as CommentModerationViewItem).riskLabels" :key="risk" size="small" type="warning">
                    {{ risk }}
                  </el-tag>
                </div>
                <div class="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-[var(--fsusblog-text-muted)]">
                  <span>{{ (item as CommentModerationViewItem).regionSummary }}</span>
                  <span>{{ (item as CommentModerationViewItem).regionConfidenceLabel }}</span>
                  <span>屏蔽：{{ (item as CommentModerationViewItem).blockedRegionLabel }}</span>
                  <span>{{ (item as CommentModerationViewItem).regionReviewLabel }}</span>
                  <span>处置：{{ (item as CommentModerationViewItem).moderationActorLabel }}</span>
                </div>
                <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-[var(--fsusblog-text-muted)]">
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
                <el-button v-if="(item as CommentModerationViewItem).canBlockAnonymousNullifier" size="small" type="danger" plain @click="emit('block-anonymous-nullifier', item as CommentModerationViewItem)">封禁匿名标识</el-button>
                <el-button v-if="(item as CommentModerationViewItem).hasAnonymousCredential" size="small" type="danger" plain :disabled="!(item as CommentModerationViewItem).canRevokeAnonymousCredential" @click="emit('revoke-anonymous-credential', item as CommentModerationViewItem)">撤销匿名资格</el-button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <template #empty>
        <AdminInlineEmptyState :title="emptyTitle" :description="emptyDescription" />
      </template>

      <template #table>
        <div class="blog-scroll-x-safe comment-moderation-table-scroll">
          <el-table
            class="comment-moderation-table"
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
                    <span class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ row.actorDisplayName }}</span>
                    <el-tag size="small" :type="row.isStrongAnonymous ? 'warning' : 'info'">{{ row.authorModeLabel }}</el-tag>
                    <el-tag v-if="row.isStrongAnonymous" size="small" type="danger">不显示真实账号</el-tag>
                    <span class="text-xs font-medium tabular-nums text-[var(--fsusblog-text-muted)]">#{{ row.id }}</span>
                    <SemanticTime
                      :value="row.createTime"
                      :text="row.createTimeText"
                      class="text-xs font-medium tabular-nums text-[var(--fsusblog-text-muted)]"
                    />
                  </div>
                  <p class="mt-3 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
                    {{ row.content }}
                  </p>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="文章 / 主体" min-width="260">
              <template #default="{ row }: { row: CommentModerationViewItem }">
                <div class="space-y-2 text-[12px] leading-relaxed">
                  <div class="break-words font-bold text-[var(--fsusblog-text-primary)]">{{ row.articleLabel }}</div>
                  <div class="break-words text-[var(--fsusblog-text-muted)]">{{ row.userLabel }}</div>
                  <div class="flex flex-wrap gap-1.5">
                    <el-tag size="small" type="info">{{ row.displayLanguageLabel }}</el-tag>
                    <el-tag size="small" type="info">{{ row.anonymousScopeLabel }}</el-tag>
                    <el-tag size="small" type="info">{{ row.credentialLevelLabel }}</el-tag>
                    <el-tag size="small" type="info">{{ row.reputationBucketLabel }}</el-tag>
                    <el-tag size="small" type="info">{{ row.accountAgeBucketLabel }}</el-tag>
                    <el-tag size="small" type="info">{{ row.nullifierStatusLabel }}</el-tag>
                  </div>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="命中原因" min-width="180">
              <template #default="{ row }: { row: CommentModerationViewItem }">
                <div class="flex flex-wrap gap-1.5">
                  <el-tag v-for="reason in row.hitReasonLabels" :key="reason" size="small" type="info">
                    {{ reason }}
                  </el-tag>
                  <el-tag v-for="risk in row.riskLabels" :key="risk" size="small" type="warning">
                    {{ risk }}
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
                <div class="space-y-1.5 text-xs font-medium leading-relaxed text-[var(--fsusblog-text-muted)]">
                  <div>{{ row.regionSummary }}</div>
                  <div>{{ row.regionConfidenceLabel }}</div>
                  <div class="break-words">屏蔽：{{ row.blockedRegionLabel }}</div>
                  <div>{{ row.regionReviewLabel }}</div>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="模型风险信号" min-width="190">
              <template #default="{ row }: { row: CommentModerationViewItem }">
                <div class="space-y-1.5 text-xs font-medium leading-relaxed text-[var(--fsusblog-text-muted)]">
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
                  <el-tag v-if="row.autoModerated" size="small" type="success">{{ row.moderationActorLabel }}</el-tag>
                  <span v-else class="text-[11px] font-medium text-[var(--fsusblog-text-muted)]">{{ row.moderationActorLabel }}</span>
                </span>
              </template>
            </el-table-column>

            <el-table-column label="操作" width="230" fixed="right" align="right">
              <template #default="{ row }: { row: CommentModerationViewItem }">
                <div class="flex items-center justify-end gap-1 pr-2">
                  <el-button link type="primary" :icon="ViewIcon" @click="emit('detail', row)">详情</el-button>
                  <el-dropdown>
                    <el-button link type="primary" :loading="processingId === row.id">
                      审核 <span class="ml-0.5 inline-flex"><el-icon aria-hidden="true"><ArrowDown /></el-icon></span>
                    </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item :icon="Check" :disabled="!row.regionCanApprove" @click="emit('apply', row, CommentModerationStatus.Approved)">通过评论</el-dropdown-item>
                        <el-dropdown-item :icon="Hide" @click="emit('apply', row, CommentModerationStatus.Hidden)">隐藏评论</el-dropdown-item>
                        <el-dropdown-item :icon="Close" @click="emit('apply', row, CommentModerationStatus.Rejected)">拒绝评论</el-dropdown-item>
                        <el-dropdown-item v-if="row.canBlockAnonymousNullifier" divided @click="emit('block-anonymous-nullifier', row)">封禁匿名标识</el-dropdown-item>
                        <el-dropdown-item v-if="row.hasAnonymousCredential" :disabled="!row.canRevokeAnonymousCredential" @click="emit('revoke-anonymous-credential', row)">撤销匿名资格</el-dropdown-item>
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
        </div>
      </template>
    </el-responsive-collection>
  </section>
</template>

<script setup lang="ts">
import { ArrowDown, Check, Close, Hide, View as ViewIcon } from '@/fsusui/icons'
import { CommentModerationStatus, type CommentModerationStatus as CommentModerationStatusValue } from '@/api/authoring'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
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
  'block-anonymous-nullifier': [item: CommentModerationViewItem]
  'revoke-anonymous-credential': [item: CommentModerationViewItem]
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

.comment-moderation-table-scroll {
  max-width: 100%;
  overflow-x: auto;
}

.comment-moderation-table :deep(.el-table-fixed-column--right.is-first-column) {
  border-left: 1px solid var(--fsusblog-panel-border);
}

.comment-moderation-table :deep(.el-table-fixed-column--right.is-first-column::before) {
  box-shadow: none;
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
  font-size: 0.75rem;
  font-weight: 600;
  outline: none;
}

.moderation-detail-fold summary:focus-visible {
  border-radius: var(--fsus-radius-control-small);
  box-shadow: 0 0 0 2px var(--fsusblog-color-focus-ring);
}
</style>
