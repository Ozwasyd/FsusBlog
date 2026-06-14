<template>
  <div class="space-y-8">
    <AdminTaskFeedbackBar
      :phase="taskFeedbackPhase"
      :message="taskFeedbackMessage"
      :detail="taskFeedbackDetail"
      :aria-message="taskFeedbackAriaMessage"
      :assertive-message="taskFeedbackAssertiveMessage"
      :busy="taskFeedbackBusy"
    />

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核模型</div>
          <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">模型风险信号</h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">地区策略和硬词库优先级高于模型建议；模型输出不得作为最终审核决定。</p>
        </div>
        <el-button :icon="Refresh" :loading="loading" @click="loadStatus">刷新</el-button>
      </div>

      <div class="border-l-4 border-[var(--el-color-warning)] px-5 py-4 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
        <strong class="text-[var(--fsusblog-text-primary)]">地区法律策略优先级高于反垃圾模型。</strong>
        <span class="ml-2">模型风险信号不能覆盖拦截地区、提交动作、展示动作或人工审核状态。</span>
      </div>

      <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-4">
        <div v-for="item in statusRows" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ item.label }}</div>
          <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.value }}</div>
        </div>
      </div>
    </section>

    <section class="grid gap-8 lg:grid-cols-2">
      <section
        class="blog-motion-task-region border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
        :class="{
          'blog-motion-task-region--pending': saving || reloading || rollingBack,
          'blog-motion-task-region--settled': isTaskHighlighted('moderation-model-runtime')
        }"
      >
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">观测</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div class="flex items-center justify-between gap-3 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">最近成功</span>
            <span class="text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatTime(status?.lastSuccessAtUtc) }}</span>
          </div>
          <div class="flex items-center justify-between gap-3 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">最近错误</span>
            <span class="text-[12px] text-[var(--fsusblog-text-muted)]">{{ status?.lastErrorCode ?? '-' }} / {{ formatTime(status?.lastErrorAtUtc) }}</span>
          </div>
          <div class="flex items-center justify-between gap-3 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">平均延迟</span>
            <span class="text-[12px] tabular-nums text-[var(--fsusblog-text-muted)]">{{ status?.averageLatencyMs ?? 0 }} ms</span>
          </div>
          <div class="flex items-center justify-between gap-3 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">P95 延迟</span>
            <span class="text-[12px] tabular-nums text-[var(--fsusblog-text-muted)]">{{ status?.p95LatencyMs ?? 0 }} ms</span>
          </div>
        </div>
      </section>

      <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">受控动作</div>
        </div>
        <div class="space-y-4 p-5">
          <div class="grid gap-3 md:grid-cols-2">
            <label class="space-y-2">
              <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">模型来源</span>
              <el-select v-model="form.provider" placeholder="模型来源" aria-label="模型来源">
                <el-option label="关闭外部模型" value="none" />
                <el-option label="本地模拟" value="mock" />
                <el-option label="HTTP JSON" value="http-json" />
                <el-option label="Fsus CLI" value="fsus-cli" />
              </el-select>
            </label>
            <label class="space-y-2">
              <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">启用模型</span>
              <div class="flex h-8 items-center">
                <el-switch v-model="form.enabled" />
              </div>
            </label>
            <label class="space-y-2">
              <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">模型配置</span>
              <el-input v-model="form.modelProfile" placeholder="模型配置名" />
            </label>
            <label class="space-y-2">
              <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">阈值配置</span>
              <el-input v-model="form.thresholdProfile" placeholder="阈值配置名" />
            </label>
          </div>
          <div class="flex flex-wrap gap-2">
            <el-button type="primary" :icon="Connection" :loading="saving" @click="saveRuntime">保存运行配置</el-button>
            <el-button :icon="RefreshRight" type="warning" :loading="reloading" @click="reloadRuntime">重新载入</el-button>
            <el-button :icon="RefreshLeft" type="warning" :loading="rollingBack" @click="rollbackRuntime">回滚</el-button>
          </div>
          <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-2">
            <div v-for="item in runtimeRows" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-4">
              <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ item.label }}</div>
              <div class="mt-2 break-all text-[12px] font-bold text-[var(--fsusblog-text-primary)]">{{ item.value }}</div>
            </div>
          </div>
          <el-button :icon="Cpu" disabled>测试样本文本评分</el-button>
          <RouterLink :to="{ name: 'ManageAuditLog', query: { action: 'model_moderation_scored' } }" class="inline-flex">
            <el-button :icon="Warning">查看最近模型错误</el-button>
          </RouterLink>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import {
  getModerationModelStatus,
  getModerationRuntimeStatus,
  reloadModerationModel,
  rollbackModerationModel,
  setModerationModelRuntime,
  type ModerationModelStatusResponse,
  type ModerationRuntimeStatusResponse
} from '@/api/authoring'
import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import AdminTaskFeedbackBar from '@/components/admin/AdminTaskFeedbackBar.vue'
import { Connection, Cpu, Refresh, RefreshLeft, RefreshRight, Warning } from '@/fsusui/icons'
import { promptText, toast } from '@/fsusui/feedback'
import { showErrorToast } from '@/utils/errorPresentation'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'

