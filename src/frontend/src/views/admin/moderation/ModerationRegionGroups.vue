<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
    <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <h2 class="text-xl font-bold text-[var(--fsusblog-text-primary)]">大区成员</h2>
        <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">按大区查看覆盖地区和策略模板；中国大陆单独使用地区策略。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadGroups">刷新</el-button>
    </div>

    <div class="blog-scroll-x-safe moderation-region-groups-table-scroll">
      <el-table v-loading="loading" :data="groups" row-key="groupCode">
        <el-table-column type="expand">
          <template #default="{ row }: { row: ModerationRegionGroupDefinition }">
            <div class="flex flex-wrap gap-2 p-5">
              <el-tag v-for="region in row.regions" :key="region" type="info" :title="region">{{
                formatRegionName(region)
              }}</el-tag>
              <el-tag v-if="row.regions.length === 0" type="warning">暂无成员</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="大区" min-width="190">
          <template #default="{ row }: { row: ModerationRegionGroupDefinition }">
            <span class="moderation-region-group-name" :title="row.groupCode">{{
              formatGroupName(row)
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="策略模板" min-width="220">
          <template #default="{ row }: { row: ModerationRegionGroupDefinition }">{{
            formatPolicyTemplate(row.policyTemplate)
          }}</template>
        </el-table-column>
        <el-table-column label="成员数" width="110" align="right">
          <template #default="{ row }: { row: ModerationRegionGroupDefinition }">{{ row.regions.length }}</template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }: { row: ModerationRegionGroupDefinition }">
            <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '已启用' : '已关闭' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源类型" width="110">
          <template #default="{ row }: { row: ModerationRegionGroupDefinition }">
            <el-tag :type="row.builtin ? 'info' : 'warning'">{{ row.builtin ? '内置' : '自定义' }}</el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <AdminInlineEmptyState
            title="暂无地区大区"
            description="大区定义载入后，会在这里显示覆盖地区和策略模板。"
          />
        </template>
      </el-table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import { listModerationRegionGroups, type ModerationRegionGroupDefinition } from '@/api/authoring'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'
import {
  formatModerationRegionName,
  formatModerationRegionVersion,
} from '@/utils/moderationRegionDisplay'

const loading = shallowRef(false)
const groups = shallowRef<ModerationRegionGroupDefinition[]>([])

const formatRegionName = (region?: string | null): string => formatModerationRegionName(region)

const formatPolicyTemplate = (template?: string | null): string =>
  template ? formatModerationRegionVersion(template) : '-'

const formatGroupName = (group: ModerationRegionGroupDefinition): string => {
  const formatted = formatModerationRegionName(group.groupCode)
  return formatted !== group.groupCode ? formatted : group.displayName
}

const loadGroups = async (): Promise<void> => {
  loading.value = true
  try {
    groups.value = await listModerationRegionGroups()
  } catch (error) {
    showErrorToast(error, '大区加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadGroups()
})
</script>

<style scoped>
.moderation-region-groups-table-scroll {
  max-width: 100%;
  overflow-x: auto;
}

.moderation-region-group-name {
  color: var(--fsusblog-text-primary);
  font-weight: 700;
}
</style>
