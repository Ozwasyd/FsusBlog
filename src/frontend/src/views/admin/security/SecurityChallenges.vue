<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="客户端验证能力"
      :description="`构建清单 ${capabilityManifestVersion}；能力状态不包含设备、身份或 Proof 数据。`"
      id="security-challenge-capabilities-title"
    >
      <div class="overflow-x-auto border-y border-[var(--fsusblog-panel-border)]">
        <table class="w-full min-w-[58rem] text-left text-[12px]" data-test="challenge-capability-matrix">
          <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
            <tr class="border-b border-[var(--fsusblog-panel-border)]">
              <th class="px-5 py-3">类型</th>
              <th class="px-5 py-3">Provider</th>
              <th class="px-5 py-3">Executor</th>
              <th class="px-5 py-3">UI Host</th>
              <th class="px-5 py-3">Headless Host</th>
              <th class="px-5 py-3">Policy</th>
              <th class="px-5 py-3">业务表面</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in capabilityRows" :key="row.wireName" class="border-b border-[var(--fsusblog-panel-border)]">
              <td class="px-5 py-3 font-bold text-[var(--fsusblog-text-primary)]">{{ row.wireName }}</td>
              <td class="px-5 py-3">{{ statusLabel(row.providerAvailable) }}</td>
              <td class="px-5 py-3">{{ statusLabel(row.executorAvailable) }}</td>
              <td class="px-5 py-3">{{ statusLabel(row.uiHostAvailable) }}</td>
              <td class="px-5 py-3">{{ statusLabel(row.headlessHostAvailable) }}</td>
              <td class="px-5 py-3">{{ row.policyLabel }}</td>
              <td class="px-5 py-3">{{ row.surfaces }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </FsusUiSettingsSection>

    <FsusUiSettingsSection
      title="验证任务状态"
      :description="metricsState ? `统计窗口起点：${formatTime(metricsState.windowStartedAtUtc)}` : ''"
      id="security-challenges-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadMetrics">刷新</el-button>
      </template>

      <AdminStatusMatrix :items="headerMetrics" density="compact" aria-label="验证任务状态指标" />
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">验证任务类型</div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-full md:min-w-[42rem] text-left text-[12px]">
            <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
              <tr class="border-b border-[var(--fsusblog-panel-border)]">
                <th class="px-5 py-3">类型</th>
                <th class="px-5 py-3">发起</th>
                <th class="px-5 py-3">提交</th>
                <th class="px-5 py-3">通过率</th>
                <th class="px-5 py-3">失败率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in kindBreakdown" :key="row.kind" class="border-b border-[var(--fsusblog-panel-border)]">
                <td class="px-5 py-3 font-bold text-[var(--fsusblog-text-primary)]">{{ row.kind }}</td>
                <td class="px-5 py-3 tabular-nums">{{ row.totalIssued }}</td>
                <td class="px-5 py-3 tabular-nums">{{ row.totalAttempts }}</td>
                <td class="px-5 py-3 tabular-nums">{{ formatPercent(row.successRate) }}</td>
                <td class="px-5 py-3 tabular-nums">{{ formatPercent(row.failureRate) }}</td>
              </tr>
              <tr v-if="kindBreakdown.length === 0">
                <td colspan="5" class="px-5 py-10 text-center text-[var(--fsusblog-text-muted)]">暂无验证任务数据</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">最近提交</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="attempt in recentAttempts" :key="attempt.attemptId" class="grid gap-3 p-5 md:grid-cols-[1fr_auto]">
            <div class="min-w-0">
              <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ attempt.challengeId }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ attempt.kind }} / {{ attempt.action }} / {{ attempt.routeKey }}</div>
            </div>
            <div class="text-right">
              <el-tag :type="attempt.outcome === 'verified' ? 'success' : 'warning'">{{ formatOutcome(attempt.outcome) }}</el-tag>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatTime(attempt.attemptedAtUtc) }}</div>
            </div>
          </div>
          <div v-if="recentAttempts.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无验证提交记录</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import {
  getRiskControlOptions,
  getSecurityChallengeMetrics,
  type SecurityChallengeMetricsResponse,
  type SecurityRiskPolicySnapshotV2
} from '@/api/security'
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'
import {
  SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION,
  securityChallengeCapabilityManifest
} from '@/security/challenge-capability-registry'

const loading = shallowRef(false)
const metricsState = shallowRef<SecurityChallengeMetricsResponse | null>(null)
const policyState = shallowRef<SecurityRiskPolicySnapshotV2 | null>(null)

const successRate = computed(() => metricsState.value?.successRate ?? 0)
const failureRate = computed(() => metricsState.value?.failureRate ?? 0)
const kindBreakdown = computed(() => metricsState.value?.kindBreakdown ?? [])
const recentAttempts = computed(() => metricsState.value?.recentAttempts ?? [])
const capabilityManifestVersion = SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION
const capabilityRows = computed(() => securityChallengeCapabilityManifest
  .filter((item) => item.kindKnown)
  .map((item) => {
    const executorAvailable = item.executorFactory !== null
    const uiHostAvailable = item.uiHost !== null
    const headlessHostAvailable = item.headlessHost !== null
    const eligibleSurfaces = item.providerAvailable && executorAvailable && (uiHostAvailable || headlessHostAvailable)
      ? item.surfaces.join(', ')
      : ''
    const subsystem = challengeSubsystemByWireName[item.wireName]
    const policyMode = subsystem ? policyState.value?.subsystemModes[subsystem] : undefined
    return {
      wireName: item.wireName,
      providerAvailable: item.providerAvailable,
      executorAvailable,
      uiHostAvailable,
      headlessHostAvailable,
      policyLabel: !eligibleSurfaces
        ? '不可启用'
        : policyMode
          ? policyMode
          : '按动作策略',
      surfaces: item.surfaces.length > 0 ? item.surfaces.join(', ') : '-'
    }
  }))

const challengeSubsystemByWireName: Readonly<Record<string, string>> = Object.freeze({
  sha256PowV1: 'pow',
  argon2idPoSpaceV1: 'pospace',
  captchaV1: 'captcha',
  perceptionTextTaskV2: 'perception-text-task',
  perceptionCharacterV2: 'perception-text-task',
  perceptionLocalizationV2: 'perception-localization',
  perceptionMicroInteractionV2: 'perception-micro-interaction'
})

const statusLabel = (available: boolean): string => available ? '可用' : '不可用'

const formatPercent = (value: number | null | undefined): string =>
  `${Math.round((value ?? 0) * 1000) / 10}%`

const formatTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString() : '-'

const formatOutcome = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    verified: '已通过',
    failed: '未通过',
    replayed: '重放拦截',
    expired: '已过期'
  }
  return value ? labels[value] ?? `结果代码：${value}` : '结果未知'
}

const headerMetrics = computed<AdminStatusMatrixItem[]>(() => [
  { label: '发起总量', value: metricsState.value?.totalIssued ?? '-' },
  { label: '提交总量', value: metricsState.value?.totalAttempts ?? '-' },
  { label: '通过次数', value: metricsState.value?.verified ?? '-' },
  { label: '通过率', value: formatPercent(successRate.value) },
  { label: '失败率', value: formatPercent(failureRate.value) }
])

const loadMetrics = async (): Promise<void> => {
  loading.value = true
  try {
    const [metrics, policy] = await Promise.all([
      getSecurityChallengeMetrics(),
      getRiskControlOptions()
    ])
    metricsState.value = metrics
    policyState.value = policy
  } catch (error) {
    showErrorToast(error, '验证任务状态加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadMetrics()
})
</script>
