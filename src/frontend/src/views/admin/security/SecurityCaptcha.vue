<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="Captcha 挑战"
      :description="metricsState ? `kind：${captchaV1}` : ''"
      id="security-captcha-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadMetrics">刷新</el-button>
      </template>

      <div class="grid gap-3 md:grid-cols-4">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 break-words text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </FsusUiSettingsSection>

    <section class="grid gap-8 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">运行状态</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in statusRows" :key="row.label" class="flex items-center justify-between gap-4 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.label }}</span>
            <span class="text-sm text-[var(--fsusblog-text-secondary)]">{{ row.value }}</span>
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
            <el-tag :type="attempt.outcome === 'verified' ? 'success' : 'warning'">{{ attempt.outcome }}</el-tag>
          </div>
          <div v-if="attempts.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无 Captcha 尝试</div>
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

const captchaV1 = 'captchaV1'
const loading = shallowRef(false)
const metricsState = shallowRef<SecurityChallengeMetricsResponse | null>(null)

const attempts = computed(() => metricsState.value?.recentAttempts ?? [])

const formatPercent = (value: number | null | undefined): string =>
  `${Math.round((value ?? 0) * 1000) / 10}%`

const metrics = computed(() => [
  { label: '签发', value: metricsState.value?.totalIssued ?? '-' },
  { label: '尝试', value: metricsState.value?.totalAttempts ?? '-' },
  { label: '成功率', value: formatPercent(metricsState.value?.successRate) },
  { label: '失败率', value: formatPercent(metricsState.value?.failureRate) }
])

const statusRows = computed(() => [
  { label: 'kind', value: captchaV1 },
  { label: 'verified', value: String(metricsState.value?.verified ?? 0) },
  { label: 'failed', value: String(metricsState.value?.failed ?? 0) },
  { label: 'replayed', value: String(metricsState.value?.replayed ?? 0) }
])

const loadMetrics = async (): Promise<void> => {
  loading.value = true
  try {
    metricsState.value = await getSecurityChallengeMetrics({ kind: captchaV1 })
  } catch (error) {
    showErrorToast(error, 'Captcha 挑战加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadMetrics()
})
</script>