const AdminSensitiveAction = 'admin-sensitive'

const loading = shallowRef(false)
const saving = shallowRef(false)
const reloading = shallowRef(false)
const rollingBack = shallowRef(false)
const status = shallowRef<ModerationModelStatusResponse | null>(null)
const runtime = shallowRef<ModerationRuntimeStatusResponse | null>(null)
const taskFeedback = useAdminTaskFeedback()
const {
  phase: taskFeedbackPhase,
  message: taskFeedbackMessage,
  detail: taskFeedbackDetail,
  assertiveMessage: taskFeedbackAssertiveMessage,
  busy: taskFeedbackBusy,
  ariaMessage: taskFeedbackAriaMessage,
  isHighlighted: isTaskHighlighted
} = taskFeedback

const form = reactive({
  enabled: false,
  provider: 'none',
  modelProfile: '',
  thresholdProfile: ''
})

const formatEnabled = (value: boolean | null | undefined): string => value ? '已启用' : '已关闭'

const formatProvider = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    none: '关闭外部模型',
    mock: '本地模拟',
    'http-json': '远程 HTTP',
    'fsus-cli': 'Fsus CLI'
  }
  return value ? labels[value] ?? '自定义来源' : '-'
}

const formatMode = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    local: '本地',
    remote: '远程',
    disabled: '已关闭',
    observe: '观察'
  }
  return value ? labels[value] ?? value : '-'
}

const formatReviewed = (value: boolean | null | undefined): string => value ? '已复核' : '未复核'

const statusRows = computed(() => [
  { label: '启用状态', value: formatEnabled(status.value?.enabled) },
  { label: '模型来源', value: formatProvider(status.value?.provider) },
  { label: '模型模式', value: formatMode(status.value?.mode) },
  { label: '契约版本', value: status.value?.contractVersion ?? '-' },
  { label: '超时', value: `${status.value?.timeoutMs ?? 0} ms` },
  { label: '失败时放行', value: status.value?.failOpen ? '是' : '否' },
  { label: '外部模型', value: status.value?.externalProviderAllowed ? '允许' : '已关闭' },
  { label: '外部复核', value: formatReviewed(status.value?.externalProviderReviewed) }
])

const runtimeRows = computed(() => [
  { label: '快照', value: runtime.value?.model.snapshotId ?? '-' },
  { label: '校验值', value: runtime.value?.model.configChecksum ?? '-' },
  { label: '载入人', value: runtime.value?.model.loadedBy ?? '-' },
  { label: '载入时间', value: formatTime(runtime.value?.model.loadedAtUtc) }
])

const applyRuntimeToForm = (): void => {
  const model = runtime.value?.model
  if (!model) {
    return
  }

  form.enabled = model.enabled
  form.provider = model.provider
  form.modelProfile = model.modelProfile
  form.thresholdProfile = model.thresholdProfile
}

