<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
    <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <h2 class="text-xl font-bold text-[var(--fsusblog-text-primary)]">合规模板</h2>
        <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">查看各地区/大区使用的默认审核规则；上线前仍需人工复核。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadTemplates">刷新</el-button>
    </div>

    <div class="blog-scroll-x-safe moderation-policy-templates-table-scroll">
      <el-table v-loading="loading" :data="templates" row-key="templateId">
        <el-table-column type="expand">
          <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
            <div class="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]">
              <div class="blog-scroll-x-safe moderation-policy-template-rules-scroll">
                <el-table :data="row.rules" row-key="category">
                  <el-table-column label="分类" min-width="180">
                    <template #default="{ row }: { row: ModerationPolicyTemplateRule }">
                      {{ formatModerationRiskCategory(row.category) }}
                    </template>
                  </el-table-column>
                  <el-table-column label="提交动作" width="190">
                    <template #default="{ row }: { row: ModerationPolicyTemplateRule }">
                      {{ formatModerationAction(row.submitAction) }}
                    </template>
                  </el-table-column>
                  <el-table-column label="展示动作" width="190">
                    <template #default="{ row }: { row: ModerationPolicyTemplateRule }">
                      {{ formatModerationAction(row.displayAction) }}
                    </template>
                  </el-table-column>
                  <template #empty>
                    <AdminInlineEmptyState
                      title="模板暂无规则"
                      description="该模板没有返回提交动作或展示动作规则。"
                    />
                  </template>
                </el-table>
              </div>
              <dl class="grid gap-3">
                <div v-for="item in templateRows(row)" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-4">
                  <dt class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ item.label }}</dt>
                  <dd class="mt-2 break-all text-[12px] font-bold text-[var(--fsusblog-text-primary)]">{{ item.value }}</dd>
                </div>
              </dl>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="模板" min-width="240">
          <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
            <span :title="row.templateId" class="font-semibold text-[var(--fsusblog-text-primary)]">{{ formatTemplateName(row.templateId) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="作用范围" width="130">
          <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">{{ formatTemplateScope(row.scope) }}</template>
        </el-table-column>
        <el-table-column label="地区" width="140">
          <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">{{ formatTemplateTarget(row) }}</template>
        </el-table-column>
        <el-table-column label="版本" width="120">
          <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">{{ formatModerationRegionVersion(row.version) }}</template>
        </el-table-column>
        <el-table-column label="复核" width="190">
          <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
            <el-tag :type="row.reviewedAtUtc ? 'success' : 'warning'">{{ row.reviewedAtUtc ? '已复核' : formatReviewRequirement(row.reviewedBy) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="预设说明" width="110">
          <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
            <el-tag :type="row.notLegalAdvice ? 'info' : 'danger'">{{ row.notLegalAdvice ? '非法律建议' : '缺失' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="校验值" min-width="180">
          <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
            <code class="block truncate text-[11px]">{{ row.checksum }}</code>
          </template>
        </el-table-column>
        <template #empty>
          <AdminInlineEmptyState
            title="暂无策略模板"
            description="合规模板载入后，会在这里显示作用范围、版本和校验值。"
          />
        </template>
      </el-table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import {
  listModerationPolicyTemplates,
  type ModerationPolicyTemplateDefinition,
  type ModerationPolicyTemplateRule
} from '@/api/authoring'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'
import {
  formatModerationAction,
  formatModerationPolicyTemplateScope,
  formatModerationRegionName,
  formatModerationRegionVersion,
  formatModerationReviewRequirement,
  formatModerationRiskCategory,
  formatModerationSourceType
} from '@/utils/moderationRegionDisplay'

const loading = shallowRef(false)
const templates = shallowRef<ModerationPolicyTemplateDefinition[]>([])

const loadTemplates = async (): Promise<void> => {
  loading.value = true
  try {
    templates.value = await listModerationPolicyTemplates()
  } catch (error) {
    showErrorToast(error, '策略模板加载失败')
  } finally {
    loading.value = false
  }
}

const formatTemplateName = (templateId?: string | null): string => formatModerationRegionVersion(templateId)

const formatTemplateScope = (scope?: string | null): string => formatModerationPolicyTemplateScope(scope)

const formatTemplateTarget = (template: ModerationPolicyTemplateDefinition): string => {
  if (template.region) return formatModerationRegionName(template.region)
  if (template.regionGroup) return formatModerationRegionName(template.regionGroup)
  return '全局'
}

const formatReviewRequirement = (reviewer?: string | null): string => formatModerationReviewRequirement(reviewer)

const templateRows = (template: ModerationPolicyTemplateDefinition) => [
  { label: '来源', value: formatModerationSourceType(template.source) },
  { label: '复核要求', value: formatReviewRequirement(template.reviewedBy) },
  { label: '复核时间', value: template.reviewedAtUtc ?? '-' },
  { label: '适用范围', value: formatTemplateScope(template.scope) },
  { label: '适用对象', value: formatTemplateTarget(template) },
  { label: '说明', value: template.description },
  { label: '规则数', value: String(template.rules.length) }
]

onMounted(() => {
  void loadTemplates()
})
</script>

<style scoped>
.moderation-policy-templates-table-scroll,
.moderation-policy-template-rules-scroll {
  max-width: 100%;
  overflow-x: auto;
}
</style>
