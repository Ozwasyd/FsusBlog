<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="挑战状态"
      :description="metricsState ? `窗口起点：${formatTime(metricsState.windowStartedAtUtc)}` : ''"
      id="security-challenges-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadMetrics">刷新</el-button>
      </template>

      <div class="grid gap-3 md:grid-cols-5">
        <div v-for="metric in headerMetrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 break-words text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">挑战类型</div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-full md:min-w-[42rem] text-left text-[12px]">
            <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
              <tr class="border-b border-[var(--fsusblog-panel-border)]">
                <th class="px-5 py-3">类型</th>
                <th class="px-5 py-3">签发</th>
                <th class="px-5 py-3">尝试</th>
                <th class="px-5 py-3">successRate</th>
                <th class="px-5 py-3">failureRate</th>
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
                <td colspan="5" class="px-5 py-10 text-center text-[var(--fsusblog-text-muted)]">暂无挑战数据</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">最近尝试</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="attempt in recentAttempts" :key="attempt.attemptId" class="grid gap-3 p-5 md:grid-cols-[1fr_auto]">
            <div class="min-w-0">
              <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ attempt.challengeId }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ attempt.kind }} / {{ attempt.action }} / {{ attempt.routeKey }}</div>
            </div>
            <div class="text-right">
              <el-tag :type="attempt.outcome === 'verified' ? 'success' : 'warning'">{{ attempt.outcome }}</el-tag>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatTime(attempt.attemptedAtUtc) }}</div>
            </div>
          </div>
          <div v-if="recentAttempts.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无尝试记录</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { getSecurityChallengeMetrics, type SecurityChallengeMetricsResponse } from '@/api/security'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const metricsState = shallowRef<SecurityChallengeMetricsResponse | null>(null)

const successRate = computed(() => metricsState.value?.successRate ?? 0)
const failureRate = computed(() => metricsState.value?.failureRate ?? 0)
const kindBreakdown = computed(() => metricsState.value?.kindBreakdown ?? [])
const recentAttempts = computed(() => metricsState.value?.recentAttempts ?? [])

const formatPercent = (value: number | null | undefined): string =>
  `${Math.round((value ?? 0) * 1000) / 10}%`

const formatTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString() : '-'

const headerMetrics = computed(() => [
  { label: '签发总量', value: metricsState.value?.totalIssued ?? '-' },
  { label: '尝试总量', value: metricsState.value?.totalAttempts ?? '-' },
  { label: '成功', value: metricsState.value?.verified ?? '-' },
  { label: 'successRate', value: formatPercent(successRate.value) },
  { label: 'failureRate', value: formatPercent(failureRate.value) }
])

const loadMetrics = async (): Promise<void> => {
  loading.value = true
  try {
    metricsState.value = await getSecurityChallengeMetrics()
  } catch (error) {
    showErrorToast(error, '挑战状态加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadMetrics()
})
</script>
