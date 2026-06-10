<template>
  <div class="space-y-8">
    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核模型 / MODEL SIGNALS</div>
          <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">模型风险信号</h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">地区策略和硬词库优先级高于模型建议；模型输出不得作为最终审核决定。</p>
        </div>
        <el-button :icon="Refresh" :loading="loading" @click="loadStatus">刷新</el-button>
      </div>

      <div class="border-l-4 border-[var(--el-color-warning)] px-5 py-4 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
        <strong class="text-[var(--fsusblog-text-primary)]">地区法律策略优先级高于反垃圾模型。</strong>
        <span class="ml-2">模型风险信号不能覆盖 blocked_regions、submit_action、display_action 或人工审核状态。</span>
      </div>

      <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-4">
        <div v-for="item in statusRows" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ item.label }}</div>
          <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.value }}</div>
        </div>
      </div>
    </section>

    <section class="grid gap-8 lg:grid-cols-2">
      <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">观测</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div class="flex items-center justify-between gap-3 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">Last Success</span>
            <span class="text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatTime(status?.lastSuccessAtUtc) }}</span>
          </div>
          <div class="flex items-center justify-between gap-3 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">Last Error</span>
            <span class="text-[12px] text-[var(--fsusblog-text-muted)]">{{ status?.lastErrorCode ?? '-' }} / {{ formatTime(status?.lastErrorAtUtc) }}</span>
          </div>
          <div class="flex items-center justify-between gap-3 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">Average Latency</span>
            <span class="text-[12px] tabular-nums text-[var(--fsusblog-text-muted)]">{{ status?.averageLatencyMs ?? 0 }} ms</span>
          </div>
          <div class="flex items-center justify-between gap-3 p-5">
            <span class="text-sm font-bold text-[var(--fsusblog-text-primary)]">P95 Latency</span>
            <span class="text-[12px] tabular-nums text-[var(--fsusblog-text-muted)]">{{ status?.p95LatencyMs ?? 0 }} ms</span>
          </div>
        </div>
      </section>

      <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">受控动作</div>
        </div>
        <div class="space-y-4 p-5">
          <el-button :icon="Connection" disabled>测试连接</el-button>
          <el-button :icon="Cpu" disabled>测试样本文本评分</el-button>
          <RouterLink :to="{ name: 'ManageAuditLog', query: { action: 'model_moderation_scored' } }" class="inline-flex">
            <el-button :icon="Warning">查看最近模型错误</el-button>
          </RouterLink>
          <p class="text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">
            测试连接和样本文本评分属于运行时模型控制面；执行前需要 #77 的全局/地区开关、MFA 与审计保护。
          </p>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import {
  getModerationModelStatus,
  type ModerationModelStatusResponse
} from '@/api/authoring'
import { Connection, Cpu, Refresh, Warning } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const status = shallowRef<ModerationModelStatusResponse | null>(null)

const statusRows = computed(() => [
  { label: 'Enabled', value: status.value?.enabled ? 'enabled' : 'disabled' },
  { label: 'Provider', value: status.value?.provider ?? '-' },
  { label: 'Mode', value: status.value?.mode ?? '-' },
  { label: 'Contract Version', value: status.value?.contractVersion ?? '-' },
  { label: 'Timeout', value: `${status.value?.timeoutMs ?? 0} ms` },
  { label: 'Fail Open', value: status.value?.failOpen ? 'true' : 'false' },
  { label: 'External Provider', value: status.value?.externalProviderAllowed ? 'allowed' : 'disabled' },
  { label: 'External Review', value: status.value?.externalProviderReviewed ? 'reviewed' : 'not reviewed' }
])

const loadStatus = async (): Promise<void> => {
  loading.value = true
  try {
    status.value = await getModerationModelStatus()
  } catch (error) {
    showErrorToast(error, '审核模型状态加载失败')
  } finally {
    loading.value = false
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
