<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
    <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">大区</div>
        <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">地区大区与成员</h2>
        <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">GREATER_CHINA 与 CN-MAINLAND 是不同策略范围。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadGroups">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="groups" row-key="groupCode">
      <el-table-column type="expand">
        <template #default="{ row }: { row: ModerationRegionGroupDefinition }">
          <div class="flex flex-wrap gap-2 p-5">
            <el-tag v-for="region in row.regions" :key="region" type="info">{{ region }}</el-tag>
            <el-tag v-if="row.regions.length === 0" type="warning">暂无成员</el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="大区" width="180" prop="groupCode" />
      <el-table-column label="显示名称" min-width="190" prop="displayName" />
      <el-table-column label="策略模板" min-width="220">
        <template #default="{ row }: { row: ModerationRegionGroupDefinition }">{{ row.policyTemplate ?? '-' }}</template>
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
          description="地区大区定义载入后，会在这里显示成员数量与策略模板。"
        />
      </template>
    </el-table>
  </section>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import { listModerationRegionGroups, type ModerationRegionGroupDefinition } from '@/api/authoring'
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const groups = shallowRef<ModerationRegionGroupDefinition[]>([])

const loadGroups = async (): Promise<void> => {
  loading.value = true
  try {
    groups.value = await listModerationRegionGroups()
  } catch (error) {
    showErrorToast(error, '地区大区加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadGroups()
})
</script>
