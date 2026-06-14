<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
    <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略模板</div>
        <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">默认合规模板 presets</h2>
        <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">Operators must review templates against actual service regions, deployment location, business type, and legal counsel.</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadTemplates">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="templates" row-key="templateId">
      <el-table-column type="expand">
        <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
          <div class="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]">
            <el-table :data="row.rules" row-key="category">
              <el-table-column label="Category" min-width="180" prop="category" />
              <el-table-column label="Submit" width="190" prop="submitAction" />
              <el-table-column label="Display" width="190" prop="displayAction" />
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
      <el-table-column label="Template" min-width="240" prop="templateId" />
      <el-table-column label="Scope" width="130" prop="scope" />
      <el-table-column label="Region" width="140">
        <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">{{ row.region ?? row.regionGroup ?? '-' }}</template>
      </el-table-column>
      <el-table-column label="Version" width="120" prop="version" />
      <el-table-column label="Review" width="190">
        <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
          <el-tag :type="row.reviewedAtUtc ? 'success' : 'warning'">{{ row.reviewedAtUtc ? 'reviewed' : row.reviewedBy }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Preset" width="110">
        <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
          <el-tag :type="row.notLegalAdvice ? 'info' : 'danger'">{{ row.notLegalAdvice ? 'not legal advice' : 'missing' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Checksum" min-width="180">
        <template #default="{ row }: { row: ModerationPolicyTemplateDefinition }">
          <code class="block truncate text-[11px]">{{ row.checksum }}</code>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import { listModerationPolicyTemplates, type ModerationPolicyTemplateDefinition } from '@/api/authoring'
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
  { label: 'Source', value: template.source },
  { label: 'Reviewed By', value: template.reviewedBy },
  { label: 'Reviewed At', value: template.reviewedAtUtc ?? '-' },
  { label: 'Description', value: template.description },
  { label: 'Rule Count', value: String(template.rules.length) }
]

onMounted(() => {
  void loadTemplates()
})
</script>
