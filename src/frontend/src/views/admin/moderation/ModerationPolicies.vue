<template>
  <div class="space-y-8">
    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">地区策略 / REGION POLICIES</div>
          <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">policy -> dictionaries 组合结果</h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">地区策略结果独立于模型信号，决定 submit/display action 和 blocked_regions。</p>
        </div>
        <el-button :icon="Refresh" :loading="loading" @click="loadPolicies">刷新</el-button>
      </div>

      <el-table v-loading="loading" :data="policies" row-key="region">
        <el-table-column type="expand">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <div class="grid gap-6 p-5 lg:grid-cols-2">
              <section>
                <div class="mb-3 text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">Dictionaries</div>
                <div class="flex flex-wrap gap-2">
                  <el-tag v-for="dictionaryId in row.dictionaryIds" :key="dictionaryId" type="info">{{ dictionaryId }}</el-tag>
                  <el-tag v-if="row.dictionaryIds.length === 0" type="danger">missing</el-tag>
                </div>
              </section>
              <section>
                <div class="mb-3 text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">Critical Checks</div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]">
                  <div v-for="check in row.criticalChecks" :key="check.code" class="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div>
                      <div class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ check.label }}</div>
                      <div class="mt-1 text-[11px] text-[var(--fsusblog-text-muted)]">{{ check.detail }}</div>
                    </div>
                    <el-tag :type="checkType(check.status)">{{ check.status }}</el-tag>
                  </div>
                </div>
              </section>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="Region" width="150" prop="region" />
        <el-table-column label="Inherits" min-width="160">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <span>{{ row.inherits.length ? row.inherits.join(', ') : '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Policy Version" min-width="190" prop="version" />
        <el-table-column label="Dictionaries" width="130" align="right">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">{{ row.dictionaryIds.length }}</template>
        </el-table-column>
        <el-table-column label="Rules" width="90" align="right" prop="ruleCount" />
        <el-table-column label="Status" width="130">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <el-tag :type="policyStatusType(row)">{{ policyStatus(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Runtime" width="190">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <el-select v-model="regionStateDrafts[row.region]" size="small" aria-label="region runtime state">
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
        <el-table-column label="Checksum" min-width="180">
          <template #default="{ row }: { row: RegionPolicySummaryResponse }">
            <code class="block truncate text-[11px]">{{ row.checksum }}</code>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="mainlandPolicy" class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">CN-MAINLAND mandatory checks</div>
      </div>
      <div class="divide-y divide-[var(--fsusblog-panel-border)]">
        <div v-for="check in mainlandPolicy.criticalChecks" :key="check.code" class="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ check.label }}</div>
            <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ check.detail }}</p>
          </div>
          <el-tag :type="checkType(check.status)">{{ check.status }}</el-tag>
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
  { label: 'enabled', value: 'enabled' },
  { label: 'manual_review_only', value: 'manual_review_only' },
  { label: 'no_public_display', value: 'no_public_display' },
  { label: 'read_only', value: 'read_only' },
  { label: 'disabled', value: 'disabled' }
] as const

const checkType = (status: string): 'success' | 'warning' | 'danger' | 'info' => {
  if (status === 'ok') return 'success'
  if (status === 'warning') return 'warning'
  if (status === 'error') return 'danger'
  return 'info'
}

const policyStatus = (policy: RegionPolicySummaryResponse): string =>
  policy.criticalChecks.some((check) => check.status === 'error')
    ? 'invalid'
    : policy.criticalChecks.some((check) => check.status === 'warning')
      ? 'warning'
      : 'loaded'

const policyStatusType = (policy: RegionPolicySummaryResponse): 'success' | 'warning' | 'danger' =>
  policyStatus(policy) === 'loaded'
    ? 'success'
    : policyStatus(policy) === 'warning'
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

  const code = await promptText('输入 MFA 验证码或恢复码', '地区策略 runtime 验证', {
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
    toast.success(`${policy.region} runtime 已更新`)
  } catch (error) {
    showErrorToast(error, '地区 runtime 状态更新失败')
  } finally {
    runtimeActionRegion.value = null
  }
}

onMounted(() => {
  void loadPolicies()
})
</script>
