<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="策略版本"
      :description="consoleState ? `风险控制策略：${consoleState.activePolicy.policyVersion}` : ''"
      id="security-policies-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadPolicies">刷新</el-button>
      </template>

      <AdminStatusMatrix :items="metrics" density="compact" aria-label="策略版本指标" />
    </FsusUiSettingsSection>

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">可配置策略</div>
      </div>
      <div class="divide-y divide-[var(--fsusblog-panel-border)]">
        <div
          v-for="entry in policySettingEntries"
          :key="entry.routeName"
          class="flex flex-wrap items-center justify-between gap-4 p-5"
        >
          <div class="min-w-0">
            <div class="text-base font-bold text-[var(--fsusblog-text-primary)]">{{ entry.title }}</div>
            <div class="mt-1 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">{{ entry.description }}</div>
          </div>
          <RouterLink :to="{ name: entry.routeName }" class="el-button el-button--primary is-plain">
            <span class="el-button__content">配置</span>
          </RouterLink>
        </div>
      </div>
    </section>

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略版本列表</div>
        <div v-if="hiddenPolicyVersionCount > 0" class="mt-2 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">
          每个策略只显示当前、可回滚和最近 {{ HISTORY_VERSIONS_PER_POLICY_LIMIT }} 个历史版本；已收起 {{ hiddenPolicyVersionCount }} 个更早版本。
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-full md:min-w-[58rem] text-left text-[12px]">
          <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
            <tr class="border-b border-[var(--fsusblog-panel-border)]">
              <th class="px-5 py-3">策略</th>
              <th class="px-5 py-3">版本</th>
              <th class="px-5 py-3">模式</th>
              <th class="px-5 py-3">状态</th>
              <th class="px-5 py-3">创建时间</th>
              <th class="px-5 py-3">原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="version in visiblePolicyVersions" :key="`${version.policyId}:${version.version}`" class="border-b border-[var(--fsusblog-panel-border)]">
              <td class="px-5 py-3 font-bold text-[var(--fsusblog-text-primary)]">{{ formatPolicyName(version.policyId) }}</td>
              <td class="px-5 py-3 tabular-nums">{{ version.version }}</td>
              <td class="px-5 py-3">{{ formatSecurityMode(version.mode) }}</td>
              <td class="px-5 py-3">
                <el-tag :type="formatPolicyVersionTagType(version)">
                  {{ formatPolicyVersionStatus(version) }}
                </el-tag>
              </td>
              <td class="px-5 py-3">{{ formatTime(version.createdAtUtc) }}</td>
              <td class="px-5 py-3">{{ formatPolicyReason(version.reason) }}</td>
            </tr>
            <tr v-if="visiblePolicyVersions.length === 0">
              <td colspan="6" class="px-5 py-10 text-center text-[var(--fsusblog-text-muted)]">暂无策略版本</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { getSecurityPolicyConsole, type SecurityPolicyConsoleResponse } from '@/api/security'
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const HISTORY_VERSIONS_PER_POLICY_LIMIT = 3
const loading = shallowRef(false)
const consoleState = shallowRef<SecurityPolicyConsoleResponse | null>(null)
const policySettingEntries = [
  {
    title: '风险控制',
    description: '决定哪些操作需要验证，以及风险分达到多少时直接拦截。',
    routeName: 'ManageSecurityRiskControl'
  },
  {
    title: '反爬虫',
    description: '控制公开访问、搜索爬虫校验、社交预览保护和爬虫风险计分。',
    routeName: 'ManageSecurityCrawler'
  },
  {
    title: '人机感知验证',
    description: '控制文字识别、点选定位和微交互题，拦截明显异常的提交。',
    routeName: 'ManageSecurityPerceptionV2'
  },
  {
    title: '工作量证明',
    description: '控制 Proof 难度、有效期、重放防护和是否读取统一风险分。',
    routeName: 'ManageSecurityPow'
  }
] as const
const policyVersions = computed(() => consoleState.value?.policyVersions ?? [])
const rollbackVersionByPolicy = computed(() => {
  const versions = new Map<string, number>()
  for (const version of policyVersions.value) {
    if (version.active || !version.lastKnownGood || !version.revokedAtUtc) continue
    const current = versions.get(version.policyId)
    if (current === undefined || version.version > current) {
      versions.set(version.policyId, version.version)
    }
  }
  return versions
})
const visiblePolicyVersions = computed(() => {
  const historicalCountByPolicy = new Map<string, number>()
  return policyVersions.value.filter((version) => {
    if (version.active || isRollbackVersion(version)) {
      return true
    }

    const current = historicalCountByPolicy.get(version.policyId) ?? 0
    if (current >= HISTORY_VERSIONS_PER_POLICY_LIMIT) {
      return false
    }

    historicalCountByPolicy.set(version.policyId, current + 1)
    return true
  })
})
const hiddenPolicyVersionCount = computed(() =>
  Math.max(0, policyVersions.value.length - visiblePolicyVersions.value.length)
)

