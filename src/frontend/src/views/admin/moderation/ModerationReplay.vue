<template>
  <div class="space-y-8">
    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略回放</div>
        <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">预览差异</h2>
        <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">回放执行前必须先生成预览；执行需要 MFA step-up、确认短语和高价值审计。</p>
      </div>

      <div class="grid gap-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-4 md:grid-cols-5">
        <el-input v-model="form.region" clearable placeholder="地区" aria-label="地区" />
        <el-input v-model="form.policyVersion" clearable placeholder="上一版策略号" aria-label="策略版本" />
        <el-input v-model="form.dictionaryId" clearable placeholder="词库 ID" aria-label="词库 ID" />
        <el-input-number v-model="form.limit" :min="1" :max="200" controls-position="right" aria-label="扫描数量" />
        <el-button type="primary" :icon="DocumentChecked" :loading="loading" @click="runPreview">生成预览</el-button>
      </div>

      <div v-if="preview" class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-4">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 text-3xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>

      <el-table v-if="preview" v-loading="loading" :data="preview.items" row-key="commentId">
        <el-table-column label="评论" width="110" prop="commentId" />
        <el-table-column label="策略版本" min-width="240">
          <template #default="{ row }: { row: ModerationReplayPreviewItemResponse }">
            <div class="text-xs text-[var(--fsusblog-text-secondary)]">
              <div>{{ row.previousPolicyVersion }}</div>
              <div class="mt-1 text-[var(--fsusblog-text-muted)]">-> {{ row.nextPolicyVersion }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="拦截地区" min-width="220">
          <template #default="{ row }: { row: ModerationReplayPreviewItemResponse }">
            <div class="flex flex-wrap gap-1">
              <el-tag v-for="region in row.addedBlockedRegions" :key="`add-${region}`" size="small" type="danger">+ {{ region }}</el-tag>
              <el-tag v-for="region in row.removedBlockedRegions" :key="`remove-${region}`" size="small" type="info">- {{ region }}</el-tag>
              <span v-if="row.addedBlockedRegions.length + row.removedBlockedRegions.length === 0">-</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="风险标签" min-width="220">
          <template #default="{ row }: { row: ModerationReplayPreviewItemResponse }">
            <div class="flex flex-wrap gap-1">
              <el-tag v-for="label in row.addedRiskLabels" :key="`add-${label}`" size="small" type="warning">+ {{ label }}</el-tag>
              <el-tag v-for="label in row.removedRiskLabels" :key="`remove-${label}`" size="small" type="info">- {{ label }}</el-tag>
              <span v-if="row.addedRiskLabels.length + row.removedRiskLabels.length === 0">-</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="可见性" width="140">
          <template #default="{ row }: { row: ModerationReplayPreviewItemResponse }">
            <el-tag :type="row.publicVisibilityChanged ? 'warning' : 'info'">{{ row.publicVisibilityChanged ? '已变化' : '未变化' }}</el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <AdminInlineEmptyState
            title="预览暂无差异"
            description="当前参数没有命中需要比较的评论，调整地区、策略版本或扫描数量后可重新生成预览。"
          />
        </template>
      </el-table>
      <AdminInlineEmptyState
        v-else
        title="尚未生成回放预览"
        description="填写地区、上一版策略号或词库 ID 后，先生成预览再进入后续执行流程。"
      />
    </section>

    <section class="border-l-4 border-[var(--el-color-warning)] bg-[var(--fsusblog-page-bg)] px-5 py-4 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
      回放执行当前不提供直接按钮。执行流程必须基于上方预览，完成 MFA step-up、确认短语、高价值审计、可中断进度与失败重试后才能进入执行。
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, shallowRef } from 'vue'
import {
  previewModerationReplay,
  type ModerationReplayPreviewItemResponse,
  type ModerationReplayPreviewResponse
} from '@/api/authoring'
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import { DocumentChecked } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const preview = shallowRef<ModerationReplayPreviewResponse | null>(null)
const form = reactive({
  region: 'CN-MAINLAND',
  policyVersion: '',
  dictionaryId: '',
  limit: 50
})

const metrics = computed(() => {
  if (!preview.value) return []
  return [
    { label: '扫描评论', value: preview.value.scannedCount },
    { label: '受影响评论', value: preview.value.affectedCommentCount },
    { label: '可见性变化', value: preview.value.publicVisibilityChangedCount },
    { label: '高风险变更', value: preview.value.highRiskChangeCount },
    { label: '新增拦截地区', value: preview.value.addedBlockedRegionCount },
    { label: '移除拦截地区', value: preview.value.removedBlockedRegionCount },
    { label: '新增风险标签', value: preview.value.addedRiskLabelCount },
    { label: '移除风险标签', value: preview.value.removedRiskLabelCount }
  ]
})

const runPreview = async (): Promise<void> => {
  loading.value = true
  try {
    preview.value = await previewModerationReplay({
      region: form.region || null,
      policyVersion: form.policyVersion || null,
      dictionaryId: form.dictionaryId || null,
      limit: form.limit
    })
  } catch (error) {
    showErrorToast(error, '策略回放预览失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
