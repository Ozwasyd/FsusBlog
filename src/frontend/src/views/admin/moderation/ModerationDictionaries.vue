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

    <section
      class="blog-motion-task-region border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
      :class="{
        'blog-motion-task-region--pending': reloading || rollingBack,
        'blog-motion-task-region--settled': isTaskHighlighted('moderation-dictionaries-runtime')
      }"
    >
      <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">词库管理</div>
          <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">运行时词库元数据</h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">高风险词库只展示元数据、校验值、词条数量和证据策略。</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <el-tag v-if="snapshot?.lastError" type="danger">载入异常</el-tag>
          <el-tag v-else type="success">已载入</el-tag>
          <el-button :icon="Refresh" :loading="loading" @click="loadSnapshot">刷新</el-button>
          <el-button :icon="RefreshRight" type="warning" :loading="reloading" @click="reloadSnapshot">重新载入</el-button>
          <el-button :icon="RefreshLeft" type="warning" :loading="rollingBack" @click="rollbackSnapshot">回滚</el-button>
        </div>
      </div>

      <div class="grid gap-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-4 md:grid-cols-6">
        <el-select v-model="filters.scope" clearable placeholder="作用范围" aria-label="作用范围">
          <el-option label="全局" value="global" />
          <el-option label="地区" value="regional" />
        </el-select>
        <el-input v-model="filters.dictionaryId" clearable placeholder="词库 ID" aria-label="词库 ID" />
        <el-select v-model="filters.region" clearable placeholder="地区" aria-label="地区">
          <el-option v-for="region in regionOptions" :key="region" :label="region" :value="region" />
        </el-select>
        <el-select v-model="filters.category" clearable placeholder="分类" aria-label="分类">
          <el-option v-for="category in categoryOptions" :key="category" :label="category" :value="category" />
        </el-select>
        <el-input v-model="filters.status" clearable placeholder="状态" aria-label="状态" />
        <div class="flex items-center gap-2">
          <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">高风险</span>
          <el-switch v-model="filters.highRiskOnly" />
        </div>
      </div>

      <el-table v-loading="loading" :data="filteredDictionaries" row-key="dictionaryId" :row-class-name="rowClassName">
        <el-table-column label="词库 ID" min-width="230">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <div class="font-semibold text-[var(--fsusblog-text-primary)]">{{ row.dictionaryId }}</div>
            <div class="mt-1 text-[11px] text-[var(--fsusblog-text-muted)]">{{ row.source }} / {{ row.reviewedBy }}</div>
          </template>
        </el-table-column>
        <el-table-column label="作用范围" width="110" prop="scope" />
        <el-table-column label="地区" width="130">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">{{ row.region ?? 'GLOBAL' }}</template>
        </el-table-column>
        <el-table-column label="分类" min-width="170" prop="category" />
        <el-table-column label="版本" width="140" prop="version" />
        <el-table-column label="证据策略" width="150">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <el-tag :type="evidenceType(row.evidencePolicy)">{{ row.evidencePolicy }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="词条数" width="90" align="right" prop="termCount" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <el-tag :type="dictionaryStatusType(row)">{{ dictionaryStatus(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="校验值" min-width="180">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <code class="block truncate text-[11px]">{{ row.checksum }}</code>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">{{ formatTime(row.updatedAtUtc) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" align="right" fixed="right">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <el-button link type="primary" :icon="View" @click="openDetail(row)">详情</el-button>
            <el-button
              v-if="isDictionaryDisabled(row)"
              link
              type="success"
              :icon="Check"
              :loading="runtimeActionId === row.dictionaryId"
              @click="setDictionaryEnabled(row, true)"
            >
              启用
            </el-button>
            <el-button
              v-else
              link
              type="danger"
              :icon="Close"
              :loading="runtimeActionId === row.dictionaryId"
              @click="setDictionaryEnabled(row, false)"
            >
              禁用
            </el-button>
            <el-button link :icon="CopyDocument" @click="copyChecksum(row)">复制校验值</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <AdminInlineEmptyState :title="dictionaryEmptyTitle" :description="dictionaryEmptyDescription">
            <template #actions>
              <el-button v-if="hasDictionaryFilters" link type="primary" @click="resetDictionaryFilters">清除筛选</el-button>
              <el-button v-else link type="primary" :loading="loading" @click="loadSnapshot">刷新词库</el-button>
            </template>
          </AdminInlineEmptyState>
        </template>
      </el-table>
    </section>

    <el-drawer v-model="detailVisible" title="词库元数据" size="min(92vw, 32rem)">
      <div v-if="detail" class="space-y-5">
        <div class="border-l-4 border-[var(--el-color-warning)] px-4 py-3 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
          原始词条默认不可见；证据策略为 redact 时不会在管理台、toast 或日志中展示敏感词明文。
        </div>
        <dl class="grid grid-cols-1 gap-3">
          <div v-for="item in detailRows" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-4">
            <dt class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ item.label }}</dt>
            <dd class="mt-2 break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.value }}</dd>
          </div>
        </dl>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue'
import {
  disableModerationDictionary,
  enableModerationDictionary,
  getModerationDictionarySnapshot,
  getModerationRuntimeStatus,
  reloadModerationDictionaries,
  rollbackModerationDictionaries,
  type ModerationDictionaryRuntimeItem,
  type ModerationDictionaryRuntimeSnapshot,
  type ModerationRuntimeStatusResponse
} from '@/api/authoring'
import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import AdminTaskFeedbackBar from '@/components/admin/AdminTaskFeedbackBar.vue'
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import { Check, Close, CopyDocument, Refresh, RefreshLeft, RefreshRight, View } from '@/fsusui/icons'
import { promptText, toast } from '@/fsusui/feedback'
import { showErrorToast } from '@/utils/errorPresentation'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'

const AdminSensitiveAction = 'admin-sensitive'
const MainlandChangeConfirmPhrase = 'CONFIRM CN-MAINLAND MODERATION CHANGE'

const loading = shallowRef(false)
const reloading = shallowRef(false)
const rollingBack = shallowRef(false)
const runtimeActionId = shallowRef<string | null>(null)
const snapshot = shallowRef<ModerationDictionaryRuntimeSnapshot | null>(null)
const runtime = shallowRef<ModerationRuntimeStatusResponse | null>(null)
const detail = shallowRef<ModerationDictionaryRuntimeItem | null>(null)
const detailVisible = shallowRef(false)
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

const filters = reactive({
  scope: '',
  dictionaryId: '',
  region: '',
  category: '',
  status: '',
  highRiskOnly: false
})

const dictionaries = computed(() => snapshot.value?.dictionaries ?? [])
const disabledDictionaryIds = computed(() => new Set(runtime.value?.disabledDictionaryIds ?? []))
const regionOptions = computed(() => [...new Set(dictionaries.value.map((item) => item.region ?? 'GLOBAL'))].sort())
const categoryOptions = computed(() => [...new Set(dictionaries.value.map((item) => item.category))].sort())
const hasDictionaryFilters = computed(() =>
  filters.scope !== ''
  || filters.dictionaryId.trim() !== ''
  || filters.region !== ''
  || filters.category !== ''
  || filters.status.trim() !== ''
  || filters.highRiskOnly
)
const dictionaryEmptyTitle = computed(() => hasDictionaryFilters.value ? '没有匹配的词库' : '暂无运行时词库')
const dictionaryEmptyDescription = computed(() =>
  hasDictionaryFilters.value
    ? '调整作用范围、地区、分类、状态或高风险筛选后再查看。'
    : '运行时词库元数据载入后，会在这里显示校验值、词条数量和证据策略。'
)

const highRiskCategories = new Set([
  'political_sensitive',
  'pornographic',
  'sexual_explicit',
  'national_security_risk',
  'public_order_risk',
  'terrorism_extremism',
  'violence_extreme'
])

const isHighRisk = (item: ModerationDictionaryRuntimeItem): boolean =>
  item.evidencePolicy === 'redact'
  || item.region === 'CN-MAINLAND'
  || highRiskCategories.has(item.category)

const isDictionaryDisabled = (item: ModerationDictionaryRuntimeItem): boolean =>
  disabledDictionaryIds.value.has(item.dictionaryId)

const dictionaryStatus = (item: ModerationDictionaryRuntimeItem): string =>
  isDictionaryDisabled(item)
    ? '已关闭'
    : item.termCount > 0 && item.checksum.length > 0 ? '已载入' : '异常'

const dictionaryStatusType = (item: ModerationDictionaryRuntimeItem): 'success' | 'danger' | 'info' =>
  isDictionaryDisabled(item)
    ? 'info'
    : item.termCount > 0 && item.checksum.length > 0
      ? 'success'
      : 'danger'

const evidenceType = (policy: string): 'success' | 'warning' | 'danger' | 'info' => {
  if (policy === 'redact') return 'danger'
  if (policy === 'show_category_only') return 'warning'
  if (policy === 'show_full') return 'success'
  return 'info'
}

const filteredDictionaries = computed(() => dictionaries.value.filter((item) => {
  if (filters.scope && item.scope !== filters.scope) return false
  if (filters.dictionaryId && !item.dictionaryId.includes(filters.dictionaryId.trim())) return false
  if (filters.region && (item.region ?? 'GLOBAL') !== filters.region) return false
  if (filters.category && item.category !== filters.category) return false
  if (filters.status && dictionaryStatus(item) !== filters.status.trim()) return false
  if (filters.highRiskOnly && !isHighRisk(item)) return false
  return true
}))

const resetDictionaryFilters = (): void => {
  filters.scope = ''
  filters.dictionaryId = ''
  filters.region = ''
  filters.category = ''
  filters.status = ''
  filters.highRiskOnly = false
}

const detailRows = computed(() => {
  if (!detail.value) return []
  const item = detail.value
  return [
    { label: '词库 ID', value: item.dictionaryId },
    { label: '作用范围', value: item.scope },
    { label: '地区', value: item.region ?? 'GLOBAL' },
    { label: '分类', value: item.category },
    { label: '版本', value: item.version },
    { label: '校验值', value: item.checksum },
    { label: '词条数', value: String(item.termCount) },
    { label: '来源', value: item.source },
    { label: '复核人', value: item.reviewedBy },
    { label: '更新时间', value: formatTime(item.updatedAtUtc) },
    { label: '证据策略', value: item.evidencePolicy },
    { label: '原始词条', value: '已隐藏' }
  ]
})

const loadSnapshot = async (): Promise<void> => {
  loading.value = true
  try {
    const [dictionarySnapshot, runtimeStatus] = await Promise.all([
      getModerationDictionarySnapshot(),
      getModerationRuntimeStatus()
    ])
    snapshot.value = dictionarySnapshot
    runtime.value = runtimeStatus
  } catch (error) {
    showErrorToast(error, '词库元数据加载失败')
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

  const code = await promptText('输入 MFA 验证码或恢复码', '词库重新载入验证', {
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

const reloadSnapshot = async (): Promise<void> => {
  reloading.value = true
  taskFeedback.begin('正在重新载入词库', '重新加载词库元数据与校验值', 'moderation-dictionaries-runtime')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const result = await reloadModerationDictionaries({ mfaProofToken })
    taskFeedback.succeed('词库已重新载入', result.snapshotId, 'moderation-dictionaries-runtime')
    toast.success(`词库已重载 ${result.snapshotId}`)
    await loadSnapshot()
  } catch (error) {
    taskFeedback.fail('词库重新载入失败', error, '词库重新载入失败', 'moderation-dictionaries-runtime')
    showErrorToast(error, '词库重新载入失败')
  } finally {
    reloading.value = false
  }
}

const rollbackSnapshot = async (): Promise<void> => {
  rollingBack.value = true
  taskFeedback.begin('正在回滚词库', '恢复上一份可用快照', 'moderation-dictionaries-runtime')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const result = await rollbackModerationDictionaries({ mfaProofToken })
    snapshot.value = result
    runtime.value = await getModerationRuntimeStatus()
    taskFeedback.succeed('词库已回滚', result.snapshotId, 'moderation-dictionaries-runtime')
    toast.success(`词库已回滚 ${result.snapshotId}`)
  } catch (error) {
    taskFeedback.fail('词库回滚失败', error, '词库回滚失败', 'moderation-dictionaries-runtime')
    showErrorToast(error, '词库回滚失败')
  } finally {
    rollingBack.value = false
  }
}

const resolveDictionaryConfirmPhrase = async (item: ModerationDictionaryRuntimeItem, enabled: boolean): Promise<string | null> => {
  if (enabled || !item.dictionaryId.startsWith('cn-mainland.')) {
    return null
  }

  return await promptText(`输入 ${MainlandChangeConfirmPhrase}`, 'CN-MAINLAND 词库确认', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPlaceholder: MainlandChangeConfirmPhrase,
    inputValidator: (value: string) => value.trim() === MainlandChangeConfirmPhrase || '确认短语不匹配'
  })
}

const setDictionaryEnabled = async (item: ModerationDictionaryRuntimeItem, enabled: boolean): Promise<void> => {
  runtimeActionId.value = item.dictionaryId
  taskFeedback.begin(enabled ? '正在启用词库' : '正在禁用词库', item.dictionaryId, item.dictionaryId)
  try {
    const confirmPhrase = await resolveDictionaryConfirmPhrase(item, enabled)
    if (!enabled && item.dictionaryId.startsWith('cn-mainland.') && confirmPhrase !== MainlandChangeConfirmPhrase) {
      taskFeedback.partial('词库变更已取消', '确认短语不匹配', item.dictionaryId)
      return
    }

    const mfaProofToken = await ensureAdminSensitiveProof()
    runtime.value = enabled
      ? await enableModerationDictionary(item.dictionaryId, { reason: 'dictionary_runtime_enable' }, { mfaProofToken })
      : await disableModerationDictionary(item.dictionaryId, { reason: 'dictionary_runtime_disable', confirmPhrase }, { mfaProofToken })
    taskFeedback.succeed(enabled ? '词库已启用' : '词库已禁用', item.dictionaryId, item.dictionaryId)
    toast.success(`${item.dictionaryId} ${enabled ? '已启用' : '已禁用'}`)
  } catch (error) {
    taskFeedback.fail(enabled ? '词库启用失败' : '词库禁用失败', error, enabled ? '词库启用失败' : '词库禁用失败', item.dictionaryId)
    showErrorToast(error, enabled ? '词库启用失败' : '词库禁用失败')
  } finally {
    runtimeActionId.value = null
  }
}

const openDetail = (item: ModerationDictionaryRuntimeItem): void => {
  detail.value = item
  detailVisible.value = true
}

const copyChecksum = async (item: ModerationDictionaryRuntimeItem): Promise<void> => {
  await navigator.clipboard?.writeText(item.checksum)
  toast.success('校验值已复制')
}

const rowClassName = ({ row }: { row: ModerationDictionaryRuntimeItem }): string =>
  isTaskHighlighted(row.dictionaryId) ? 'blog-motion-task-region blog-motion-task-region--settled' : 'blog-motion-task-region'

function formatTime(value: string): string {
  return value ? new Date(value).toLocaleString() : '-'
}

onMounted(() => {
  void loadSnapshot()
})
</script>
