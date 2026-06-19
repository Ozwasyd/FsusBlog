<template>
  <div class="space-y-8">
    <WorkbenchPanel
      title="RiskControl 控制面"
      :caption="consoleState ? `策略版本：${activePolicy?.policyVersion ?? '-'}` : ''"
      title-id="security-risk-control-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadConsole">刷新</el-button>
      </template>

      <div class="grid gap-3 md:grid-cols-4">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 break-words text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </WorkbenchPanel>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.72fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">activePolicy</div>
          <div class="mt-2 text-lg font-bold text-[var(--fsusblog-text-primary)]">{{ formatSecurityMode(activePolicy?.globalMode) }}</div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-full md:min-w-[46rem] text-left text-[12px]">
            <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
              <tr class="border-b border-[var(--fsusblog-panel-border)]">
                <th class="px-5 py-3">动作</th>
                <th class="px-5 py-3">挑战</th>
                <th class="px-5 py-3">升级</th>
                <th class="px-5 py-3">阈值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in actionPolicyRows" :key="row.actionName" class="border-b border-[var(--fsusblog-panel-border)]">
                <td class="px-5 py-3 font-bold text-[var(--fsusblog-text-primary)]">{{ row.actionName }}</td>
                <td class="px-5 py-3">{{ row.challengeKind || '-' }}</td>
                <td class="px-5 py-3 tabular-nums">{{ row.escalationLevel }}</td>
                <td class="px-5 py-3 tabular-nums">{{ row.thresholds }}</td>
              </tr>
              <tr v-if="actionPolicyRows.length === 0">
                <td colspan="4" class="px-5 py-10 text-center text-[var(--fsusblog-text-muted)]">暂无策略动作</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">子系统模式</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in subsystemRows" :key="row.name" class="flex items-center justify-between gap-4 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.name }}</span>
            <el-tag>{{ formatSecurityMode(row.mode) }}</el-tag>
          </div>
          <div v-if="subsystemRows.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无子系统配置</div>
        </div>
      </div>
    </section>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">riskEventAggregate</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in riskEventAggregate" :key="`${row.source}:${row.reason}`" class="grid gap-3 p-5 md:grid-cols-[1fr_auto]">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.source }} / {{ row.reason }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">最近：{{ formatTime(row.lastOccurredAtUtc) }}</div>
            </div>
            <div class="text-right text-sm font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ row.count }} 次 / +{{ row.scoreDeltaSum }}</div>
          </div>
          <div v-if="riskEventAggregate.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无聚合事件</div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">高风险主体</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="snapshot in topRiskSnapshots" :key="snapshot.subject" class="flex items-center justify-between gap-4 p-5">
            <div class="min-w-0">
              <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ snapshot.subject }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ snapshot.lastSource }} / {{ snapshot.lastReason }}</div>
            </div>
            <el-tag type="warning">{{ snapshot.score }}</el-tag>
          </div>
          <div v-if="topRiskSnapshots.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无风险快照</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { getRiskControlConsole, type RiskControlConsoleResponse, type SecurityRiskActionPolicy } from '@/api/security'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const consoleState = shallowRef<RiskControlConsoleResponse | null>(null)

const activePolicy = computed(() => consoleState.value?.activePolicy ?? null)
const riskEventAggregate = computed(() => consoleState.value?.riskEventAggregate ?? [])
const topRiskSnapshots = computed(() => consoleState.value?.topRiskSnapshots ?? [])

const formatSecurityMode = (mode: string | null | undefined): string => {
  const labels: Record<string, string> = {
    disabled: '已关闭',
    observe: '观察',
    enforce: '执行',
    strict: '严格',
    lockdown: '锁定'
  }
  return mode ? labels[mode] ?? mode : '-'
}

const formatPercent = (value: number | null | undefined): string =>
  `${Math.round((value ?? 0) * 1000) / 10}%`

const formatTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString() : '-'

const formatThresholds = (policy: SecurityRiskActionPolicy): string =>
  `${policy.thresholds.challengeScore}/${policy.thresholds.hardChallengeScore}/${policy.thresholds.queueScore}/${policy.thresholds.blockScore}`

const actionPolicyRows = computed(() => {
  const policy = activePolicy.value
  if (!policy) return []
  const overrides = Object.values(policy.actionOverrides ?? {})
  return [
    policy.defaultAction,
    ...overrides
  ].map((item) => ({
    actionName: item.actionName,
    challengeKind: item.challengeKind,
    escalationLevel: item.escalationLevel,
    thresholds: formatThresholds(item)
  }))
})

const subsystemRows = computed(() =>
  Object.entries(activePolicy.value?.subsystemModes ?? {}).map(([name, mode]) => ({ name, mode }))
)

const metrics = computed(() => [
  { label: '全局模式', value: formatSecurityMode(activePolicy.value?.globalMode) },
  { label: '24 小时风险事件', value: consoleState.value?.risk.eventsLastDay ?? '-' },
  { label: '挑战成功率', value: formatPercent(consoleState.value?.challengeMetrics.successRate) },
  { label: '挑战失败率', value: formatPercent(consoleState.value?.challengeMetrics.failureRate) }
])

const loadConsole = async (): Promise<void> => {
  loading.value = true
  try {
    consoleState.value = await getRiskControlConsole()
  } catch (error) {
    showErrorToast(error, 'RiskControl 控制面加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadConsole()
})
</script>
