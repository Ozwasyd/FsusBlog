<template>
  <div class="space-y-8">
    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">地区策略</div>
          <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">策略与词库组合结果</h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">地区策略结果独立于模型信号，决定提交动作、展示动作和拦截地区。</p>
        </div>
        <el-button :icon="Refresh" :loading="loading" @click="loadPolicies">刷新</el-button>
      </div>

      <el-table v-loading="loading" :data="policies" row-key="region">
        <el-table-column type="expand">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <div class="grid gap-6 p-5 lg:grid-cols-2">
              <section>
                <div class="mb-3 text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">词库</div>
                <div class="flex flex-wrap gap-2">
                  <el-tag v-for="dictionaryId in row.dictionaryIds" :key="dictionaryId" type="info">{{ dictionaryId }}</el-tag>
                  <el-tag v-if="row.dictionaryIds.length === 0" type="danger">缺失</el-tag>
                </div>
              </section>
              <section>
                <div class="mb-3 text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">关键检查</div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]">
                  <div v-for="check in row.criticalChecks" :key="check.code" class="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div>
                      <div class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ check.label }}</div>
                      <div class="mt-1 text-[11px] text-[var(--fsusblog-text-muted)]">{{ check.detail }}</div>
                    </div>
                    <el-tag :type="checkType(check.status)">{{ formatCheckStatus(check.status) }}</el-tag>
                  </div>
                </div>
              </section>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="地区" width="150" prop="region" />
        <el-table-column label="继承来源" min-width="160">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <span>{{ row.inherits.length ? row.inherits.join(', ') : '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="策略版本" min-width="190" prop="version" />
        <el-table-column label="词库数" width="130" align="right">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">{{ row.dictionaryIds.length }}</template>
        </el-table-column>
        <el-table-column label="规则数" width="90" align="right" prop="ruleCount" />
        <el-table-column label="状态" width="130">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <el-tag :type="policyStatusType(row)">{{ policyStatus(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="运行状态" width="190">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <el-select v-model="regionStateDrafts[row.region]" size="small" aria-label="地区运行状态">
              <el-option v-for="option in regionStateOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="right">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <el-button
              link
              type="primary"
              :icon="Connection"
              :loading="runtimeActionRegion === row.region"
              @click="saveRegionState(row)"
            >
              应用
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="校验值" min-width="180">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <code class="block truncate text-[11px]">{{ row.checksum }}</code>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="mainlandPolicy" class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">CN-MAINLAND 必要检查</div>
      </div>
      <div class="divide-y divide-[var(--fsusblog-panel-border)]">
        <div v-for="check in mainlandPolicy.criticalChecks" :key="check.code" class="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ check.label }}</div>
            <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ check.detail }}</p>
          </div>
          <el-tag :type="checkType(check.status)">{{ formatCheckStatus(check.status) }}</el-tag>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue'
import {
  getModerationRuntimeStatus,
  listModerationPolicies,
  setModerationRegionState,
  type ModerationRuntimeStatusResponse,
  type RegionPolicySummaryResponse
} from '@/api/authoring'
import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import { Connection, Refresh } from '@/fsusui/icons'
import { promptText, toast } from '@/fsusui/feedback'
import { showErrorToast } from '@/utils/errorPresentation'

const AdminSensitiveAction = 'admin-sensitive'
const MainlandChangeConfirmPhrase = 'CONFIRM CN-MAINLAND MODERATION CHANGE'

const loading = shallowRef(false)
const runtimeActionRegion = shallowRef<string | null>(null)
const policies = shallowRef<RegionPolicySummaryResponse[]>([])
const runtime = shallowRef<ModerationRuntimeStatusResponse | null>(null)
const regionStateDrafts = reactive<Record<string, string>>({})

const mainlandPolicy = computed(() => policies.value.find((item) => item.region === 'CN-MAINLAND') ?? null)
const regionStateOptions = [
  { label: '已启用', value: 'enabled' },
  { label: '仅人工审核', value: 'manual_review_only' },
  { label: '不公开展示', value: 'no_public_display' },
  { label: '只读', value: 'read_only' },
  { label: '已关闭', value: 'disabled' }
] as const

const formatCheckStatus = (status: string): string => {
  const labels: Record<string, string> = {
    ok: '通过',
    warning: '提醒',
    error: '异常'
  }
  return labels[status] ?? status
}

const checkType = (status: string): 'success' | 'warning' | 'danger' | 'info' => {
  if (status === 'ok') return 'success'
  if (status === 'warning') return 'warning'
  if (status === 'error') return 'danger'
  return 'info'
}

const policyStatus = (policy: RegionPolicySummaryResponse): string =>
  policy.criticalChecks.some((check) => check.status === 'error')
    ? '异常'
    : policy.criticalChecks.some((check) => check.status === 'warning')
      ? '提醒'
      : '已载入'

const policyStatusType = (policy: RegionPolicySummaryResponse): 'success' | 'warning' | 'danger' =>
  policyStatus(policy) === '已载入'
    ? 'success'
    : policyStatus(policy) === '提醒'
      ? 'warning'
      : 'danger'

const loadPolicies = async (): Promise<void> => {
  loading.value = true
  try {
    const [policyRows, runtimeStatus] = await Promise.all([
      listModerationPolicies(),
      getModerationRuntimeStatus()
    ])
    policies.value = policyRows
    runtime.value = runtimeStatus
    for (const policy of policyRows) {
      regionStateDrafts[policy.region] = runtimeStatus.regionStates[policy.region] ?? 'enabled'
    }
  } catch (error) {
    showErrorToast(error, '地区策略加载失败')
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

  const code = await promptText('输入 MFA 验证码或恢复码', '地区策略运行状态验证', {
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

const resolveRegionConfirmPhrase = async (region: string, state: string): Promise<string | null> => {
  if (region !== 'CN-MAINLAND' || state === 'enabled') {
    return null
  }

  return await promptText(`输入 ${MainlandChangeConfirmPhrase}`, 'CN-MAINLAND 策略确认', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPlaceholder: MainlandChangeConfirmPhrase,
    inputValidator: (value: string) => value.trim() === MainlandChangeConfirmPhrase || '确认短语不匹配'
  })
}

const saveRegionState = async (policy: RegionPolicySummaryResponse): Promise<void> => {
  runtimeActionRegion.value = policy.region
  try {
    const state = regionStateDrafts[policy.region] ?? 'enabled'
    const confirmPhrase = await resolveRegionConfirmPhrase(policy.region, state)
    if (policy.region === 'CN-MAINLAND' && state !== 'enabled' && confirmPhrase !== MainlandChangeConfirmPhrase) {
      return
    }

    const mfaProofToken = await ensureAdminSensitiveProof()
    runtime.value = await setModerationRegionState({
      region: policy.region,
      state,
      reason: 'region_runtime_state_update',
      confirmPhrase
    }, { mfaProofToken })
    regionStateDrafts[policy.region] = runtime.value.regionStates[policy.region] ?? 'enabled'
    toast.success(`${policy.region} 运行状态已更新`)
  } catch (error) {
    showErrorToast(error, '地区运行状态更新失败')
  } finally {
    runtimeActionRegion.value = null
  }
}

onMounted(() => {
  void loadPolicies()
})
</script>