const loadStatus = async (): Promise<void> => {
  loading.value = true
  try {
    const [modelStatus, runtimeStatus] = await Promise.all([
      getModerationModelStatus(),
      getModerationRuntimeStatus()
    ])
    status.value = modelStatus
    runtime.value = runtimeStatus
    applyRuntimeToForm()
  } catch (error) {
    showErrorToast(error, '审核模型状态加载失败')
  } finally {
    loading.value = false
  }
}

const ensureAdminSensitiveProof = async (): Promise<string> => {
  const challenge = await startMfaChallenge(AdminSensitiveAction)
  if (challenge.verified && challenge.proofToken) {
    return challenge.proofToken
  }

  const challengeToken = challenge.proofToken
  if (!challengeToken) {
    throw new Error('MFA_CHALLENGE_REQUIRED')
  }

  const code = await promptText('输入 MFA 验证码或恢复码', '模型 runtime 验证', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPlaceholder: '验证码或恢复码',
    inputValidator: (value: string) => value.trim().length > 0 || '请输入验证码或恢复码'
  })
  if (!code) {
    throw new Error('MFA_CHALLENGE_CANCELLED')
  }

  const proof = await verifyMfaChallenge({
    challengeToken,
    code,
    action: AdminSensitiveAction
  })
  if (!proof.verified || !proof.proofToken) {
    throw new Error('MFA_PROOF_REQUIRED')
  }

  return proof.proofToken
}

const saveRuntime = async (): Promise<void> => {
  saving.value = true
  taskFeedback.begin('正在保存模型运行配置', `${formatProvider(form.provider)} / ${form.modelProfile || '默认配置'}`, 'moderation-model-runtime')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    runtime.value = await setModerationModelRuntime({
      enabled: form.enabled,
      provider: form.provider,
      modelProfile: form.modelProfile.trim() || null,
      thresholdProfile: form.thresholdProfile.trim() || null,
      reason: 'model_runtime_update'
    }, { mfaProofToken })
    taskFeedback.succeed('模型运行配置已保存', runtime.value.model.snapshotId, 'moderation-model-runtime')
    toast.success('模型运行配置已保存')
    await loadStatus()
  } catch (error) {
    taskFeedback.fail('模型运行配置保存失败', error, '模型运行配置保存失败', 'moderation-model-runtime')
    showErrorToast(error, '模型运行配置保存失败')
  } finally {
    saving.value = false
  }
}

const reloadRuntime = async (): Promise<void> => {
  reloading.value = true
  taskFeedback.begin('正在重新载入模型配置', '重新载入模型配置快照', 'moderation-model-runtime')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    runtime.value = await reloadModerationModel({ mfaProofToken })
    taskFeedback.succeed('模型配置已重新载入', runtime.value.model.snapshotId, 'moderation-model-runtime')
    toast.success('模型配置已重新载入')
    await loadStatus()
  } catch (error) {
    taskFeedback.fail('模型配置重新载入失败', error, '模型配置重新载入失败', 'moderation-model-runtime')
    showErrorToast(error, '模型配置重新载入失败')
  } finally {
    reloading.value = false
  }
}

const rollbackRuntime = async (): Promise<void> => {
  rollingBack.value = true
  taskFeedback.begin('正在回滚模型配置', '恢复上一份模型配置', 'moderation-model-runtime')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    runtime.value = await rollbackModerationModel({ mfaProofToken })
    taskFeedback.succeed('模型配置已回滚', runtime.value.model.snapshotId, 'moderation-model-runtime')
    toast.success('模型配置已回滚')
    await loadStatus()
  } catch (error) {
    taskFeedback.fail('模型配置回滚失败', error, '模型配置回滚失败', 'moderation-model-runtime')
    showErrorToast(error, '模型配置回滚失败')
  } finally {
    rollingBack.value = false
  }
}

function formatTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '-'
}

onMounted(() => {
  void loadStatus()
})
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
