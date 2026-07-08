<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="人机感知验证"
      :description="consoleState ? `策略版本：${policy?.policyVersion ?? '-'}` : ''"
      id="security-perception-v2-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadConsole">刷新</el-button>
      </template>

      <AdminStatusMatrix :items="metrics" density="compact" aria-label="人机感知验证指标" />
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.96fr)_minmax(0,1.04fr)]">
      <div
        class="blog-motion-task-region border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
        :class="{
          'blog-motion-task-region--pending': saving,
          'blog-motion-task-region--settled': isTaskHighlighted('security-perception-v2-options')
        }"
      >
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div>
            <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略开关</div>
            <div class="mt-2 text-lg font-bold text-[var(--fsusblog-text-primary)]">人机感知验证</div>
            <p class="mt-1 max-w-[34rem] text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">
              控制评论、恢复密钥等高风险操作里是否使用人机感知验证，以及允许哪些题型和失败边界。开关会立即写入后端；数值调整会在下方出现保存动作。
            </p>
          </div>
          <div class="perception-v2-sync-state" aria-live="polite">
            <span class="perception-v2-sync-state__dot" :class="`perception-v2-sync-state__dot--${policySyncTone}`" aria-hidden="true" />
            <span>{{ policySyncLabel }}</span>
          </div>
        </div>

        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div class="flex items-center justify-between gap-4 p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">启用人机感知验证</div>
              <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">总开关。关闭后不会签发这类感知验证题。</p>
            </div>
            <el-switch
              v-model="draft.enabled"
              aria-label="启用人机感知验证"
              :disabled="saving || !isPolicyLoaded"
              :loading="pendingOptionKey === 'enabled'"
              @change="(value) => submitSwitchOption('enabled', value)"
            />
          </div>

          <div class="flex items-center justify-between gap-4 p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">文字识别题</div>
              <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">让用户输入画面中的短文本，适合低到中风险拦截。</p>
            </div>
            <el-switch
              v-model="draft.textTaskEnabled"
              aria-label="启用文字识别题"
              :disabled="saving || !isPolicyLoaded"
              :loading="pendingOptionKey === 'textTaskEnabled'"
              @change="(value) => submitSwitchOption('textTaskEnabled', value)"
            />
          </div>

          <div class="flex items-center justify-between gap-4 p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">点选定位题</div>
              <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">让用户点击画面中的目标位置，比纯文字题更难被批量脚本绕过。</p>
            </div>
            <el-switch
              v-model="draft.localizationEnabled"
              aria-label="启用点选定位题"
              :disabled="saving || !isPolicyLoaded"
              :loading="pendingOptionKey === 'localizationEnabled'"
              @change="(value) => submitSwitchOption('localizationEnabled', value)"
            />
          </div>

          <div class="flex items-center justify-between gap-4 p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">微交互题</div>
              <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">让用户完成轻量拖拽或点击序列。默认可保持关闭，确认前端体验稳定后再开。</p>
            </div>
            <el-switch
              v-model="draft.microInteractionEnabled"
              aria-label="启用微交互题"
              :disabled="saving || !isPolicyLoaded"
              :loading="pendingOptionKey === 'microInteractionEnabled'"
              @change="(value) => submitSwitchOption('microInteractionEnabled', value)"
            />
          </div>

          <div class="flex items-center justify-between gap-4 p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">PoSpace 兜底</div>
              <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">高风险场景可升级到设备算力/内存证明；弱设备或移动端会按后端策略降级。</p>
            </div>
            <el-switch
              v-model="draft.poSpaceFallbackEnabled"
              aria-label="启用 PoSpace 兜底"
              :disabled="saving || !isPolicyLoaded"
              :loading="pendingOptionKey === 'poSpaceFallbackEnabled'"
              @change="(value) => submitSwitchOption('poSpaceFallbackEnabled', value)"
            />
          </div>

          <div class="grid gap-4 p-5 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">答题耗时范围</div>
              <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">用来拦截明显过快的脚本提交和已经超时的挑战提交。</p>
            </div>

            <div class="perception-v2-number-field min-w-0">
              <div class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">提前拒绝分</div>
              <el-input-number v-model="draft.earlyRejectThreshold" aria-label="提前拒绝分" class="perception-v2-number-field__input" :min="60" :max="90" controls-position="right" />
              <p class="text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">风险分达到这个值后直接拒绝，不再发题。</p>
            </div>

            <div class="perception-v2-number-field min-w-0">
              <div class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">最多尝试次数</div>
              <el-input-number v-model="draft.maxAttempts" aria-label="最多尝试次数" class="perception-v2-number-field__input" :min="1" :max="10" controls-position="right" />
              <p class="text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">同一个挑战最多允许提交几次答案。</p>
            </div>

            <div class="perception-v2-number-field min-w-0">
              <div class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">最短答题耗时（毫秒）</div>
              <el-input-number v-model="draft.minSolveDurationMs" aria-label="最短答题耗时（毫秒）" class="perception-v2-number-field__input" :min="0" :max="10000" :step="50" controls-position="right" />
              <p class="text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">太快提交会被认为像脚本。</p>
            </div>

            <div class="perception-v2-number-field min-w-0">
              <div class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">最长答题耗时（毫秒）</div>
              <el-input-number v-model="draft.maxSolveDurationMs" aria-label="最长答题耗时（毫秒）" class="perception-v2-number-field__input" :min="1000" :max="300000" :step="1000" controls-position="right" />
              <p class="text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">超时提交会被认为挑战已失效。</p>
            </div>

            <div class="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--fsusblog-panel-border)] pt-4">
              <p class="max-w-[30rem] text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">
                数值改动不会自动提交；保存时会要求填写变更原因并完成管理员二次验证。
              </p>
              <div class="flex flex-wrap items-center gap-2">
                <el-button :disabled="!hasDraftChanges || saving" @click="resetDraftChanges">放弃数值修改</el-button>
                <el-button type="primary" :loading="saving" :disabled="!hasDraftChanges || saving" @click="saveOptions">保存数值策略</el-button>
              </div>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">服务器快照</div>
              <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">恢复后端上一份人机感知验证策略快照；这不是撤销当前页面草稿。</p>
            </div>
            <el-button type="warning" plain :loading="saving" :disabled="saving || !isPolicyLoaded" @click="rollbackOptions">恢复上一版策略</el-button>
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
              <div>{{ task.issued }} 次签发 / {{ task.verified }} 次通过</div>
              <div>{{ formatPercent(task.successRate) }} 成功 / 平均载荷 {{ task.averagePayloadBytes }} bytes</div>
            </div>
          </div>
          <div v-if="taskKindDistribution.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无人机感知验证任务记录</div>
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
        <div v-if="recentAttempts.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无人机感知验证尝试记录</div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue'
