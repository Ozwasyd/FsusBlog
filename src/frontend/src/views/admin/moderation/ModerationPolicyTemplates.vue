<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
    <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略模板</div>
        <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">默认合规模板预设</h2>
        <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">管理员需要结合实际服务地区、部署位置、业务类型和法律意见复核模板。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadTemplates">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="templates" row-key="templateId">
      <el-table-column type="expand">
        <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
          <div class="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]">
            <el-table :data="row.rules" row-key="category">
              <el-table-column label="分类" min-width="180" prop="category" />
              <el-table-column label="提交动作" width="190" prop="submitAction" />
              <el-table-column label="展示动作" width="190" prop="displayAction" />
              <template #empty>
                <AdminInlineEmptyState
                  title="模板暂无规则"
                  description="该模板没有返回提交动作或展示动作规则。"
                />
              </template>
            </el-table>
            <dl class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)]">
              <div v-for="item in templateRows(row)" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-4">
                <dt class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ item.label }}</dt>
                <dd class="mt-2 break-all text-[12px] font-bold text-[var(--fsusblog-text-primary)]">{{ item.value }}</dd>
              </div>
            </dl>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="模板" min-width="240" prop="templateId" />
      <el-table-column label="作用范围" width="130" prop="scope" />
      <el-table-column label="地区" width="140">
        <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">{{ row.region ?? row.regionGroup ?? '-' }}</template>
      </el-table-column>
      <el-table-column label="版本" width="120" prop="version" />
      <el-table-column label="复核" width="190">
        <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
          <el-tag :type="row.reviewedAtUtc ? 'success' : 'warning'">{{ row.reviewedAtUtc ? '已复核' : row.reviewedBy }}</el-tag>
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
          description="默认合规模板预设载入后，会在这里显示作用范围、版本和校验值。"
        />
      </template>
    </el-table>
  </section>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import { listModerationPolicyTemplates, type ModerationPolicyTemplateDefinition } from '@/api/authoring'
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

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

const templateRows = (template: ModerationPolicyTemplateDefinition) => [
  { label: '来源', value: template.source },
  { label: '复核人', value: template.reviewedBy },
  { label: '复核时间', value: template.reviewedAtUtc ?? '-' },
  { label: '说明', value: template.description },
  { label: '规则数', value: String(template.rules.length) }
]

onMounted(() => {
  void loadTemplates()
})
</script>
