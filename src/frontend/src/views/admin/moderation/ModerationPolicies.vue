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
import { computed, onMounted, shallowRef } from 'vue'
import {
  listModerationPolicies,
  type RegionPolicySummaryResponse
} from '@/api/authoring'
import { Refresh } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const policies = shallowRef<RegionPolicySummaryResponse[]>([])

const mainlandPolicy = computed(() => policies.value.find((item) => item.region === 'CN-MAINLAND') ?? null)

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
    policies.value = await listModerationPolicies()
  } catch (error) {
    showErrorToast(error, '地区策略加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadPolicies()
})
</script>
