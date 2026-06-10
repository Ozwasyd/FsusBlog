<template>
  <div class="space-y-8">
    <WorkbenchPanel
      eyebrow="PROOF OF WORK"
      title="PoW 系统"
      :caption="overview ? `snapshot ${overview.policy.snapshotId}` : ''"
      title-id="security-pow-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadPow">刷新</el-button>
      </template>

      <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-4">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 break-words text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </WorkbenchPanel>

    <section class="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div>
            <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">运行策略</div>
            <div class="mt-2 text-lg font-bold text-[var(--fsusblog-text-primary)]">Pow mode</div>
          </div>
          <div class="flex gap-2">
            <el-button :loading="saving" @click="rollbackOptions">回滚</el-button>
            <el-button type="primary" :loading="saving" @click="saveOptions">保存</el-button>
          </div>
        </div>

        <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-2">
          <label class="bg-[var(--fsusblog-page-bg)] p-5">
            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">Mode</span>
            <el-select v-model="draft.mode" class="mt-2 w-full" aria-label="pow mode">
              <el-option v-for="mode in modes" :key="mode" :label="mode" :value="mode" />
            </el-select>
          </label>
          <label class="bg-[var(--fsusblog-page-bg)] p-5">
            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">Default difficulty</span>
            <el-input-number v-model="draft.defaultDifficulty" class="mt-2 w-full" :min="1" :max="12" controls-position="right" />
          </label>
          <label class="bg-[var(--fsusblog-page-bg)] p-5">
            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">Proof TTL / seconds</span>
            <el-input-number v-model="draft.proofTtlSeconds" class="mt-2 w-full" :min="30" :max="3600" controls-position="right" />
          </label>
          <div v-for="toggle in toggles" :key="toggle.key" class="flex items-center justify-between gap-4 bg-[var(--fsusblog-page-bg)] p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ toggle.label }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ toggle.caption }}</div>
            </div>
            <el-switch v-model="draft[toggle.key]" />
          </div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">边界</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="row in boundaryRows" :key="row.label" class="p-5">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.label }}</div>
            <p class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">{{ row.value }}</p>
          </div>
        </div>
      </div>
    </section>

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">运行状态</div>
      </div>
      <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-4">
        <div v-for="row in statusRows" :key="row.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ row.label }}</div>
          <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.value }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue'
import {
  getPowOverview,
  rollbackPowOptions,
  updatePowOptions,
  type PowOverviewResponse,
  type PowPolicyOptions,
  type SecurityMode
} from '@/api/security'
import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { Refresh } from '@/fsusui/icons'
import { promptText, toast } from '@/fsusui/feedback'
import { showErrorToast } from '@/utils/errorPresentation'

const AdminSensitiveAction = 'admin-sensitive'
const modes: SecurityMode[] = ['disabled', 'observe', 'enforce', 'strict']

const loading = shallowRef(false)
const saving = shallowRef(false)
const overview = shallowRef<PowOverviewResponse | null>(null)

const draft = reactive<PowPolicyOptions>({
  mode: 'enforce',
  defaultDifficulty: 4,
  adaptiveDifficultyEnabled: true,
  proofTtlSeconds: 300,
  replayProtectionEnabled: true,
  riskScoreLinkEnabled: true,
  challengeEndpoint: '/api/binary/auth/pow-challenge',
  verificationStrategy: 'RedisPowService'
})

const toggles = [
  { key: 'adaptiveDifficultyEnabled', label: 'Adaptive difficulty', caption: '根据全局压力调整 difficulty。' },
  { key: 'replayProtectionEnabled', label: 'Replay protection', caption: 'proof nonce 一次性消费。' },
  { key: 'riskScoreLinkEnabled', label: 'Risk score link', caption: '读取统一安全风险分。' }
] as const

const metrics = computed(() => [
  { label: 'Mode', value: overview.value?.policy.options.mode ?? '-' },
  { label: 'Difficulty', value: overview.value?.policy.options.defaultDifficulty ?? '-' },
  { label: 'Failures / 1h', value: overview.value?.validationFailuresLastHour ?? '-' },
  { label: 'Replay rejects / 1h', value: overview.value?.replayRejectsLastHour ?? '-' }
])

const statusRows = computed(() => [
  { label: 'Challenge endpoint', value: overview.value?.policy.options.challengeEndpoint ?? '-' },
  { label: 'Endpoint status', value: overview.value?.challengeEndpointStatus ?? '-' },
  { label: 'Verification strategy', value: overview.value?.policy.options.verificationStrategy ?? '-' },
  { label: 'Challenge required / 1h', value: overview.value?.challengeRequiredLastHour ?? '-' }
])

const boundaryRows = [
  { label: 'PoW owns challenge/proof', value: 'PoW 页面只管理 challenge、proof TTL、replay 和 difficulty。' },
  { label: 'AntiCrawler emits crawler risk', value: '反爬虫系统不会拥有 PoW；它只写入 crawler 类风险信号。' },
  { label: 'SecurityRisk is shared', value: '公开读取过滤器读取统一风险分，再引用 security.pow 作为 challenge 能力。' }
] as const

const assignDraft = (options: PowPolicyOptions): void => {
  Object.assign(draft, options)
}

const loadPow = async (): Promise<void> => {
  loading.value = true
  try {
    overview.value = await getPowOverview()
    assignDraft(overview.value.policy.options)
  } catch (error) {
    showErrorToast(error, 'PoW 系统加载失败')
  } finally {
    loading.value = false
  }
}

const ensureAdminSensitiveProof = async (): Promise<string> => {
  const challenge = await startMfaChallenge(AdminSensitiveAction)
  if (challenge.verified && challenge.proofToken) return challenge.proofToken
  const challengeToken = challenge.proofToken
  if (!challengeToken) throw new Error('MFA_CHALLENGE_REQUIRED')

  const code = await promptText('输入 MFA 验证码或恢复码', '安全系统验证', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPlaceholder: '验证码或恢复码',
    inputValidator: (value: string) => value.trim().length > 0 || '请输入验证码或恢复码'
  })
  if (!code) throw new Error('MFA_CHALLENGE_CANCELLED')

  const proof = await verifyMfaChallenge({ challengeToken, code, action: AdminSensitiveAction })
  if (!proof.verified || !proof.proofToken) throw new Error('MFA_PROOF_REQUIRED')
  return proof.proofToken
}

const saveOptions = async (): Promise<void> => {
  saving.value = true
  try {
    const reason = await promptText('变更原因', '保存 PoW 策略', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputPlaceholder: 'reason',
      inputValidator: (value: string) => value.trim().length > 0 || '请输入变更原因'
    })
    if (!reason) return
    const mfaProofToken = await ensureAdminSensitiveProof()
    const snapshot = await updatePowOptions({ ...draft, reason }, { mfaProofToken })
    assignDraft(snapshot.options)
    toast.success('PoW 策略已更新')
    await loadPow()
  } catch (error) {
    showErrorToast(error, 'PoW 策略保存失败')
  } finally {
    saving.value = false
  }
}

const rollbackOptions = async (): Promise<void> => {
  saving.value = true
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const snapshot = await rollbackPowOptions({ mfaProofToken })
    assignDraft(snapshot.options)
    toast.success('PoW 策略已回滚')
    await loadPow()
  } catch (error) {
    showErrorToast(error, 'PoW 策略回滚失败')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadPow()
})
</script>
