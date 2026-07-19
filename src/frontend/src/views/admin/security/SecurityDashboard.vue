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

    <section class="security-dashboard__risk" aria-label="风险摘要">
      <div class="security-dashboard__section-label">风险摘要</div>
      <AdminStatusMatrix :items="riskRows" density="compact" />
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
  { label: '风险控制', helper: '当前策略、风险聚合、验证任务通过/失败率。', name: 'ManageSecurityRiskControl' },
  { label: '风险模拟器', helper: '用生产决策链预演放行、验证、排队和拦截。', name: 'ManageSecuritySimulator' },
  { label: '验证任务', helper: 'Captcha、PoSpace 与通用验证任务的发起、提交和通过结果。', name: 'ManageSecurityChallenges' },
  { label: '策略版本', helper: '反爬虫、工作量证明与风险控制的当前策略和持久化版本。', name: 'ManageSecurityPolicies' },
  { label: '风险事件', helper: '统一风险总线的来源、原因和最近事件明细。', name: 'ManageSecurityEvents' },
  { label: '反爬虫系统', helper: '爬虫识别、CIDR 更新、风险事件与策略模拟。', name: 'ManageSecurityCrawler' },
  { label: 'PoW 系统', helper: '验证任务发起、Proof 有效期、重放防护与风险分联动。', name: 'ManageSecurityPow' }
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
  gap: var(--fsus-space-6);
}

.security-dashboard__overview {
  display: grid;
  gap: var(--fsus-space-3);
}

.security-dashboard__overview-toolbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: var(--fsus-space-4);
  min-width: 0;
}

.security-dashboard__overview-copy {
  min-width: 0;
}

.security-dashboard__overview-copy h2 {
  color: var(--fsusblog-text-primary);
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
}

.security-dashboard__overview-copy p {
  margin-top: var(--fsus-space-1);
  color: var(--fsusblog-text-muted);
  font-size: 14px;
  font-weight: 500;
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
  gap: var(--fsus-space-3);
  min-width: 0;
  min-height: 56px;
  padding: var(--fsus-space-3) var(--fsus-space-4);
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
  gap: var(--fsus-space-1);
}

.security-dashboard__link-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 700;
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

.security-dashboard__risk {
  display: grid;
  gap: var(--fsus-space-2);
  padding-top: var(--fsus-space-1);
  border-top: 1px solid var(--fsusblog-panel-border);
}

.security-dashboard__section-label {
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
}

@media (max-width: 639px) {
  .security-dashboard {
    gap: var(--fsus-space-5);
  }

  .security-dashboard__links {
    grid-template-columns: 1fr;
  }
}
</style>
