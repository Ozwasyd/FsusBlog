<template>
  <div class="space-y-8">
    <WorkbenchPanel
      eyebrow="总览 / OVERVIEW"
      title="审核运行状态"
      :caption="overview ? `model ${overview.modelProvider} / ${overview.modelMode}` : ''"
      title-id="moderation-overview-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadOverview">刷新</el-button>
      </template>

      <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-5">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 text-3xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </WorkbenchPanel>

    <section class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.7fr)]">
      <div class="space-y-8">
        <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
          <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
            <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">关键检查</div>
          </div>
          <div class="divide-y divide-[var(--fsusblog-panel-border)]">
            <div class="flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">CN-MAINLAND strict policy</div>
                <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">大陆 IP 政治敏感与色情内容屏蔽依赖该策略。</p>
              </div>
              <el-tag :type="mainlandStatusType">{{ overview?.mainlandStrictStatus ?? '-' }}</el-tag>
            </div>
            <div v-if="overview?.mainlandStrictStatus !== 'enabled'" class="border-l-4 border-[var(--el-color-warning)] p-5 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
              中国大陆严格策略未启用：大陆 IP 政治敏感与色情内容屏蔽可能失效。
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">词库快照</div>
                <p class="mt-1 break-all text-[12px] text-[var(--fsusblog-text-muted)]">{{ overview?.dictionaryLastError ?? 'loaded' }}</p>
              </div>
              <el-tag :type="overview?.dictionaryLastError ? 'danger' : 'success'">{{ overview?.dictionaryLastError ? 'error' : 'loaded' }}</el-tag>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">审核模型</div>
                <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ overview?.modelContractVersion ?? '-' }} / {{ overview?.modelTimeoutMs ?? '-' }}ms</p>
              </div>
              <el-tag :type="overview?.modelEnabled ? 'success' : 'info'">{{ overview?.modelEnabled ? 'enabled' : 'disabled' }}</el-tag>
            </div>
          </div>
        </section>
      </div>

      <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">入口</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <RouterLink v-for="link in internalLinks" :key="link.name" :to="{ name: link.name }" class="block p-5 hover:bg-[var(--fsusblog-page-bg-soft)]">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ link.label }}</div>
            <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ link.helper }}</p>
          </RouterLink>
          <a href="https://github.com/Ozwasyd/FsusBlog/issues/76" target="_blank" rel="noreferrer" class="block p-5 hover:bg-[var(--fsusblog-page-bg-soft)]">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">#76 provider contract</div>
            <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">第三方模型契约与 sandbox 边界。</p>
          </a>
          <a href="https://github.com/Ozwasyd/FsusBlog/issues/77" target="_blank" rel="noreferrer" class="block p-5 hover:bg-[var(--fsusblog-page-bg-soft)]">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">#77 runtime controls</div>
            <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">模型与词库运行时开关、热替换和区域禁用。</p>
          </a>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { getModerationOverview, type ModerationOverviewResponse } from '@/api/authoring'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const overview = shallowRef<ModerationOverviewResponse | null>(null)

const internalLinks = [
  { label: '评论审核', helper: '审核队列、模型风险信号和地区策略结果。', name: 'ManageModerationComments' },
  { label: '词库管理', helper: '只展示 metadata、checksum 和 evidence policy。', name: 'ManageModerationDictionaries' },
  { label: '地区策略', helper: '查看 policy -> dictionaries 的组合结果。', name: 'ManageModerationPolicies' },
  { label: '策略回放', helper: '先 preview diff，再进入受控执行流程。', name: 'ManageModerationReplay' },
  { label: '审核模型', helper: '模型只提供风险信号，不覆盖地区策略。', name: 'ManageModerationModel' },
  { label: '审核审计', helper: '跳转通用审计日志并预置审核动作。', name: 'ManageModerationAudit' }
] as const

const metrics = computed(() => [
  { label: '待审', value: overview.value?.pendingCount ?? '-' },
  { label: '已拒绝', value: overview.value?.rejectedCount ?? '-' },
  { label: '已隐藏', value: overview.value?.hiddenCount ?? '-' },
  { label: '词库', value: overview.value?.dictionaryCount ?? '-' },
  { label: '地区策略', value: overview.value?.regionPolicyCount ?? '-' }
])

const mainlandStatusType = computed(() => {
  if (overview.value?.mainlandStrictStatus === 'enabled') return 'success'
  if (overview.value?.mainlandStrictStatus === 'invalid') return 'danger'
  return 'warning'
})

const loadOverview = async (): Promise<void> => {
  loading.value = true
  try {
    overview.value = await getModerationOverview()
  } catch (error) {
    showErrorToast(error, '审核系统总览加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadOverview()
})
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
