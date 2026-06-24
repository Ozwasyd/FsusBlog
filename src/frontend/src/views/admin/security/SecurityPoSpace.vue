<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="PoSpace 挑战"
      :description="policyState ? `RiskControl：${policyState.activePolicy.policyVersion}` : ''"
      id="security-pospace-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadPage">刷新</el-button>
      </template>

      <AdminStatusMatrix :items="metrics" density="compact" aria-label="PoSpace 指标" />
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">RiskControl 绑定</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in policyRows" :key="row.label" class="p-5">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.label }}</div>
            <div class="mt-1 break-words text-[12px] text-[var(--fsusblog-text-muted)]">{{ row.value }}</div>
          </div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">最近尝试</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="attempt in attempts" :key="attempt.attemptId" class="grid gap-3 p-5 md:grid-cols-[1fr_auto]">
            <div class="min-w-0">
              <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ attempt.challengeId }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ attempt.action }} / {{ attempt.routeKey }}</div>
            </div>
            <el-tag :type="attempt.outcome === 'verified' ? 'success' : 'warning'">{{ formatOutcome(attempt.outcome) }}</el-tag>
          </div>
          <div v-if="attempts.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无 PoSpace 尝试记录</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import {
  getSecurityChallengeMetrics,
  getSecurityPolicyConsole,
  type SecurityChallengeMetricsResponse,
  type SecurityPolicyConsoleResponse
} from '@/api/security'
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const argon2idPoSpaceV1 = 'argon2idPoSpaceV1'
const loading = shallowRef(false)
const metricsState = shallowRef<SecurityChallengeMetricsResponse | null>(null)
const policyState = shallowRef<SecurityPolicyConsoleResponse | null>(null)

const attempts = computed(() => metricsState.value?.recentAttempts ?? [])

const formatPercent = (value: number | null | undefined): string =>
  `${Math.round((value ?? 0) * 1000) / 10}%`

const formatOutcome = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    verified: '已通过',
    failed: '未通过',
    replayed: '重放拦截',
    expired: '已过期'
  }
  return value ? labels[value] ?? `结果代码：${value}` : '结果未知'
}

const hardChallengeActions = computed(() => {
  const activePolicy = policyState.value?.activePolicy
  if (!activePolicy) return []
  return Object.values(activePolicy.actionOverrides ?? {})
    .filter((item) => item.hardChallengeKinds?.includes(argon2idPoSpaceV1))
    .map((item) => item.actionName)
})

const policyRows = computed<AdminStatusMatrixItem[]>(() => [
  { label: 'kind', value: argon2idPoSpaceV1 },
  { label: '全局模式', value: policyState.value?.activePolicy.globalMode ?? '-' },
  { label: '硬挑战动作', value: hardChallengeActions.value.join(', ') || '-' },
  { label: '最大风险分', value: String(policyState.value?.activePolicy.maxRiskScore ?? '-') }
])

const metrics = computed<AdminStatusMatrixItem[]>(() => [
  { label: '签发', value: metricsState.value?.totalIssued ?? '-' },
  { label: '尝试', value: metricsState.value?.totalAttempts ?? '-' },
  { label: '成功率', value: formatPercent(metricsState.value?.successRate) },
  { label: '失败率', value: formatPercent(metricsState.value?.failureRate) }
])

const loadPage = async (): Promise<void> => {
  loading.value = true
  try {
    const [challengeMetrics, policyConsole] = await Promise.all([
      getSecurityChallengeMetrics({ kind: argon2idPoSpaceV1 }),
      getSecurityPolicyConsole()
    ])
    metricsState.value = challengeMetrics
    policyState.value = policyConsole
  } catch (error) {
    showErrorToast(error, 'PoSpace 挑战加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadPage()
})
</script>
