<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="审核运行状态"
      :description="overview ? `模型状态：${modelStateLabel}` : ''"
      id="moderation-overview-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadDashboard">刷新</el-button>
      </template>

      <div class="grid gap-3 md:grid-cols-5">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </FsusUiSettingsSection>

    <section
      class="blog-motion-task-region border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
      :class="{
        'blog-motion-task-region--pending': savingGlobalState,
        'blog-motion-task-region--settled': isTaskHighlighted('moderation-global-runtime')
      }"
    >
      <div class="grid gap-3 md:grid-cols-5">
        <div v-for="item in runtimeRows" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ item.label }}</div>
          <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.value }}</div>
        </div>
      </div>
      <div class="flex flex-col gap-3 border-t border-[var(--fsusblog-panel-border)] p-5 md:flex-row md:items-end">
        <label class="w-full space-y-2 md:max-w-xs">
          <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">全局运行状态</span>
          <el-select v-model="globalStateDraft" aria-label="全局审核运行状态">
            <el-option v-for="option in globalStateOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </label>
        <el-button type="primary" :icon="Connection" :loading="savingGlobalState" @click="saveGlobalState">应用全局状态</el-button>
      </div>
    </section>

    <section class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.7fr)]">
      <div class="space-y-8">
        <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
          <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
            <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">关键检查</div>
          </div>
          <div class="divide-y divide-[var(--fsusblog-panel-border)]">
            <div class="flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">中国大陆严格策略</div>
                <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">大陆 IP 政治敏感与色情内容屏蔽依赖该策略。</p>
              </div>
              <el-tag :type="mainlandStatusType">{{ formatRuntimeStatus(overview?.mainlandStrictStatus) }}</el-tag>
            </div>
            <div v-if="overview?.mainlandStrictStatus !== 'enabled'" class="border-l-4 border-[var(--fsusblog-color-warning)] p-5 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
              中国大陆严格策略未启用：大陆 IP 政治敏感与色情内容屏蔽可能失效。
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">词库快照</div>
                <p class="mt-1 break-all text-[12px] text-[var(--fsusblog-text-muted)]">{{ overview?.dictionaryLastError ?? '词库已载入' }}</p>
              </div>
              <el-tag :type="overview?.dictionaryLastError ? 'danger' : 'success'">{{ overview?.dictionaryLastError ? '异常' : '已载入' }}</el-tag>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">审核模型</div>
                <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ overview?.modelContractVersion ?? '-' }} / {{ overview?.modelTimeoutMs ?? '-' }}ms</p>
              </div>
              <el-tag :type="overview?.modelEnabled ? 'success' : 'info'">{{ overview?.modelEnabled ? '已启用' : '已关闭' }}</el-tag>
            </div>
          </div>
        </section>
      </div>

      <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">入口</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <RouterLink v-for="link in internalLinks" :key="link.name" :to="{ name: link.name }" class="block p-5 hover:bg-[var(--fsusblog-page-bg-soft)]">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ link.label }}</div>
            <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ link.helper }}</p>
          </RouterLink>
          <a href="https://github.com/Ozwasyd/FsusBlog/issues/76" target="_blank" rel="noreferrer" class="block p-5 hover:bg-[var(--fsusblog-page-bg-soft)]">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">#76 第三方模型契约</div>
            <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">第三方模型契约与隔离边界。</p>
          </a>
          <a href="https://github.com/Ozwasyd/FsusBlog/issues/77" target="_blank" rel="noreferrer" class="block p-5 hover:bg-[var(--fsusblog-page-bg-soft)]">
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">#77 运行时控制</div>
            <p class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">模型与词库运行时开关、热替换和区域禁用。</p>
          </a>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import {
  getModerationOverview,
  getModerationRuntimeStatus,
  setModerationGlobalState,
  type ModerationOverviewResponse,
  type ModerationRuntimeStatusResponse
} from '@/api/authoring'
import { useAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'
import { FsusUiSettingsSection } from '@/fsusui'
import { Connection, Refresh } from '@/fsusui/icons'
import { toast } from '@/fsusui/feedback'
import { showErrorToast } from '@/utils/errorPresentation'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'


const loading = shallowRef(false)
const savingGlobalState = shallowRef(false)
const overview = shallowRef<ModerationOverviewResponse | null>(null)
const runtime = shallowRef<ModerationRuntimeStatusResponse | null>(null)
const globalStateDraft = shallowRef('enabled')
const taskFeedback = useAdminTaskFeedback()
const {
  isHighlighted: isTaskHighlighted
} = taskFeedback

const formatRuntimeStatus = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    enabled: '已启用',
    disabled: '已关闭',
    loaded: '已载入',
    error: '异常',
    invalid: '异常',
    read_only: '只读',
    disabled_to_pending: '转入待审',
    emergency_lockdown: '紧急锁定'
  }
  return value ? labels[value] ?? value : '-'
}

