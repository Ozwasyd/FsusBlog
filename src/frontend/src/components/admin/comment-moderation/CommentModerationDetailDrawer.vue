<template>
  <el-drawer
    :model-value="visible"
    direction="rtl"
    size="min(92vw, 34rem)"
    @update:model-value="emit('update:visible', $event)"
  >
    <template #header>
      <div v-if="item" class="min-w-0">
        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">评论详情</div>
        <div class="mt-2 truncate text-xl font-bold text-[var(--fsusblog-text-primary)]">#{{ item.id }}</div>
      </div>
    </template>

    <div v-if="item" class="space-y-8">
      <section>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium normal-case tracking-normal" :class="item.statusClass">{{ item.statusLabel }}</span>
          <SemanticTime :value="item.createTime" :text="item.createTimeText" class="text-xs font-medium tabular-nums text-[var(--fsusblog-text-muted)]" />
        </div>
        <p class="mt-5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
          {{ item.content }}
        </p>
        <div class="mt-5 recommendation-strip">
          <span>{{ item.recommendedActionLabel }}</span>
          <span>原因：{{ item.recommendedActionReason }}</span>
        </div>
      </section>

      <section class="grid grid-cols-1 gap-3 border-y border-[var(--fsusblog-panel-border)]">
        <div class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">文章</div>
          <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.articleLabel }}</div>
        </div>
        <div class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">用户</div>
          <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.userLabel }}</div>
        </div>
      </section>

      <section class="border-y border-[var(--fsusblog-panel-border)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">匿名治理摘要</div>
        </div>
        <div class="grid grid-cols-1 gap-3">
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">身份与治理状态</div>
            <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.authorModeLabel }} / {{ item.nullifierStatusLabel }}</div>
            <div class="mt-2 break-words text-[12px] text-[var(--fsusblog-text-muted)]">
              {{ item.rateClassLabel }} / {{ item.moderationRequirementLabel }}
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">命中原因</div>
        <div class="mt-3 flex flex-wrap gap-2">
          <el-tag v-for="reason in item.hitReasonLabels" :key="reason" type="info">
            {{ reason }}
          </el-tag>
          <el-tag v-if="item.hitReasonLabels.length === 0" type="info">未命中</el-tag>
        </div>
      </section>

      <section class="border-y border-[var(--fsusblog-panel-border)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">地区策略</div>
        </div>
        <div class="grid grid-cols-1 gap-3">
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">提交地区</div>
            <div class="mt-2 text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.regionSummary }}</div>
            <div class="mt-2 text-[12px] font-bold text-[var(--fsusblog-text-muted)]">{{ item.regionConfidenceLabel }}</div>
          </div>
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">屏蔽地区</div>
            <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.blockedRegionLabel }}</div>
          </div>
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略版本</div>
            <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.regionPolicyLabel }}</div>
          </div>
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">复核状态</div>
            <div class="mt-2 text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.regionReviewLabel }}</div>
            <div class="mt-2 text-[12px] font-bold text-[var(--fsusblog-text-muted)]">可通过：{{ item.regionCanApprove ? '是' : '否' }}</div>
            <div class="mt-2 break-words text-[12px] text-[var(--fsusblog-text-muted)]">原因：{{ item.regionDecisionReason || '--' }}</div>
          </div>
        </div>
      </section>

      <section class="border-y border-[var(--fsusblog-panel-border)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">模型风险信号</div>
          <p class="mt-2 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">
            模型输出仅作为风险信号；地区策略结果与人工审核状态独立决定最终动作。
          </p>
        </div>
        <div class="grid grid-cols-1 gap-3">
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险标签</div>
            <div class="mt-2 text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.modelSignalLabel }}</div>
            <div class="mt-2 text-[12px] font-bold text-[var(--fsusblog-text-muted)]">{{ item.modelConfidenceLabel }}</div>
          </div>
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">模型运行时</div>
            <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.modelProviderLabel }}</div>
            <div class="mt-2 text-[12px] font-bold text-[var(--fsusblog-text-muted)]">{{ item.modelSeverityLabel }}</div>
          </div>
          <div class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">原因</div>
            <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.modelReasonLabel }}</div>
            <div class="mt-2 break-words text-[12px] text-[var(--fsusblog-text-muted)]">
              {{ item.modelCategoriesLabel }}
            </div>
            <div class="mt-2 break-words text-[12px] text-[var(--fsusblog-text-muted)]">
              {{ item.modelProfileLabel }} / {{ item.modelStatusLabel }} / {{ item.modelLatencyLabel }}
            </div>
          </div>
        </div>
      </section>

      <section class="border-y border-[var(--fsusblog-panel-border)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核历史</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="event in item.auditEvents" :key="event" class="p-5 text-[12px] font-bold text-[var(--fsusblog-text-secondary)]">
            {{ event }}
          </div>
        </div>
      </section>

      <section class="border-y border-[var(--fsusblog-panel-border)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审计事件</div>
        </div>
        <div class="p-5 text-[12px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
          <div class="font-bold">状态：{{ item.statusLabel }}</div>
          <div class="mt-2 break-words">原因：{{ item.reason || '--' }}</div>
          <div class="mt-2 tabular-nums">审核人：{{ item.moderatedByAdminPrincipalId ?? '--' }}</div>
        </div>
      </section>

      <section>
        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核操作</div>
        <div class="mt-4 flex flex-wrap gap-3">
          <el-button :icon="Check" type="success" :disabled="!item.regionCanApprove" :loading="processing" @click="emit('apply', item, CommentModerationStatus.Approved)">通过评论</el-button>
          <el-button :icon="Hide" :loading="processing" @click="emit('apply', item, CommentModerationStatus.Hidden)">隐藏评论</el-button>
          <el-button :icon="Close" type="danger" :loading="processing" @click="emit('apply', item, CommentModerationStatus.Rejected)">拒绝评论</el-button>
        </div>
      </section>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { Check, Close, Hide } from '@/fsusui/icons'
import { CommentModerationStatus, type CommentModerationStatus as CommentModerationStatusValue } from '@/api/authoring'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import type { CommentModerationViewItem } from '@/composables/useCommentModerationQueue'

defineProps<{
  visible: boolean
  item: CommentModerationViewItem | null
  processing: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  apply: [item: CommentModerationViewItem, status: CommentModerationStatusValue]
}>()
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
</style>
