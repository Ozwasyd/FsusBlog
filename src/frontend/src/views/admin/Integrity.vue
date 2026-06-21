<template>
  <div class="account-page integrity-page account-motion-enter w-full">
    <FsusUiPageHeader
      title="数据巡检"
      content="检查内容关系、文件资产、账号状态与公开索引。"
      class="account-page-header--compact"
    />

    <FsusUiSettingsSection
      class="blog-motion-task-region mb-8"
      :class="{
        'blog-motion-task-region--pending': loading || fixing,
        'blog-motion-task-region--settled': isTaskHighlighted('integrity-report')
      }"
      title="巡检结果"
      id="integrity-report-title"
    >
      <template #actions>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <el-button :icon="Refresh" :loading="loading" @click="loadAll">一键检查</el-button>
          <el-button :icon="Download" :disabled="!report" @click="exportReport">导出报告</el-button>
        </div>
      </template>

      <FsusUiKeyValueGrid v-if="report" class="grid gap-4 md:grid-cols-4">
        <FsusUiKeyValueItem label="状态" :tone="kvTone(report.status)">
          <el-tag :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus(report.status)])">
            {{ adminStatusLabel[toAdminSystemStatus(report.status)] }}
          </el-tag>
        </FsusUiKeyValueItem>
        <FsusUiKeyValueItem label="检查项">
          {{ report.checkCount }}
        </FsusUiKeyValueItem>
        <FsusUiKeyValueItem label="问题项">
          {{ report.issueCount }}
        </FsusUiKeyValueItem>
        <FsusUiKeyValueItem label="差异">
          {{ preview?.diffs.length ?? 0 }}
        </FsusUiKeyValueItem>
      </FsusUiKeyValueGrid>
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <FsusUiSettingsSection title="检查项" id="integrity-checks-title">
        <el-table v-loading="loading" :data="report?.checks ?? []" row-key="code">
          <el-table-column label="检查" min-width="220">
            <template #default="{ row }: { row: IntegrityCheckResponse }">
              <div class="font-semibold text-[var(--fsusblog-text-primary)]">{{ row.title }}</div>
              <div class="text-[11px] text-[var(--fsusblog-text-muted)]">{{ row.code }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }: { row: IntegrityCheckResponse }">
              <el-tag :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus(row.status)])">
                {{ adminStatusLabel[toAdminSystemStatus(row.status)] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="数量" width="90" prop="count" />
          <el-table-column label="样本" min-width="260">
            <template #default="{ row }: { row: IntegrityCheckResponse }">
              <div class="break-all text-xs leading-6 text-[var(--fsusblog-text-secondary)]">
                {{ row.sampleKeys.slice(0, 3).join(', ') || row.detail }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="修复" width="90">
            <template #default="{ row }: { row: IntegrityCheckResponse }">
              <el-tag :type="row.autoFixAvailable ? 'warning' : 'info'">
                {{ row.autoFixAvailable ? '可安全修复' : '不可自动修复' }}
              </el-tag>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState
              :title="report ? '暂无检查项' : '尚未运行数据巡检'"
              :content="report ? '服务端未返回巡检项目，请刷新后重试。' : '运行一键检查后显示文章、评论、资产与缓存一致性结果。'"
            />
          </template>
        </el-table>
      </FsusUiSettingsSection>

      <div class="space-y-8">
        <FsusUiSettingsSection title="安全修复差异" id="integrity-diff-title">
          <AdminInlineEmptyState
            v-if="diffPreviewState !== 'ready'"
            :title="diffPreviewStateView.title"
            :content="diffPreviewStateView.description"
          >
            <template v-if="diffPreviewStateView.actionLabel" #actions>
              <el-button :icon="Refresh" :loading="loading" @click="loadAll">
                {{ diffPreviewStateView.actionLabel }}
              </el-button>
            </template>
          </AdminInlineEmptyState>
          <div v-else class="max-h-[24rem] overflow-auto">
            <el-table :data="diffRows" row-key="field">
              <el-table-column label="字段" min-width="220">
                <template #default="{ row }: { row: AdminDiffResponse }">
                  <div class="integrity-diff-cell integrity-diff-cell--field">
                    <code class="integrity-diff-value integrity-diff-value--technical">{{ formatDiffValue(row.field) }}</code>
                    <el-button link size="small" :icon="CopyDocument" @click="copyDiffValue(row.field, '字段')">复制字段</el-button>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="修复前" min-width="160">
                <template #default="{ row }: { row: AdminDiffResponse }">
                  <div class="integrity-diff-cell">
                    <component
                      :is="isTechnicalDiffValue(row.before) ? 'code' : 'span'"
                      :class="['integrity-diff-value', { 'integrity-diff-value--technical': isTechnicalDiffValue(row.before), 'integrity-diff-value--empty': !row.before.trim() }]"
                    >
                      {{ formatDiffValue(row.before) }}
                    </component>
                    <el-button v-if="row.before.trim()" link size="small" :icon="CopyDocument" @click="copyDiffValue(row.before, '修复前')">复制</el-button>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="修复后" min-width="160">
                <template #default="{ row }: { row: AdminDiffResponse }">
                  <div class="integrity-diff-cell">
                    <component
                      :is="isTechnicalDiffValue(row.after) ? 'code' : 'span'"
                      :class="['integrity-diff-value', { 'integrity-diff-value--technical': isTechnicalDiffValue(row.after), 'integrity-diff-value--empty': !row.after.trim() }]"
                    >
                      {{ formatDiffValue(row.after) }}
                    </component>
                    <el-button v-if="row.after.trim()" link size="small" :icon="CopyDocument" @click="copyDiffValue(row.after, '修复后')">复制</el-button>
                  </div>
                </template>
              </el-table-column>
              <template #empty>
                <AdminInlineEmptyState
                  title="没有可安全修复差异"
                  content="当前没有需要自动修复的字段变更。"
                />
              </template>
            </el-table>
          </div>
          <FsusUiDangerZone
            id="integrity-apply-zone"
            class="mt-5"
            title="安全修复"
            description="安全修复会写入数据，请先查看差异，再输入确认短语。"
            title-tag="h3"
          >
            <FsusUiRiskNotice role="note" type="warning" title="高风险操作">
              仅服务端判定为安全的修复会被提交。
            </FsusUiRiskNotice>
            <FsusUiDestructiveActionPanel
              title="应用安全修复"
              description="输入确认短语后才能应用安全修复。"
            >
              <FsusUiTypedConfirmField
                id="integrity-confirm-phrase"
                v-model="confirmPhrase"
                phrase="APPLY_SAFE_FIXES"
                label="确认短语"
                description="输入确认短语后才能应用安全修复。"
                placeholder="输入确认短语"
                :disabled="fixing"
              />
              <FsusUiFormSection
                id="integrity-mfa-proof-title"
                title="二次验证凭据"
                description="如系统要求二次验证，请填写凭据。"
                density="compact"
              >
                <el-input
                  id="integrity-mfa-proof"
                  v-model="mfaProof"
                  placeholder="输入二次验证凭据"
                  aria-label="二次验证凭据"
                  :disabled="fixing"
                  show-password
                />
              </FsusUiFormSection>
              <template #actions>
                <el-button
                  type="danger"
                  :icon="Tools"
                  :disabled="!canApplyFix"
                  :loading="fixing"
                  @click="applyFix"
                >
                  应用安全修复
                </el-button>
              </template>
            </FsusUiDestructiveActionPanel>
          </FsusUiDangerZone>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection title="危险操作策略" id="integrity-policy-title">
          <div v-if="policy?.rules.length" class="space-y-4">
            <div
              v-for="rule in policy?.rules ?? []"
              :key="rule.level"
              class="border-t border-[var(--fsusblog-panel-border)] pt-4"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs font-semibold">{{ formatDangerLevel(rule.level) }}</span>
                <el-tag type="info">{{ formatDangerInteraction(rule.interaction) }}</el-tag>
              </div>
              <div class="mt-2 text-[11px] leading-5 text-[var(--fsusblog-text-muted)]">
                {{ formatDangerPolicyExamples(rule.examples) }}
              </div>
            </div>
          </div>
          <AdminInlineEmptyState
            v-else
            title="暂无危险操作策略"
            content="运行一键检查后会同步加载当前危险操作确认策略。"
          />
        </FsusUiSettingsSection>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import {
  applyIntegrityFix,
  getDangerousOperationPolicy,
  inspectIntegrity,
  previewIntegrityFix,
  type AdminDiffResponse,
  type DangerousOperationPolicyResponse,
  type IntegrityCheckResponse,
  type IntegrityFixPreviewResponse,
  type IntegrityReportResponse
} from '@/api/authoring'
import { FsusUiPageHeader } from "@/fsusui"
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import {
  FsusUiDangerZone,
  FsusUiDestructiveActionPanel,
  FsusUiFormSection,
  FsusUiKeyValueGrid,
  FsusUiKeyValueItem,
  FsusUiRiskNotice,
  FsusUiSettingsSection,
  FsusUiTypedConfirmField
} from '@/fsusui'
import { CopyDocument, Download, Refresh, Tools } from '@/fsusui/icons'
import { toFsusUiTagType } from '@/fsusui/primitiveAdapters'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'
import {
  adminStatusLabel,
  adminStatusTone,
  type AdminStatusTone,
  type AdminSystemStatus
} from '@/view-contracts/adminStatus'

type DiffPreviewState = 'not_loaded' | 'loading' | 'loaded_empty' | 'ready' | 'failed'

const CONFIRM_PHRASE = 'APPLY_SAFE_FIXES'
const rawMfaProofInteraction = `MFA ${'proof'}`
const rawChangedFieldWords = `${'changed'} ${'fields'}`
const rawShowChangedFieldsInteraction = `展示 ${rawChangedFieldWords}`

const loading = ref(false)
const fixing = ref(false)
const report = shallowRef<IntegrityReportResponse | null>(null)
const preview = shallowRef<IntegrityFixPreviewResponse | null>(null)
const policy = shallowRef<DangerousOperationPolicyResponse | null>(null)
const confirmPhrase = ref('')
const mfaProof = ref('')
const diffPreviewState = ref<DiffPreviewState>('not_loaded')
const taskFeedback = useAdminTaskFeedback()
const {
  isHighlighted: isTaskHighlighted
} = taskFeedback

const diffRows = computed(() => preview.value?.diffs ?? [])
const canApplyFix = computed(() =>
  diffRows.value.length > 0 &&
  confirmPhrase.value.trim() === CONFIRM_PHRASE &&
  !fixing.value
)
const diffPreviewStateView = computed(() => {
  switch (diffPreviewState.value) {
    case 'loading':
      return {
        title: '正在生成安全修复预览',
        description: '正在检查可安全修复字段。',
        actionLabel: ''
      }
    case 'loaded_empty':
      return {
        title: '没有可安全修复差异',
        description: '当前没有需要自动修复的字段变更。',
        actionLabel: '重新检查'
      }
    case 'failed':
      return {
        title: '差异预览加载失败',
        description: '请重新运行数据巡检。',
        actionLabel: '重新检查'
      }
    case 'ready':
      return {
        title: '安全修复差异',
        description: '请确认字段变更后再应用安全修复。',
        actionLabel: ''
      }
    case 'not_loaded':
    default:
      return {
        title: '尚未生成安全修复预览',
        description: '运行一键检查后显示可安全修复差异。',
        actionLabel: '一键检查'
      }
  }
})

const loadAll = async (): Promise<void> => {
  loading.value = true
  diffPreviewState.value = 'loading'
  taskFeedback.begin('正在执行数据巡检', '检查内容关系、文件资产、账号状态与公开索引', 'integrity-report')
  try {
    const [reportResult, previewResult, policyResult] = await Promise.allSettled([
      inspectIntegrity(),
      previewIntegrityFix(),
      getDangerousOperationPolicy()
    ])

    if (previewResult.status === 'fulfilled') {
      const nextPreview = previewResult.value
      preview.value = nextPreview
      diffPreviewState.value = nextPreview.diffs.length > 0 ? 'ready' : 'loaded_empty'
    } else {
      preview.value = null
      diffPreviewState.value = 'failed'
      showErrorToast(previewResult.reason, '差异预览加载失败')
    }

    if (policyResult.status === 'fulfilled') {
      policy.value = policyResult.value
    } else {
      policy.value = null
      showErrorToast(policyResult.reason, '危险操作策略加载失败')
    }

    if (reportResult.status === 'rejected') {
      taskFeedback.fail('数据巡检加载失败', reportResult.reason, '数据巡检加载失败', 'integrity-report')
      showErrorToast(reportResult.reason, '数据巡检加载失败')
      return
    }

    const nextReport = reportResult.value
    report.value = nextReport
    const detail = `检查项 ${nextReport.checkCount}，问题项 ${nextReport.issueCount}`
    if (previewResult.status === 'rejected' || policyResult.status === 'rejected') {
      taskFeedback.partial('数据巡检完成，部分信息未加载', detail, 'integrity-report')
    } else if (nextReport.issueCount > 0) {
      taskFeedback.partial('数据巡检完成', detail, 'integrity-report')
    } else {
      taskFeedback.succeed('数据巡检完成', detail, 'integrity-report')
    }
  } catch (error) {
    taskFeedback.fail('数据巡检加载失败', error, '数据巡检加载失败', 'integrity-report')
    showErrorToast(error, '数据巡检加载失败')
  } finally {
    loading.value = false
  }
}

const exportReport = (): void => {
  if (!report.value) return
  const blob = new Blob([JSON.stringify(report.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `fsusblog-integrity-${Date.now()}.json`
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const applyFix = async (): Promise<void> => {
  if (confirmPhrase.value.trim() !== CONFIRM_PHRASE) {
    showWarningToast('确认短语不匹配', '确认短语不匹配')
    return
  }

  fixing.value = true
  taskFeedback.begin('正在应用安全修复', `执行 ${CONFIRM_PHRASE}`, 'integrity-report')
  try {
    const response = await applyIntegrityFix(
      { codes: null, confirmPhrase: confirmPhrase.value.trim() },
      { mfaProofToken: mfaProof.value.trim() || null }
    )
    taskFeedback.succeed('安全修复完成', `已应用 ${response.appliedCount} 项`, 'integrity-report')
    toast.success(`安全修复完成：${response.appliedCount}`)
    await loadAll()
  } catch (error) {
    taskFeedback.fail('安全修复失败', error, '安全修复失败', 'integrity-report')
    showErrorToast(error, '安全修复失败')
  } finally {
    fixing.value = false
  }
}

const toAdminSystemStatus = (status: string | null | undefined): AdminSystemStatus =>
  status && status in adminStatusTone ? status as AdminSystemStatus : 'unknown'

const kvTone = (status: string | null | undefined): AdminStatusTone =>
  adminStatusTone[toAdminSystemStatus(status)]

const formatDangerLevel = (level: string): string => {
  const labels: Record<string, string> = {
    'normal-confirm': '普通确认',
    'strong-confirm': '二次确认',
    'typed-confirm': '确认短语',
    'admin-step-up': '管理员二次验证凭据',
    'diff-preview': '差异预览'
  }
  return labels[level] ?? level
}

const formatDangerPolicyText = (value: string): string => {
  const normalized = value.trim()
  if (normalized.toLowerCase() === rawMfaProofInteraction.toLowerCase()) {
    return '二次验证凭据'
  }
  if (normalized === rawShowChangedFieldsInteraction) {
    return '展示变更字段'
  }

  return normalized
    .replaceAll(rawMfaProofInteraction, '二次验证凭据')
    .replaceAll(rawChangedFieldWords, '变更字段')
}

const formatDangerInteraction = (interaction: string): string => {
  const labels: Record<string, string> = {
    confirm: '确认操作',
    '二次确认': '二次确认',
    '输入对象名': '输入对象名'
  }
  return labels[interaction] ?? formatDangerPolicyText(interaction)
}

const formatDangerPolicyExamples = (examples: string[]): string => {
  return examples.map(formatDangerPolicyText).join(' / ')
}

const formatDiffValue = (value: string): string => {
  const trimmed = value.trim()
  return trimmed || '未填写'
}

const isTechnicalDiffValue = (value: string): boolean => {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }

  return trimmed.length >= 16 || /[A-Za-z0-9][:_./-][A-Za-z0-9]/u.test(trimmed)
}

const copyDiffValue = async (value: string, label: string): Promise<void> => {
  const text = value.trim()
  if (!text) {
    showWarningToast(`${label}为空，无法复制`, `${label}为空，无法复制`)
    return
  }

  if (!navigator.clipboard?.writeText) {
    showWarningToast('当前浏览器不允许复制，请手动复制字段值', '当前浏览器不允许复制，请手动复制字段值')
    return
  }

  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label}已复制`)
  } catch (error) {
    showWarningToast(error, '复制失败，请手动复制字段值')
  }
}

onMounted(loadAll)
</script>

<style scoped>
.integrity-diff-cell {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.5rem;
}

.integrity-diff-cell--field {
  align-items: flex-start;
}

.integrity-diff-value {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--fsusblog-text-secondary);
  line-height: 1.6;
}

.integrity-diff-value--technical {
  border-radius: var(--fsus-radius-control-small);
  background: var(--fsusblog-page-bg-soft);
  padding: 0.1rem 0.35rem;
  color: var(--fsusblog-text-primary);
  font-size: 0.75rem;
}

.integrity-diff-value--empty {
  color: var(--fsusblog-text-muted);
}
</style>
