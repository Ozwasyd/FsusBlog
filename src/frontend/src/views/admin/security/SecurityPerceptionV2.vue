<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="Perception V2"
      :description="consoleState ? `策略版本：${policy?.policyVersion ?? '-'}` : ''"
      id="security-perception-v2-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadConsole">刷新</el-button>
      </template>

      <AdminStatusMatrix :items="metrics" density="compact" aria-label="Perception V2 指标" />
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略控制</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in policyRows" :key="row.label" class="flex items-center justify-between gap-4 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.label }}</span>
            <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.value }}</el-tag>
          </div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">任务分布</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="task in taskKindDistribution" :key="`${task.taskKind}:${task.challengeKind}`" class="grid gap-3 p-5 md:grid-cols-[1fr_auto]">
            <div class="min-w-0">
              <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ task.taskKind }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ task.challengeKind }}</div>
            </div>
            <div class="text-right text-[12px] tabular-nums text-[var(--fsusblog-text-secondary)]">
              <div>{{ task.issued }} issued / {{ task.verified }} verified</div>
              <div>{{ formatPercent(task.successRate) }} success / {{ task.averagePayloadBytes }} payloadBytes</div>
            </div>
          </div>
          <div v-if="taskKindDistribution.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无 Perception V2 任务记录</div>
        </div>
      </div>
    </section>

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">最近尝试</div>
      </div>
      <div class="divide-y divide-[var(--fsusblog-panel-border)]">
        <div v-for="attempt in recentAttempts" :key="attempt.attemptId" class="grid gap-3 p-5 md:grid-cols-[1fr_auto]">
          <div class="min-w-0">
            <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ attempt.challengeId }}</div>
            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ attempt.action }} / {{ attempt.routeKey }}</div>
          </div>
          <el-tag :type="attempt.outcome === 'verified' ? 'success' : 'warning'">{{ formatOutcome(attempt.outcome) }}</el-tag>
        </div>
        <div v-if="recentAttempts.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无 Perception V2 尝试记录</div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import {
  getPerceptionSealedV2Console,
  updatePerceptionSealedV2Options,
  type PerceptionSealedV2ConsoleResponse
} from '@/api/security'
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const consoleState = shallowRef<PerceptionSealedV2ConsoleResponse | null>(null)

const policy = computed(() => consoleState.value?.policy ?? null)
const options = computed(() => policy.value?.options ?? null)
const metricsState = computed(() => consoleState.value?.metrics ?? null)
const taskKindDistribution = computed(() => metricsState.value?.taskKindDistribution ?? [])
const recentAttempts = computed(() => metricsState.value?.recentAttempts ?? [])

const formatPercent = (value: number | null | undefined): string =>
  `${Math.round((value ?? 0) * 1000) / 10}%`

const enabledLabel = (value: boolean | null | undefined): string => value ? 'enabled' : 'disabled'

const formatOutcome = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    verified: '已通过',
    failed: '未通过',
    replayed: '重放拦截',
    expired: '已过期'
  }
  return value ? labels[value] ?? `结果代码：${value}` : '结果未知'
}

const policyRows = computed(() => [
  { label: 'V2 enabled', value: enabledLabel(options.value?.enabled), enabled: Boolean(options.value?.enabled) },
  { label: 'textTaskEnabled', value: enabledLabel(options.value?.textTaskEnabled), enabled: Boolean(options.value?.textTaskEnabled) },
  { label: 'localizationEnabled', value: enabledLabel(options.value?.localizationEnabled), enabled: Boolean(options.value?.localizationEnabled) },
  { label: 'microInteractionEnabled', value: enabledLabel(options.value?.microInteractionEnabled), enabled: Boolean(options.value?.microInteractionEnabled) },
  { label: 'PoSpace fallback', value: enabledLabel(options.value?.poSpaceFallbackEnabled), enabled: Boolean(options.value?.poSpaceFallbackEnabled) },
  { label: 'early reject', value: String(options.value?.earlyRejectThreshold ?? '-'), enabled: true },
  { label: 'maxAttempts', value: String(options.value?.maxAttempts ?? '-'), enabled: true },
  { label: 'solveDuration', value: `${options.value?.minSolveDurationMs ?? '-'}-${options.value?.maxSolveDurationMs ?? '-'} ms`, enabled: true }
])

const metrics = computed<AdminStatusMatrixItem[]>(() => [
  { label: 'issued', value: metricsState.value?.issued ?? '-' },
  { label: 'successRate', value: formatPercent(metricsState.value?.successRate) },
  { label: 'failureRate', value: formatPercent(metricsState.value?.failureRate) },
  { label: 'payloadBytes', value: `${metricsState.value?.averagePayloadBytes ?? 0} / p95 ${metricsState.value?.p95PayloadBytes ?? 0}` }
])

const loadConsole = async (): Promise<void> => {
  loading.value = true
  try {
    consoleState.value = await getPerceptionSealedV2Console()
  } catch (error) {
    showErrorToast(error, 'Perception V2 加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadConsole()
})

void updatePerceptionSealedV2Options
</script>
