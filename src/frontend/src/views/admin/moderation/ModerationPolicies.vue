<template>
  <div class="space-y-8">
    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 class="text-xl font-bold text-[var(--fsusblog-text-primary)]">策略与词库组合结果</h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">地区策略结果独立于模型信号，决定提交动作、展示动作和拦截地区。</p>
        </div>
        <el-button :icon="Refresh" :loading="loading" @click="loadPolicies">刷新</el-button>
      </div>

      <div class="blog-scroll-x-safe moderation-policies-table-scroll">
        <el-table v-loading="loading" :data="policies" row-key="region">
          <el-table-column type="expand">
            <template #default="{ row }: { row: RegionPolicySummaryResponse }">
              <div class="grid gap-6 p-5 lg:grid-cols-2">
                <section>
                  <div class="mb-3 text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">词库</div>
                  <div class="flex flex-wrap gap-2">
                    <el-tag v-for="dictionaryId in row.dictionaryIds" :key="dictionaryId" type="info">{{ dictionaryId }}</el-tag>
                    <el-tag v-if="row.dictionaryIds.length === 0" type="danger">缺失</el-tag>
                  </div>
                </section>
                <section>
                  <div class="mb-3 text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">关键检查</div>
                  <div class="divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]">
                    <div v-for="check in row.criticalChecks" :key="check.code" class="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div>
                        <div class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ formatPolicyCheckLabel(check) }}</div>
                        <div class="mt-1 text-[11px] text-[var(--fsusblog-text-muted)]">{{ formatPolicyCheckDetail(check) }}</div>
                      </div>
                      <el-tag :type="checkType(check.status)">{{ formatCheckStatus(check.status) }}</el-tag>
                    </div>
                  </div>
                </section>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="地区" min-width="160" class-name="moderation-policy-table-cell">
            <template #default="{ row }: { row: RegionPolicySummaryResponse }">
              <div class="moderation-policy-region" :title="row.region">
                <span class="moderation-policy-region__name">{{ formatRegionName(row.region) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="继承来源" min-width="160" class-name="moderation-policy-table-cell">
            <template #default="{ row }: { row: RegionPolicySummaryResponse }">
              <div v-if="row.inherits.length" class="moderation-policy-inline-list">
                <span v-for="region in row.inherits" :key="region" class="moderation-policy-region" :title="region">
                  <span class="moderation-policy-region__name">{{ formatRegionName(region) }}</span>
                </span>
              </div>
              <span v-else class="moderation-policy-region moderation-policy-region--muted">无继承</span>
            </template>
          </el-table-column>
          <el-table-column label="策略版本" min-width="210" class-name="moderation-policy-table-cell">
            <template #default="{ row }: { row: RegionPolicySummaryResponse }">
              <div class="moderation-policy-region" :title="row.version">
                <span class="moderation-policy-region__name">{{ formatPolicyVersion(row.version) }}</span>
              </div>
            </template>
          </el-table-column>
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
          <template #empty>
            <AdminInlineEmptyState
              title="暂无地区策略"
              description="地区策略与词库组合结果载入后，会在这里显示运行状态和校验值。"
            />
          </template>
        </el-table>
      </div>
    </section>

    <section v-if="mainlandPolicy" class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
          {{ formatRegionName(mainlandPolicy.region) }}必要检查
        </div>
      </div>
      <div class="divide-y divide-[var(--fsusblog-panel-border)]">
        <div v-for="check in mainlandPolicy.criticalChecks" :key="check.code" class="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ formatPolicyCheckLabel(check) }}</div>
            <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatPolicyCheckDetail(check) }}</p>
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
  type RegionPolicyCheckResponse,
  type RegionPolicySummaryResponse
} from '@/api/authoring'
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import { Connection, Refresh } from '@/fsusui/icons'
import { promptText, toast } from '@/fsusui/feedback'
import { showErrorToast } from '@/utils/errorPresentation'
import { formatModerationRegionName, formatModerationRegionVersion } from '@/utils/moderationRegionDisplay'

const MainlandChangeConfirmPhrase = 'CONFIRM CN-MAINLAND MODERATION CHANGE'
const dictionaryDisplayNames: Record<string, string> = {
  'cn-mainland.political-sensitive': '政治敏感词库',
  'cn-mainland.porn-strict': '色情内容词库',
  'cn-mainland.public-order': '公共秩序词库',
  'cn-mainland.national-security': '国家安全词库'
}
const policyCheckLabels: Record<string, string> = {
  'inherits-global': '继承全局策略',
  'political-sensitive-submit': '政治敏感提交动作',
  'political-sensitive-display': '政治敏感展示动作',
  'pornographic-submit': '色情内容提交动作',
  'pornographic-display': '色情内容展示动作',
  'policy-version': '策略版本'
}
const policyCheckSuccessDetails: Record<string, string> = {
  'inherits-global': '中国大陆策略继承全局策略。',
  'political-sensitive-submit': '命中后拒绝提交。',
  'political-sensitive-display': '命中后按地区屏蔽展示。',
  'pornographic-submit': '命中后拒绝提交。',
  'pornographic-display': '命中后按地区屏蔽展示。'
}
const policyCheckFailureDetails: Record<string, string> = {
  'inherits-global': '中国大陆策略未继承全局策略。',
  'political-sensitive-submit': '提交动作未设置为拒绝。',
  'political-sensitive-display': '展示动作未设置为地区屏蔽。',
  'pornographic-submit': '提交动作未设置为拒绝。',
  'pornographic-display': '展示动作未设置为地区屏蔽。',
  'policy-version': '缺少策略版本。'
}

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

const formatRegionName = (region: string): string => formatModerationRegionName(region)
const formatPolicyVersion = (version: string): string => formatModerationRegionVersion(version)

const formatPolicyCheckLabel = (check: RegionPolicyCheckResponse): string => {
  if (check.code.startsWith('dictionary:')) {
    const dictionaryId = check.code.slice('dictionary:'.length)
    return dictionaryDisplayNames[dictionaryId] ?? '必要词库'
  }
  return policyCheckLabels[check.code] ?? check.label
}

const formatPolicyCheckDetail = (check: RegionPolicyCheckResponse): string => {
  if (check.code.startsWith('dictionary:')) {
    return check.status === 'ok' ? '词库已载入。' : '词库缺失。'
  }
  if (check.code === 'policy-version' && check.status === 'ok') {
    return `当前版本 ${formatPolicyVersion(check.detail)}。`
  }
  if (check.status === 'ok') {
    return policyCheckSuccessDetails[check.code] ?? check.detail
  }
  return policyCheckFailureDetails[check.code] ?? check.detail
}

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


const resolveRegionConfirmPhrase = async (region: string, state: string): Promise<string | null> => {
  if (region !== 'CN-MAINLAND' || state === 'enabled') {
    return null
  }

  return await promptText('输入确认短语以停用中国大陆策略', '中国大陆策略确认', {
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
    toast.success(`${formatRegionName(policy.region)}运行状态已更新`)
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

<style scoped>
.moderation-policies-table-scroll {
  max-width: 100%;
  overflow-x: auto;
}

.moderation-policy-region {
  display: flex;
  min-width: 0;
  align-items: center;
  min-height: 22px;
}

.moderation-policy-region__name {
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  color: var(--fsusblog-text-primary);
}

.moderation-policy-region--muted {
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  color: var(--fsusblog-text-muted);
}

.moderation-policy-inline-list {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  min-height: 22px;
}

:deep(.moderation-policy-table-cell .cell) {
  display: flex;
  align-items: center;
  min-height: 24px;
}
</style>
