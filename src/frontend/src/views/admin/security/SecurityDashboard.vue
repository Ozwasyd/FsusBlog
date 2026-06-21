<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="安全运行总览"
      :description="overview ? `检查时间：${formatTime(overview.checkedAtUtc)}` : ''"
      id="security-overview-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadOverview">刷新</el-button>
      </template>

      <div class="grid gap-3 md:grid-cols-4">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 break-words text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </FsusUiSettingsSection>

    <section class="grid gap-8 lg:grid-cols-3">
      <RouterLink
        v-for="link in links"
        :key="link.name"
        :to="{ name: link.name }"
        class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] p-5 transition hover:bg-[var(--fsusblog-page-bg-soft)]"
      >
        <div class="text-xl font-bold text-[var(--fsusblog-text-primary)]">{{ link.label }}</div>
        <p class="mt-2 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">{{ link.helper }}</p>
      </RouterLink>
    </section>

    <section class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.65fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">模块边界</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in boundaryRows" :key="row.label" class="p-5">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.label }}</div>
            <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">{{ row.value }}</p>
          </div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险摘要</div>
        </div>
        <div class="grid gap-3">
          <div v-for="row in riskRows" :key="row.label" class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ row.label }}</div>
            <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.value }}</div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { getSecurityOverview, type SecurityOverviewResponse } from '@/api/security'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const overview = shallowRef<SecurityOverviewResponse | null>(null)

const links = [
  { label: 'RiskControl 控制面', helper: 'active policy、风险聚合、挑战成功/失败率。', name: 'ManageSecurityRiskControl' },
  { label: 'RiskControl 模拟器', helper: '用生产决策链预演 allow、challenge、queue、block。', name: 'ManageSecuritySimulator' },
  { label: '挑战状态', helper: 'Captcha、PoSpace 与通用 challenge 的签发和验证结果。', name: 'ManageSecurityChallenges' },
  { label: '策略版本', helper: '反爬虫、PoW 与 RiskControl 的当前策略和持久化版本。', name: 'ManageSecurityPolicies' },
  { label: '风险事件', helper: '统一风险总线的来源、原因和最近事件明细。', name: 'ManageSecurityEvents' },
  { label: '反爬虫系统', helper: '爬虫识别、CIDR 更新、风险事件与策略模拟。', name: 'ManageSecurityCrawler' },
  { label: 'PoW 系统', helper: '挑战签发、Proof 有效期、重放防护与风险分联动。', name: 'ManageSecurityPow' }
] as const

const formatSecurityMode = (mode: string | null | undefined): string => {
  const labels: Record<string, string> = {
    disabled: '已关闭',
    observe: '观察',
    enforce: '执行',
    strict: '严格'
  }
  return mode ? labels[mode] ?? mode : '未配置'
}

const metrics = computed(() => [
  { label: '反爬虫模式', value: formatSecurityMode(overview.value?.antiCrawler.mode) },
  { label: 'CIDR 来源', value: overview.value?.antiCrawler.cidrSource ?? '未记录' },
  { label: 'PoW 模式', value: formatSecurityMode(overview.value?.pow.policy.options.mode) },
  { label: '高风险主体', value: overview.value?.risk.highRiskSnapshotCount ?? '未记录' }
])

const riskRows = computed(() => [
  { label: '1 小时风险事件', value: overview.value?.risk.eventsLastHour ?? '未记录' },
  { label: '24 小时风险事件', value: overview.value?.risk.eventsLastDay ?? '未记录' },
  { label: '主要原因', value: overview.value?.risk.topReason ?? '未记录' },
  { label: '主要来源', value: overview.value?.risk.topSource ?? '未记录' }
])

const boundaryRows = [
  { label: '反爬虫', value: '只处理爬虫识别、爬虫策略和爬虫事件，并向 SecurityRisk 写入信号。' },
  { label: 'PoW', value: '只处理 challenge、proof、difficulty；它是安全系统能力，不挂在反爬虫下面。' },
  { label: 'ReadProof / 限流', value: '只写入各自来源的风险信号，不依赖反爬虫具体实现。' }
] as const

const formatTime = (value: string | null | undefined): string => value ? new Date(value).toLocaleString() : '未记录'

const loadOverview = async (): Promise<void> => {
  loading.value = true
  try {
    overview.value = await getSecurityOverview()
  } catch (error) {
    showErrorToast(error, '安全系统总览加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadOverview()
})
</script>
