<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-label="评论审核队列">
    <div class="border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-6 py-3">
      <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核队列 / COMMENT QUEUE</div>
    </div>

    <el-responsive-collection
      v-loading="loading"
      :items="items"
      :row-key="getRowKey"
      compact-query="(max-width: 767px)"
      aria-label="评论审核列表"
    >
      <template #card="{ item }">
        <article class="bg-[var(--fsusblog-page-bg)] p-6">
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
                <span class="text-[11px] font-black normal-case tracking-normal" :class="(item as CommentModerationViewItem).statusClass">
                  {{ (item as CommentModerationViewItem).statusLabel }}
                </span>
              </div>
              <p class="mt-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
                {{ (item as CommentModerationViewItem).content }}
              </p>
              <div class="mt-4 flex flex-wrap gap-2">
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
              <div class="mt-4 flex flex-wrap items-center gap-2">
                <el-button :icon="ViewIcon" size="small" @click="emit('detail', item as CommentModerationViewItem)">详情</el-button>
                <el-button :icon="Check" size="small" type="success" :disabled="!(item as CommentModerationViewItem).regionCanApprove" :loading="processingId === (item as CommentModerationViewItem).id" @click="emit('apply', item as CommentModerationViewItem, CommentModerationStatus.Approved)">通过</el-button>
                <el-button :icon="Close" size="small" type="danger" :loading="processingId === (item as CommentModerationViewItem).id" @click="emit('apply', item as CommentModerationViewItem, CommentModerationStatus.Rejected)">拒绝</el-button>
                <el-button :icon="Hide" size="small" :loading="processingId === (item as CommentModerationViewItem).id" @click="emit('apply', item as CommentModerationViewItem, CommentModerationStatus.Hidden)">隐藏</el-button>
              </div>
            </div>
          </div>
        </article>
      </template>

      <template #empty>
        <el-empty description="暂无匹配的评论审核项" />
      </template>

      <template #table>
        <el-table
          :data="items"
          :row-key="getRowKey"
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

          <el-table-column label="状态" width="112" align="center">
            <template #default="{ row }: { row: CommentModerationViewItem }">
              <span class="inline-flex flex-col items-center gap-1">
                <span class="text-[11px] font-black normal-case tracking-normal" :class="row.statusClass">{{ row.statusLabel }}</span>
                <span class="text-[10px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]">{{ row.statusCode }}</span>
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
                      <el-dropdown-item :icon="Check" :disabled="!row.regionCanApprove" @click="emit('apply', row, CommentModerationStatus.Approved)">通过</el-dropdown-item>
                      <el-dropdown-item :icon="Close" @click="emit('apply', row, CommentModerationStatus.Rejected)">拒绝</el-dropdown-item>
                      <el-dropdown-item :icon="Hide" @click="emit('apply', row, CommentModerationStatus.Hidden)">隐藏</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </template>
          </el-table-column>

          <template #empty>
            <el-empty description="暂无匹配的评论审核项" />
          </template>
        </el-table>
      </template>
    </el-responsive-collection>
  </section>
</template>

<script setup lang="ts">
import { ArrowDown, Check, Close, Hide, View as ViewIcon } from '@/fsusui/icons'
import { CommentModerationStatus, type CommentModerationStatus as CommentModerationStatusValue } from '@/api/authoring'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import type { CommentModerationViewItem } from '@/composables/useCommentModerationQueue'

const props = defineProps<{
  items: readonly CommentModerationViewItem[]
  selectedIds: readonly string[]
  loading: boolean
  processingId: string | null
}>()

const emit = defineEmits<{
  toggle: [id: string, checked: boolean]
  detail: [item: CommentModerationViewItem]
  apply: [item: CommentModerationViewItem, status: CommentModerationStatusValue]
}>()

const getRowKey = (row: CommentModerationViewItem): string => row.id

const isSelected = (item: CommentModerationViewItem): boolean => props.selectedIds.includes(item.id)

const toggle = (item: CommentModerationViewItem, checked: boolean): void => {
  emit('toggle', item.id, checked)
}
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
