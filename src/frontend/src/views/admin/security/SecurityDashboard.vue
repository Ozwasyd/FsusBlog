<template>
  <div class="space-y-8">
    <WorkbenchPanel
      eyebrow="总览 / SECURITY"
      title="安全运行总览"
      :caption="overview ? `checked ${formatTime(overview.checkedAtUtc)}` : ''"
      title-id="security-overview-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadOverview">刷新</el-button>
      </template>

      <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-4">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 break-words text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </WorkbenchPanel>

    <section class="grid gap-8 lg:grid-cols-3">
      <RouterLink
        v-for="link in links"
        :key="link.name"
        :to="{ name: link.name }"
        class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] p-5 transition hover:bg-[var(--fsusblog-page-bg-soft)]"
      >
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ link.eyebrow }}</div>
        <div class="mt-3 text-xl font-bold text-[var(--fsusblog-text-primary)]">{{ link.label }}</div>
        <p class="mt-2 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">{{ link.helper }}</p>
      </RouterLink>
    </section>

    <section class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.65fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">模块边界</div>
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
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险摘要</div>
        </div>
        <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)]">
          <div v-for="row in riskRows" :key="row.label" class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ row.label }}</div>
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
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const overview = shallowRef<SecurityOverviewResponse | null>(null)

const links = [
  { eyebrow: 'ANTI-CRAWLER', label: '反爬虫系统', helper: 'Crawler detection、CIDR 更新、风险事件、策略模拟器。', name: 'ManageSecurityCrawler' },
  { eyebrow: 'PROOF OF WORK', label: 'PoW 系统', helper: 'Challenge、proof TTL、replay 防护与风险分联动。', name: 'ManageSecurityPow' },
  { eyebrow: 'SECURITY RISK', label: '统一风险信号', helper: '反爬虫、限流、ReadProof 和 PoW 都写入统一风险总线。', name: 'ManageSecurityCrawler' }
] as const

const metrics = computed(() => [
  { label: '反爬虫模式', value: overview.value?.antiCrawler.mode ?? '-' },
  { label: 'CIDR Source', value: overview.value?.antiCrawler.cidrSource ?? '-' },
  { label: 'PoW 模式', value: overview.value?.pow.policy.options.mode ?? '-' },
  { label: '高风险主体', value: overview.value?.risk.highRiskSnapshotCount ?? '-' }
])

const riskRows = computed(() => [
  { label: 'Risk events / 1h', value: overview.value?.risk.eventsLastHour ?? '-' },
  { label: 'Risk events / 24h', value: overview.value?.risk.eventsLastDay ?? '-' },
  { label: 'Top reason', value: overview.value?.risk.topReason ?? '-' },
  { label: 'Top source', value: overview.value?.risk.topSource ?? '-' }
])

const boundaryRows = [
  { label: 'AntiCrawler', value: '只处理 crawler detection、crawler policy、crawler event，并向 SecurityRisk 写入信号。' },
  { label: 'PoW', value: '只处理 challenge/proof/difficulty；它是安全系统能力，不挂在反爬虫下面。' },
  { label: 'HumanReadProof / RateLimiter', value: '只写入各自来源的风险信号，不依赖 AntiCrawler 具体实现。' }
] as const

const formatTime = (value: string | null | undefined): string => value ? new Date(value).toLocaleString() : '-'

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