type PolicyVersionSummary = SecurityPolicyConsoleResponse['policyVersions'][number]

const formatSecurityMode = (mode: string | null | undefined): string => {
  const labels: Record<string, string> = {
    disabled: '已关闭',
    observe: '观察',
    enforce: '执行',
    strict: '严格',
    lockdown: '锁定'
  }
  return mode ? labels[mode] ?? mode : '-'
}

const formatPolicyName = (policyId: string | null | undefined): string => {
  const labels: Record<string, string> = {
    'risk-control': '风险控制',
    RiskControl: '风险控制',
    antiCrawler: '反爬虫',
    'anti-crawler': '反爬虫',
    AntiCrawler: '反爬虫',
    pow: '工作量证明',
    PoW: '工作量证明',
    Pow: '工作量证明',
    perceptionSealedV2: '人机感知验证',
    'perception-sealed-v2': '人机感知验证',
    PerceptionSealedV2: '人机感知验证',
    pospace: '设备内存验证',
    poSpace: '设备内存验证',
    PoSpace: '设备内存验证'
  }
  return policyId ? labels[policyId] ?? policyId : '-'
}

const formatPolicyReason = (reason: string | null | undefined): string => {
  if (!reason) return '-'
  return reason
    .replaceAll('Perception V2', '人机感知验证')
    .replaceAll('PoSpace', '设备内存验证')
    .replaceAll('RiskControl', '风险控制')
}

const formatPolicyVersionStatus = (version: PolicyVersionSummary): string => {
  if (version.active) return '当前生效'
  if (isRollbackVersion(version)) return '可回滚'
  if (version.lastKnownGood) return '历史版本'
  return '已撤销'
}

const formatPolicyVersionTagType = (version: PolicyVersionSummary): 'success' | 'warning' | 'info' | 'danger' => {
  if (version.active) return 'success'
  if (isRollbackVersion(version)) return 'warning'
  if (version.lastKnownGood) return 'info'
  return 'danger'
}

const isRollbackVersion = (version: PolicyVersionSummary): boolean =>
  !version.active && version.lastKnownGood && rollbackVersionByPolicy.value.get(version.policyId) === version.version

const formatTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString() : '-'

const metrics = computed<AdminStatusMatrixItem[]>(() => [
  { label: '风险控制', value: formatSecurityMode(consoleState.value?.activePolicy.globalMode) },
  { label: '反爬虫', value: formatSecurityMode(consoleState.value?.antiCrawler.options.mode) },
  { label: '工作量证明', value: formatSecurityMode(consoleState.value?.pow.options.mode) },
  {
    label: '显示版本',
    value: hiddenPolicyVersionCount.value > 0
      ? `${visiblePolicyVersions.value.length} / ${policyVersions.value.length}`
      : policyVersions.value.length
  }
])

const loadPolicies = async (): Promise<void> => {
  loading.value = true
  try {
    consoleState.value = await getSecurityPolicyConsole()
  } catch (error) {
    showErrorToast(error, '策略版本加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadPolicies()
})
</script>
