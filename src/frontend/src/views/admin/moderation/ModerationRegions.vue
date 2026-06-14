<template>
  <div class="space-y-8">
    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">地区</div>
          <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">地区定义与 effective policy</h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">Default policy templates are engineering presets. They are not legal advice.</p>
        </div>
        <el-button :icon="Refresh" :loading="loading" @click="loadRegions">刷新</el-button>
      </div>

      <el-table v-loading="loading" :data="regions" row-key="regionCode" highlight-current-row @current-change="selectRegion">
        <el-table-column label="Region" width="150" prop="regionCode" />
        <el-table-column label="Display Name" min-width="170" prop="displayName" />
        <el-table-column label="Parent" width="130">
          <template #default="{ row }: { row: ModerationRegionDefinition }">{{ row.parentRegion ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="Primary Group" width="160">
          <template #default="{ row }: { row: ModerationRegionDefinition }">{{ row.primaryGroup ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="Template" min-width="210">
          <template #default="{ row }: { row: ModerationRegionDefinition }">{{ row.policyTemplate ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="Status" width="120">
          <template #default="{ row }: { row: ModerationRegionDefinition }">
            <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? 'enabled' : 'disabled' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Kind" width="110">
          <template #default="{ row }: { row: ModerationRegionDefinition }">
            <el-tag :type="row.builtin ? 'info' : 'warning'">{{ row.builtin ? 'built-in' : 'custom' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" align="right" fixed="right">
          <template #default="{ row }: { row: ModerationRegionDefinition }">
            <el-button link type="primary" :icon="View" @click="loadPreview(row.regionCode)">preview</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="grid gap-8 lg:grid-cols-[minmax(20rem,0.75fr)_minmax(0,1fr)]">
      <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">Inheritance</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="step in preview?.inheritance ?? []" :key="`${step.step}:${step.sourceId}`" class="p-5">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ step.step }}</div>
            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ step.sourceType }} / {{ step.sourceId }} / {{ step.rules.length }} rules</div>
          </div>
          <div v-if="!preview" class="p-5 text-[12px] text-[var(--fsusblog-text-muted)]">选择地区查看 effective policy。</div>
        </div>
      </section>

      <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div>
            <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">Effective Rules</div>
            <div class="mt-1 text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ preview?.region ?? '-' }} / {{ preview?.checksum ?? '-' }}</div>
          </div>
          <el-tag v-for="warning in preview?.warnings ?? []" :key="warning" type="warning">{{ warning }}</el-tag>
        </div>
        <el-table :data="preview?.rules ?? []" row-key="category">
          <el-table-column label="Category" min-width="180" prop="category" />
          <el-table-column label="Submit" width="180" prop="submitAction" />
          <el-table-column label="Display" width="190" prop="displayAction" />
          <el-table-column label="Source" min-width="180">
            <template #default="{ row }: { row: ModerationEffectivePolicyRule }">{{ row.sourceType }} / {{ row.sourceId }}</template>
          </el-table-column>
        </el-table>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import {
  getModerationEffectivePolicy,
  listModerationRegions,
  type ModerationEffectivePolicyPreview,
  type ModerationEffectivePolicyRule,
  type ModerationRegionDefinition
} from '@/api/authoring'
import { Refresh, View } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const regions = shallowRef<ModerationRegionDefinition[]>([])
const preview = shallowRef<ModerationEffectivePolicyPreview | null>(null)

const loadRegions = async (): Promise<void> => {
  loading.value = true
  try {
    regions.value = await listModerationRegions()
    if (!preview.value && regions.value.length > 0) {
      await loadPreview(regions.value[0]!.regionCode)
    }
  } catch (error) {
    showErrorToast(error, '地区定义加载失败')
  } finally {
    loading.value = false
  }
}

const selectRegion = (row?: ModerationRegionDefinition): void => {
  if (row) {
    void loadPreview(row.regionCode)
  }
}

const loadPreview = async (regionCode: string): Promise<void> => {
  try {
    preview.value = await getModerationEffectivePolicy(regionCode)
  } catch (error) {
    showErrorToast(error, 'effective policy preview 加载失败')
  }
}

onMounted(() => {
  void loadRegions()
})
</script>
