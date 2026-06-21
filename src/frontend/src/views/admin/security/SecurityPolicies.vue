<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="策略版本"
      :description="consoleState ? `RiskControl：${consoleState.activePolicy.policyVersion}` : ''"
      id="security-policies-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadPolicies">刷新</el-button>
      </template>

      <div class="grid gap-3 md:grid-cols-4">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 break-words text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </FsusUiSettingsSection>

    <section class="grid gap-8 lg:grid-cols-2">
      <RouterLink
        :to="{ name: 'ManageSecurityCrawler' }"
        class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] p-5 transition hover:bg-[var(--fsusblog-page-bg-soft)]"
      >
        <div class="text-lg font-bold text-[var(--fsusblog-text-primary)]">反爬虫策略写入</div>
        <div class="mt-2 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">options 与 rollback 已绑定 admin-sensitive proof。</div>
      </RouterLink>
      <RouterLink
        :to="{ name: 'ManageSecurityPow' }"
        class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] p-5 transition hover:bg-[var(--fsusblog-page-bg-soft)]"
      >
        <div class="text-lg font-bold text-[var(--fsusblog-text-primary)]">PoW 策略写入</div>
        <div class="mt-2 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">difficulty、TTL 与 replay 配置沿用同一 proof 边界。</div>
      </RouterLink>
    </section>

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">policyVersions</div>
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
            <tr v-for="version in policyVersions" :key="`${version.policyId}:${version.version}`" class="border-b border-[var(--fsusblog-panel-border)]">
              <td class="px-5 py-3 font-bold text-[var(--fsusblog-text-primary)]">{{ version.policyId }}</td>
              <td class="px-5 py-3 tabular-nums">{{ version.version }}</td>
              <td class="px-5 py-3">{{ formatSecurityMode(version.mode) }}</td>
              <td class="px-5 py-3">
                <el-tag :type="version.active ? 'success' : version.lastKnownGood ? 'info' : 'warning'">
                  {{ version.active ? 'active' : version.lastKnownGood ? 'last-known-good' : 'revoked' }}
                </el-tag>
              </td>
              <td class="px-5 py-3">{{ formatTime(version.createdAtUtc) }}</td>
              <td class="px-5 py-3">{{ version.reason ?? '-' }}</td>
            </tr>
            <tr v-if="policyVersions.length === 0">
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
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const consoleState = shallowRef<SecurityPolicyConsoleResponse | null>(null)
const policyVersions = computed(() => consoleState.value?.policyVersions ?? [])

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

const formatTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString() : '-'

const metrics = computed(() => [
  { label: 'RiskControl', value: formatSecurityMode(consoleState.value?.activePolicy.globalMode) },
  { label: '反爬虫', value: formatSecurityMode(consoleState.value?.antiCrawler.options.mode) },
  { label: 'PoW', value: formatSecurityMode(consoleState.value?.pow.options.mode) },
  { label: '版本数', value: policyVersions.value.length }
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