import {
  getPerceptionSealedV2Console,
  rollbackPerceptionSealedV2Options,
  updatePerceptionSealedV2Options,
  type PerceptionSealedV2ConsoleResponse,
  type PerceptionSealedV2PolicyOptions,
  type PerceptionSealedV2PolicyUpdateRequest
} from '@/api/security'
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue'
import { useAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'
import { FsusUiSettingsSection } from '@/fsusui'
import { promptText } from '@/fsusui/feedback'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const saving = shallowRef(false)
const consoleState = shallowRef<PerceptionSealedV2ConsoleResponse | null>(null)
const lastSavedOptions = shallowRef<PerceptionSealedV2PolicyOptions | null>(null)
type PerceptionSwitchOptionKey = 'enabled' | 'textTaskEnabled' | 'localizationEnabled' | 'microInteractionEnabled' | 'poSpaceFallbackEnabled'
const pendingOptionKey = shallowRef<PerceptionSwitchOptionKey | null>(null)
const taskFeedback = useAdminTaskFeedback()
const { ensureAdminSensitiveProof } = useAdminSensitiveProof()
const {
  isHighlighted: isTaskHighlighted
} = taskFeedback

const draft = reactive<PerceptionSealedV2PolicyOptions>({
  enabled: true,
  textTaskEnabled: true,
  localizationEnabled: true,
  microInteractionEnabled: false,
  poSpaceFallbackEnabled: false,
  earlyRejectThreshold: 90,
  maxAttempts: 3,
  minSolveDurationMs: 750,
  maxSolveDurationMs: 60000
})

const policy = computed(() => consoleState.value?.policy ?? null)
const isPolicyLoaded = computed(() => lastSavedOptions.value !== null)
const metricsState = computed(() => consoleState.value?.metrics ?? null)
const taskKindDistribution = computed(() => metricsState.value?.taskKindDistribution ?? [])
const recentAttempts = computed(() => metricsState.value?.recentAttempts ?? [])

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

const metrics = computed<AdminStatusMatrixItem[]>(() => [
  { label: '签发次数', value: metricsState.value?.issued ?? '-' },
  { label: '成功率', value: formatPercent(metricsState.value?.successRate) },
  { label: '失败率', value: formatPercent(metricsState.value?.failureRate) },
  { label: '载荷大小', value: `${metricsState.value?.averagePayloadBytes ?? 0} / p95 ${metricsState.value?.p95PayloadBytes ?? 0}` }
])

const cloneOptions = (options: PerceptionSealedV2PolicyOptions): PerceptionSealedV2PolicyOptions => ({
  enabled: options.enabled,
  textTaskEnabled: options.textTaskEnabled,
  localizationEnabled: options.localizationEnabled,
  microInteractionEnabled: options.microInteractionEnabled,
  poSpaceFallbackEnabled: options.poSpaceFallbackEnabled,
  earlyRejectThreshold: options.earlyRejectThreshold,
  maxAttempts: options.maxAttempts,
  minSolveDurationMs: options.minSolveDurationMs,
  maxSolveDurationMs: options.maxSolveDurationMs
})

const makeOptionsFingerprint = (options: PerceptionSealedV2PolicyOptions): string =>
  JSON.stringify(cloneOptions(options))

const hasDraftChanges = computed(() =>
  lastSavedOptions.value !== null && makeOptionsFingerprint(draft) !== makeOptionsFingerprint(lastSavedOptions.value)
)

const switchOptionLabels: Record<PerceptionSwitchOptionKey, string> = {
  enabled: '启用人机感知验证',
  textTaskEnabled: '文字识别题',
  localizationEnabled: '点选定位题',
  microInteractionEnabled: '微交互题',
  poSpaceFallbackEnabled: 'PoSpace 兜底'
}

const policySyncTone = computed(() => {
  if (saving.value) return 'saving'
  return hasDraftChanges.value ? 'dirty' : 'synced'
})

const policySyncLabel = computed(() => {
  if (saving.value) {
    return pendingOptionKey.value ? `${switchOptionLabels[pendingOptionKey.value]} 写入中` : '策略写入中'
  }

  return hasDraftChanges.value ? '有未保存数值' : '后端已同步'
})

const assignDraft = (options: PerceptionSealedV2PolicyOptions): void => {
  Object.assign(draft, options)
  lastSavedOptions.value = cloneOptions(options)
}

const loadConsole = async (): Promise<void> => {
  loading.value = true
  try {
    consoleState.value = await getPerceptionSealedV2Console()
    assignDraft(consoleState.value.policy.options)
  } catch (error) {
    showErrorToast(error, '人机感知验证加载失败')
  } finally {
    loading.value = false
  }
}

const validateDraft = (): void => {
  if (draft.maxSolveDurationMs <= draft.minSolveDurationMs) {
    throw new Error('最长答题耗时必须大于最短答题耗时')
  }
}

const resetDraftChanges = (): void => {
  if (!lastSavedOptions.value || saving.value) return
  Object.assign(draft, cloneOptions(lastSavedOptions.value))
}

const submitSwitchOption = async (key: PerceptionSwitchOptionKey, value: string | number | boolean): Promise<void> => {
  if (!lastSavedOptions.value || saving.value) {
    if (lastSavedOptions.value) Object.assign(draft, lastSavedOptions.value)
    return
  }

  const restoreOptions = cloneOptions(lastSavedOptions.value)
  const nextValue = value === true
  const label = switchOptionLabels[key]
  const stateLabel = nextValue ? '开启' : '关闭'
  const reason = `直接切换 ${label} 为${stateLabel}`
  const request: PerceptionSealedV2PolicyUpdateRequest = { reason }
  request[key] = nextValue

  pendingOptionKey.value = key
  saving.value = true
  taskFeedback.begin('正在写入人机感知验证后端策略', reason, 'security-perception-v2-options')

  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const snapshot = await updatePerceptionSealedV2Options(request, { mfaProofToken })
    assignDraft(snapshot.options)
    taskFeedback.succeed('人机感知验证策略已写入后端', `${label} 已${stateLabel}`, 'security-perception-v2-options')
    await loadConsole()
  } catch (error) {
    Object.assign(draft, restoreOptions)
    taskFeedback.fail(`${label} 写入后端失败`, error, `${label} 写入后端失败`, 'security-perception-v2-options')
  } finally {
    pendingOptionKey.value = null
    saving.value = false
  }
}

