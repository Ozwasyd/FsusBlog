<template>
  <div class="security-dashboard">
    <section
      class="security-dashboard__overview"
      aria-labelledby="security-overview-title"
    >
      <div class="security-dashboard__overview-toolbar">
        <div class="security-dashboard__overview-copy">
          <h2 id="security-overview-title">安全运行总览</h2>
          <p v-if="overview">检查时间：{{ formatTime(overview.checkedAtUtc) }}</p>
        </div>
        <el-button :icon="Refresh" :loading="loading" @click="loadOverview">刷新</el-button>
      </div>

      <AdminStatusMatrix :items="metrics" density="compact" />
    </section>

    <section class="security-dashboard__links" aria-label="安全系统入口">
      <RouterLink
        v-for="link in links"
        :key="link.name"
        :to="{ name: link.name }"
        class="security-dashboard__link"
      >
        <span class="security-dashboard__link-copy">
          <strong>{{ link.label }}</strong>
          <span>{{ link.helper }}</span>
        </span>
        <ArrowRight class="security-dashboard__link-icon" aria-hidden="true" />
      </RouterLink>
    </section>

    <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.65fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] px-4 py-3">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">模块边界</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in boundaryRows" :key="row.label" class="px-4 py-3">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.label }}</div>
            <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">{{ row.value }}</p>
          </div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] px-4 py-3">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险摘要</div>
        </div>
        <AdminStatusMatrix :items="riskRows" density="compact" />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { getSecurityOverview, type SecurityOverviewResponse } from '@/api/security'
import AdminStatusMatrix, { type AdminStatusMatrixItem, type AdminStatusMatrixTone } from '@/components/admin/AdminStatusMatrix.vue'
import { ArrowRight, Refresh } from '@/fsusui/icons'
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
    enforce: '执行中',
    strict: '严格'
  }
  return mode ? labels[mode] ?? mode : '未配置'
}

const modeTone = (mode: string | null | undefined): AdminStatusMatrixTone => {
  if (mode === 'disabled') return 'neutral'
  if (mode === 'observe') return 'info'
  if (mode === 'strict') return 'warning'
  if (mode === 'enforce') return 'success'
  return 'neutral'
}

const countTone = (value: number | null | undefined): AdminStatusMatrixTone =>
  value && value > 0 ? 'warning' : 'neutral'

const metrics = computed<AdminStatusMatrixItem[]>(() => [
  {
    label: '反爬虫',
    value: formatSecurityMode(overview.value?.antiCrawler.mode),
    tone: modeTone(overview.value?.antiCrawler.mode)
  },
  {
    label: 'CIDR',
    value: overview.value?.antiCrawler.cidrSource ?? '未记录',
    tone: overview.value?.antiCrawler.cidrSource ? 'info' : 'neutral'
  },
  {
    label: 'PoW',
    value: formatSecurityMode(overview.value?.pow.policy.options.mode),
    tone: modeTone(overview.value?.pow.policy.options.mode)
  },
  {
    label: '高风险主体',
    value: overview.value?.risk.highRiskSnapshotCount ?? '未记录',
    tone: countTone(overview.value?.risk.highRiskSnapshotCount)
  }
])

const riskRows = computed<AdminStatusMatrixItem[]>(() => [
  {
    label: '1 小时事件',
    value: overview.value?.risk.eventsLastHour ?? '未记录',
    tone: countTone(overview.value?.risk.eventsLastHour)
  },
  {
    label: '24 小时事件',
    value: overview.value?.risk.eventsLastDay ?? '未记录',
    tone: countTone(overview.value?.risk.eventsLastDay)
  },
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

<style scoped>
.security-dashboard {
  display: grid;
  gap: 24px;
}

.security-dashboard__overview {
  display: grid;
  gap: 12px;
}

.security-dashboard__overview-toolbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
}

.security-dashboard__overview-copy {
  min-width: 0;
}

.security-dashboard__overview-copy h2 {
  color: var(--fsusblog-text-primary);
  font-size: 20px;
  font-weight: 900;
  line-height: 1.2;
}

.security-dashboard__overview-copy p {
  margin-top: 4px;
  color: var(--fsusblog-text-muted);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
}

.security-dashboard__links {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  overflow: hidden;
  border-top: 1px solid var(--fsusblog-panel-border);
  border-left: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}

.security-dashboard__link {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 56px;
  padding: 12px 16px;
  color: var(--fsusblog-text-primary);
  background: var(--fsusblog-page-bg);
  border-right: 1px solid var(--fsusblog-panel-border);
  border-bottom: 1px solid var(--fsusblog-panel-border);
  transition:
    background-color var(--fsus-motion-control),
    color var(--fsus-motion-control);
}

.security-dashboard__link:hover {
  color: var(--fsusblog-color-primary);
  background: var(--fsusblog-page-bg-soft);
}

.security-dashboard__link-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.security-dashboard__link-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 800;
}

.security-dashboard__link-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.security-dashboard__link-icon {
  width: 16px;
  height: 16px;
  color: var(--fsusblog-text-muted);
}

@media (max-width: 480px) {
  .security-dashboard {
    gap: 20px;
  }

  .security-dashboard__links {
    grid-template-columns: 1fr;
  }
}
</style>
