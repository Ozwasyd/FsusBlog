<template>
  <div class="space-y-8">
    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">地区</div>
          <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">地区定义与生效策略</h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">默认策略模板是工程预设，不构成法律建议。</p>
        </div>
        <el-button :icon="Refresh" :loading="loading" @click="loadRegions">刷新</el-button>
      </div>

      <div class="blog-scroll-x-safe moderation-regions-table-scroll">
        <el-table v-loading="loading" :data="regions" row-key="regionCode" highlight-current-row @current-change="selectRegion">
          <el-table-column label="地区" width="150" prop="regionCode" />
          <el-table-column label="显示名称" min-width="170" prop="displayName" />
          <el-table-column label="上级地区" width="130">
            <template #default="{ row }: { row: ModerationRegionDefinition }">{{ row.parentRegion ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="所属大区" width="160">
            <template #default="{ row }: { row: ModerationRegionDefinition }">{{ row.primaryGroup ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="策略模板" min-width="210">
            <template #default="{ row }: { row: ModerationRegionDefinition }">{{ row.policyTemplate ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '已启用' : '已关闭' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="来源类型" width="110">
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <el-tag :type="row.builtin ? 'info' : 'warning'">{{ row.builtin ? '内置' : '自定义' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" align="right" fixed="right">
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <el-button link type="primary" :icon="View" @click="loadPreview(row.regionCode)">预览</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState
              title="暂无地区定义"
              description="内置或自定义地区载入后，会在这里显示生效策略入口。"
            />
          </template>
        </el-table>
      </div>
    </section>

    <section class="grid gap-8 lg:grid-cols-[minmax(20rem,0.75fr)_minmax(0,1fr)]">
      <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">继承链</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="step in preview?.inheritance ?? []" :key="`${step.step}:${step.sourceId}`" class="p-5">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ step.step }}</div>
            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">来源：{{ step.sourceType }}；ID：{{ step.sourceId }}；规则：{{ step.rules.length }} 条</div>
          </div>
          <div v-if="!preview" class="p-5 text-[12px] text-[var(--fsusblog-text-muted)]">选择地区查看生效策略。</div>
        </div>
      </section>

      <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div>
            <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">生效规则</div>
            <div class="mt-1 text-sm font-bold text-[var(--fsusblog-text-primary)]">地区：{{ preview?.region ?? '-' }}；校验值：{{ preview?.checksum ?? '-' }}</div>
          </div>
          <el-tag v-for="warning in preview?.warnings ?? []" :key="warning" type="warning">{{ warning }}</el-tag>
        </div>
        <div class="blog-scroll-x-safe moderation-regions-rules-scroll">
          <el-table :data="preview?.rules ?? []" row-key="category">
            <el-table-column label="分类" min-width="180" prop="category" />
            <el-table-column label="提交动作" width="180" prop="submitAction" />
            <el-table-column label="展示动作" width="190" prop="displayAction" />
            <el-table-column label="来源" min-width="180">
              <template #default="{ row }: { row: ModerationEffectivePolicyRule }">来源：{{ row.sourceType }}；ID：{{ row.sourceId }}</template>
            </el-table-column>
            <template #empty>
              <AdminInlineEmptyState
                :title="preview ? '暂无生效规则' : '选择地区查看生效规则'"
                :description="preview ? '当前地区没有返回可展示的提交或展示动作规则。' : '选择左侧地区后显示继承链计算出的生效规则。'"
              />
            </template>
          </el-table>
        </div>
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
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
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
    showErrorToast(error, '生效策略预览加载失败')
  }
}

onMounted(() => {
  void loadRegions()
})
</script>

<style scoped>
.moderation-regions-table-scroll,
.moderation-regions-rules-scroll {
  max-width: 100%;
  overflow-x: auto;
}
</style>