const globalStateOptions = [
  { label: '已启用', value: 'enabled' },
  { label: '只读', value: 'read_only' },
  { label: '转入待审', value: 'disabled_to_pending' },
  { label: '紧急锁定', value: 'emergency_lockdown' }
] as const

const internalLinks = [
  { label: '评论审核', helper: '审核队列、模型风险信号和地区策略结果。', name: 'ManageModerationComments' },
  { label: '词库管理', helper: '只展示元数据、校验值和证据策略。', name: 'ManageModerationDictionaries' },
  { label: '地区策略', helper: '查看地区策略与词库组合结果。', name: 'ManageModerationPolicies' },
  { label: '地区管理', helper: '地区定义、模板绑定和生效策略预览。', name: 'ManageModerationRegions' },
  { label: '大区管理', helper: '地区大区成员和统一策略模板。', name: 'ManageModerationRegionGroups' },
  { label: '策略模板', helper: '默认模板、复核标记和校验值。', name: 'ManageModerationPolicyTemplates' },
  { label: '策略回放', helper: '先预览差异，再进入受控执行流程。', name: 'ManageModerationReplay' },
  { label: '审核模型', helper: '模型只提供风险信号，不覆盖地区策略。', name: 'ManageModerationModel' },
  { label: '审核审计', helper: '跳转通用审计日志并预置审核动作。', name: 'ManageModerationAudit' }
] as const

const metrics = computed(() => [
  { label: '待审', value: overview.value?.pendingCount ?? '-' },
  { label: '已拒绝', value: overview.value?.rejectedCount ?? '-' },
  { label: '已隐藏', value: overview.value?.hiddenCount ?? '-' },
  { label: '词库', value: overview.value?.dictionaryCount ?? '-' },
  { label: '地区策略', value: overview.value?.regionPolicyCount ?? '-' }
])

const runtimeRows = computed(() => [
  { label: '全局状态', value: formatRuntimeStatus(runtime.value?.globalState) },
  { label: '地区覆盖', value: Object.keys(runtime.value?.regionStates ?? {}).length },
  { label: '已关闭词库', value: runtime.value?.disabledDictionaryIds.length ?? '-' },
  { label: '模型快照', value: runtime.value?.model.snapshotId ?? '-' },
  { label: '最近修改人', value: runtime.value?.changedBy ?? '-' }
])

const modelStateLabel = computed(() => {
  if (!overview.value?.modelEnabled) {
    return '已关闭'
  }

  const provider = (overview.value.modelProvider ?? '').trim().toLowerCase()
  return provider === '' || provider === 'none' || provider === 'mock' ? '本地' : '远程'
})

const mainlandStatusType = computed(() => {
  if (overview.value?.mainlandStrictStatus === 'enabled') return 'success'
  if (overview.value?.mainlandStrictStatus === 'invalid') return 'danger'
  return 'warning'
})

const loadDashboard = async (): Promise<void> => {
  loading.value = true
  try {
    const [overviewResponse, runtimeResponse] = await Promise.all([
      getModerationOverview(),
      getModerationRuntimeStatus()
    ])
    overview.value = overviewResponse
    runtime.value = runtimeResponse
    globalStateDraft.value = runtimeResponse.globalState
  } catch (error) {
    showErrorToast(error, '审核系统总览加载失败')
  } finally {
    loading.value = false
  }
}

const { ensureAdminSensitiveProof } = useAdminSensitiveProof()

const saveGlobalState = async (): Promise<void> => {
  savingGlobalState.value = true
  taskFeedback.begin('正在更新全局审核状态', formatRuntimeStatus(globalStateDraft.value), 'moderation-global-runtime')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    runtime.value = await setModerationGlobalState({
      state: globalStateDraft.value,
      reason: 'global_runtime_state_update'
    }, { mfaProofToken })
    globalStateDraft.value = runtime.value.globalState
    taskFeedback.succeed('全局审核状态已更新', formatRuntimeStatus(runtime.value.globalState), 'moderation-global-runtime')
    toast.success('全局审核状态已更新')
    await loadDashboard()
  } catch (error) {
    taskFeedback.fail('全局审核状态更新失败', error, '全局审核状态更新失败', 'moderation-global-runtime')
    showErrorToast(error, '全局审核状态更新失败')
  } finally {
    savingGlobalState.value = false
  }
}

onMounted(() => {
  void loadDashboard()
})
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