const saveOptions = async (): Promise<void> => {
  if (!hasDraftChanges.value) return
  saving.value = true
  try {
    validateDraft()
    const reason = await promptText('变更原因', '保存人机感知验证数值策略', {
      confirmButtonText: '保存数值策略',
      cancelButtonText: '取消',
      inputPlaceholder: '变更原因',
      inputValidator: (value: string) => value.trim().length > 0 || '请输入变更原因'
    })
    if (!reason) return
    taskFeedback.begin('正在写入人机感知验证后端策略', reason, 'security-perception-v2-options')
    const mfaProofToken = await ensureAdminSensitiveProof()
    const snapshot = await updatePerceptionSealedV2Options({ ...draft, reason }, { mfaProofToken })
    assignDraft(snapshot.options)
    taskFeedback.succeed('人机感知验证数值策略已写入后端', `最多尝试 ${snapshot.options.maxAttempts} 次`, 'security-perception-v2-options')
    await loadConsole()
  } catch (error) {
    taskFeedback.fail('人机感知验证数值策略保存失败', error, '人机感知验证数值策略保存失败', 'security-perception-v2-options')
  } finally {
    saving.value = false
  }
}

const rollbackOptions = async (): Promise<void> => {
  saving.value = true
  taskFeedback.begin('正在回滚人机感知验证策略', '需要管理员二次验证', 'security-perception-v2-options')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const snapshot = await rollbackPerceptionSealedV2Options({ mfaProofToken })
    assignDraft(snapshot.options)
    taskFeedback.succeed('人机感知验证策略已回滚并写入后端', `最多尝试 ${snapshot.options.maxAttempts} 次`, 'security-perception-v2-options')
    await loadConsole()
  } catch (error) {
    taskFeedback.fail('人机感知验证策略回滚失败', error, '人机感知验证策略回滚失败', 'security-perception-v2-options')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadConsole()
})
</script>

<style scoped>
.perception-v2-number-field {
  display: grid;
  align-content: start;
  gap: 0.5rem;
}

:deep(.perception-v2-number-field__input) {
  width: min(100%, 11rem);
}

.perception-v2-sync-state {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2rem;
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.perception-v2-sync-state__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: var(--fsusblog-text-muted);
}

.perception-v2-sync-state__dot--synced {
  background: var(--fsusblog-admin-status-success, #166534);
}

.perception-v2-sync-state__dot--dirty {
  background: var(--fsusblog-admin-status-warning, #92400e);
}

.perception-v2-sync-state__dot--saving {
  background: var(--fsusblog-color-primary, #2a599c);
}
</style>
